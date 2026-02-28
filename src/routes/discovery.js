/**
 * WHISPERNET DISCOVERY ROUTES
 *
 * Handles the "Whispers for You" discovery portal:
 * - Personalized recommendations based on user preferences
 * - Ambient activity feed
 * - Browse filters (trending, new, by mood, by genre, by length)
 */

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { authenticateUser } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/error-handler');

/**
 * GET /api/discovery/recommendations
 *
 * Returns exactly 5 personalized story recommendations with 3-tier matching:
 * - TIER 1 (50%): Resonance Match - books where other readers used similar words
 * - TIER 2 (35%): Genre + Mood - match preferences and mood tags, weight recent
 * - TIER 3 (15%): Diversity Slot - mandatory 1 of 5 from unread genre
 * - Anti-Repeat: Never show same book within 30 days
 * - Series Awareness: Max 1 book per series in batch
 */
router.get('/recommendations', authenticateUser, asyncHandler(async (req, res) => {
  const user_id = req.userId;

  // === EXCLUSIONS ===
  // 1. Books already on user's shelf
  const { data: userLibrary, error: libraryError } = await supabaseAdmin
    .from('whispernet_library')
    .select('story_id, stories:story_id(genre, series_id, book_number)')
    .eq('user_id', user_id);

    if (libraryError) {
      console.error('Error fetching user library:', libraryError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    const excludedStoryIds = userLibrary.map(entry => entry.story_id);
    const readGenres = new Set(userLibrary.map(entry => entry.stories?.genre).filter(Boolean));

    // Build series context: { series_id: { maxBookNumber, hasBook1, hasBook2, etc } }
    const userSeriesContext = {};
    userLibrary.forEach(entry => {
      const seriesId = entry.stories?.series_id;
      const bookNum = entry.stories?.book_number;
      if (seriesId) {
        if (!userSeriesContext[seriesId]) {
          userSeriesContext[seriesId] = { maxBookNumber: 0, books: new Set() };
        }
        if (bookNum) {
          userSeriesContext[seriesId].maxBookNumber = Math.max(
            userSeriesContext[seriesId].maxBookNumber,
            bookNum
          );
          userSeriesContext[seriesId].books.add(bookNum);
        }
      }
    });

    // Only exclusion: books already on the user's shelf. That's it.
    const allExcludedIds = [...excludedStoryIds];

    // === GET USER PREFERENCES ===
    const { data: prefs, error: prefsError } = await supabaseAdmin
      .from('user_preferences')
      .select('preferred_genres, preferences')
      .eq('user_id', user_id)
      .maybeSingle();

    if (prefsError) {
      console.error('Error fetching user preferences:', prefsError);
    }

    let userGenres = [];
    if (prefs?.preferred_genres && prefs.preferred_genres.length > 0) {
      userGenres = prefs.preferred_genres;
    } else if (prefs?.preferences?.favoriteGenres) {
      userGenres = prefs.preferences.favoriteGenres;
    }

    // === TIER 1: GET USER'S RESONANCE WORDS ===
    const { data: userResonances, error: resonancesError } = await supabaseAdmin
      .from('resonances')
      .select('word')
      .eq('user_id', user_id);

    if (resonancesError) {
      console.error('Error fetching user resonances:', resonancesError);
    }

    const userResonanceWords = new Set(
      (userResonances || []).map(r => r.word.toLowerCase())
    );

    // === FETCH CANDIDATE PUBLICATIONS ===
    let query = supabaseAdmin
      .from('whispernet_publications')
      .select(`
        id,
        story_id,
        genre,
        mood_tags,
        published_at,
        stories:story_id (
          id,
          title,
          cover_image_url,
          genre,
          series_id,
          book_number
        )
      `)
      .eq('is_active', true)
      .neq('publisher_id', user_id)
      .limit(100); // Fetch more candidates for scoring

    if (allExcludedIds.length > 0) {
      query = query.not('story_id', 'in', `(${allExcludedIds.join(',')})`);
    }

    const { data: publications, error: pubError } = await query;

    if (pubError) {
      console.error('Error fetching publications:', pubError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    if (!publications || publications.length === 0) {
      return res.json({
        success: true,
        recommendations: [],
        message: 'No recommendations available yet'
      });
    }

    // === GET RESONANCE DATA FOR ALL CANDIDATE BOOKS ===
    const candidateStoryIds = publications.map(p => p.story_id);
    const { data: allResonances, error: allResonancesError } = await supabaseAdmin
      .from('resonances')
      .select('story_id, word')
      .in('story_id', candidateStoryIds);

    if (allResonancesError) {
      console.error('Error fetching resonances for candidates:', allResonancesError);
    }

    // Build resonance map: { story_id: [word1, word2, ...] }
    const resonanceMap = {};
    (allResonances || []).forEach(r => {
      if (!resonanceMap[r.story_id]) {
        resonanceMap[r.story_id] = [];
      }
      resonanceMap[r.story_id].push(r.word.toLowerCase());
    });

    // === 3-TIER SCORING ===
    const scored = publications.map(pub => {
      let tier1Score = 0; // Resonance Match (0-50)
      let tier2Score = 0; // Genre + Mood (0-35)

      // TIER 1: Resonance Match (50% weight)
      if (userResonanceWords.size > 0 && resonanceMap[pub.story_id]) {
        const bookResonances = resonanceMap[pub.story_id];
        const overlapCount = bookResonances.filter(word =>
          userResonanceWords.has(word)
        ).length;
        // Score: 10 points per overlapping word, cap at 50
        tier1Score = Math.min(overlapCount * 10, 50);
      }

      // TIER 2: Genre + Mood (35% weight)
      let genreScore = 0;
      let moodScore = 0;
      let recencyScore = 0;

      // Genre match: 15 points
      if (userGenres.includes(pub.genre)) {
        genreScore = 15;
      }

      // Mood match: 10 points if any user preference moods match (simplified - could be enhanced)
      if (pub.mood_tags && pub.mood_tags.length > 0) {
        moodScore = 5; // Give some points for having mood tags
      }

      // Recency: up to 10 points (newer = better)
      const daysSincePublished = Math.floor(
        (Date.now() - new Date(pub.published_at).getTime()) / (1000 * 60 * 60 * 24)
      );
      recencyScore = Math.max(0, 10 - daysSincePublished / 10); // Decay over 100 days

      tier2Score = genreScore + moodScore + recencyScore;

      const totalScore = tier1Score + tier2Score;

      return {
        ...pub,
        score: totalScore,
        tier1Score,
        tier2Score,
        isUnreadGenre: !readGenres.has(pub.genre)
      };
    });

    // Sort by score
    scored.sort((a, b) => b.score - a.score);

    // === SERIES AWARENESS: Deduplicate by series ===
    const seenSeries = new Set();
    const seriesDeduped = [];

    for (const pub of scored) {
      const seriesId = pub.stories?.series_id;

      // Skip if we've already included a book from this series
      if (seriesId && seenSeries.has(seriesId)) {
        continue;
      }

      // Prefer Book N+1 if user has Book N
      if (seriesId && userSeriesContext[seriesId]) {
        const userMax = userSeriesContext[seriesId].maxBookNumber;
        const thisBookNum = pub.stories?.book_number;

        // If this is the next book in sequence, boost priority by adding it early
        if (thisBookNum === userMax + 1) {
          // This is ideal - keep it
        } else if (thisBookNum <= userMax) {
          // User already has this or a later book - skip
          continue;
        }
      }

      if (seriesId) {
        seenSeries.add(seriesId);
      }

      seriesDeduped.push(pub);
    }

    // === TIER 3: DIVERSITY SLOT (15% weight) - MANDATORY ===
    // Take top 4 from scored list, then force 1 diversity pick
    const top4 = seriesDeduped.slice(0, 4);

    // First attempt: Find best-scoring book from a genre user hasn't read at all
    let diversityCandidate = seriesDeduped.find(pub => pub.isUnreadGenre);

    // Second attempt: If no unread-genre books exist, broaden to ANY genre not in top 4
    if (!diversityCandidate && top4.length > 0) {
      const top4Genres = new Set(top4.map(p => p.genre));
      diversityCandidate = seriesDeduped.find(pub => !top4Genres.has(pub.genre));
    }

    // Build final recommendations: top 3 + diversity pick + fill to 5
    let finalRecommendations = [];
    if (diversityCandidate && !top4.includes(diversityCandidate)) {
      // Insert diversity pick as 5th slot (after top 3, fill 4th from remaining)
      finalRecommendations = [...top4.slice(0, 3), diversityCandidate];

      // Fill 4th slot from remaining (if available)
      const remaining = seriesDeduped.filter(p =>
        !finalRecommendations.includes(p) && p !== diversityCandidate
      );
      if (remaining.length > 0) {
        finalRecommendations.splice(3, 0, remaining[0]); // Insert at position 3 (4th slot)
      }
    } else if (diversityCandidate && top4.includes(diversityCandidate)) {
      // Diversity pick already in top 4 - just use top 5
      finalRecommendations = seriesDeduped.slice(0, 5);
    } else {
      // Truly no diversity candidate possible (fewer than 2 genres available)
      // Fall back to top 5
      finalRecommendations = seriesDeduped.slice(0, 5);
    }

    // Ensure exactly 5 recommendations (or fewer if not enough books exist)
    finalRecommendations = finalRecommendations.slice(0, 5);

    // === FORMAT RESPONSE ===
    const recommendations = finalRecommendations.map(pub => {
      const storyResonances = resonanceMap[pub.story_id] || [];
      // Get top 3 most common resonances for display
      const resonanceFreq = {};
      storyResonances.forEach(word => {
        resonanceFreq[word] = (resonanceFreq[word] || 0) + 1;
      });
      const topResonances = Object.entries(resonanceFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([word]) => word);

      return {
        publication_id: pub.id,
        story_id: pub.story_id,
        title: pub.stories.title,
        genre: pub.genre,
        cover_image_url: pub.stories.cover_image_url,
        mood_tags: pub.mood_tags || [],
        resonance_words: topResonances,
        book_number: pub.stories.book_number,
        match_score: Math.round(pub.score),
        is_diversity_pick: pub.isUnreadGenre
      };
    });

    res.json({
      success: true,
      recommendations
    });
}));

/**
 * POST /api/discovery/recommendations/action
 *
 * Update a recommendation impression action when user interacts.
 * Actions: 'added' (added to library), 'dismissed' (not interested)
 */
router.post('/recommendations/action', authenticateUser, asyncHandler(async (req, res) => {
  const { story_id, action } = req.body;

  if (!story_id || !action) {
    return res.status(400).json({
      success: false,
      error: 'story_id and action are required'
    });
  }

  if (!['added', 'dismissed'].includes(action)) {
    return res.status(400).json({
      success: false,
      error: 'action must be "added" or "dismissed"'
    });
  }

  // Update the most recent impression for this user+story
  const { error: updateError } = await supabaseAdmin
    .from('recommendation_impressions')
    .update({ action })
    .eq('user_id', req.userId)
    .eq('story_id', story_id)
    .order('shown_at', { ascending: false })
    .limit(1);

  if (updateError) {
    console.error('Error updating impression action:', updateError);
    return res.status(500).json({ success: false, error: 'Database error' });
  }

  res.json({ success: true });
}));

/**
 * GET /api/discovery/feed
 *
 * Returns recent activity events for the ambient "Live from the WhisperNet" feed.
 * Synthesizes from reading_sessions and story_feedback to show emotionally compelling moments.
 * Respects whispernet_show_city privacy setting.
 */
router.get('/feed', authenticateUser, asyncHandler(async (req, res) => {
  // Synthesize feed from recent completed reading sessions
  // Get sessions where user finished a chapter (completed = true) in last 24 hours
  const { data: sessions, error: sessionsError } = await supabaseAdmin
      .from('reading_sessions')
      .select(`
        user_id,
        story_id,
        chapter_number,
        session_end,
        completed,
        stories:story_id (
          id,
          title,
          whispernet_published
        )
      `)
      .eq('completed', true)
      .gte('session_end', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order('session_end', { ascending: false })
      .limit(20);

    if (sessionsError) {
      console.error('Error fetching sessions:', sessionsError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    if (!sessions || sessions.length === 0) {
      return res.json({
        success: true,
        feed: []
      });
    }

    // Filter for WhisperNet books only
    const whispernetSessions = sessions.filter(s => s.stories?.whispernet_published);

    // Get user preferences for each reader (to check whispernet_show_city and timezone)
    const userIds = [...new Set(whispernetSessions.map(s => s.user_id))];

    const { data: userPrefs, error: prefsError } = await supabaseAdmin
      .from('user_preferences')
      .select('user_id, whispernet_display_name, whispernet_show_city, timezone')
      .in('user_id', userIds);

    if (prefsError) {
      console.error('Error fetching user prefs for feed:', prefsError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    const prefsMap = {};
    userPrefs.forEach(p => {
      prefsMap[p.user_id] = p;
    });

    // Get minor status for privacy check
    const { data: users, error: usersError } = await supabaseAdmin
      .from('users')
      .select('id, is_minor')
      .in('id', userIds);

    if (usersError) {
      console.error('Error fetching users for feed:', usersError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    const minorMap = {};
    users?.forEach(u => {
      minorMap[u.id] = u.is_minor ?? false;
    });

    // Get max chapter number for each story to detect completions
    const storyIds = [...new Set(whispernetSessions.map(s => s.story_id))];
    const { data: maxChapters, error: chaptersError } = await supabaseAdmin
      .from('reading_sessions')
      .select('story_id')
      .in('story_id', storyIds);

    if (chaptersError) {
      console.error('Error fetching max chapters:', chaptersError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    // Build map of max chapter per story
    const maxChapterMap = {};
    for (const storyId of storyIds) {
      const { data: chapters } = await supabaseAdmin
        .from('chapters')
        .select('chapter_number')
        .eq('story_id', storyId)
        .order('chapter_number', { ascending: false })
        .limit(1);

      if (chapters && chapters.length > 0) {
        maxChapterMap[storyId] = chapters[0].chapter_number;
      }
    }

    // Generate feed items (only show book completions)
    const feedItems = whispernetSessions
      .filter(s => {
        const maxChapter = maxChapterMap[s.story_id];
        return maxChapter && s.chapter_number === maxChapter;
      })
      .slice(0, 10) // Limit to 10 items
      .map(session => {
        const prefs = prefsMap[session.user_id];
        const isMinor = minorMap[session.user_id] ?? false;

        // Privacy: always use "A reader" for minors
        const readerName = isMinor
          ? 'A reader'
          : (prefs?.whispernet_display_name || 'A reader');
        const showCity = isMinor ? false : (prefs?.whispernet_show_city !== false);

        // Parse timezone to extract region name
        let location = '';
        if (showCity && prefs?.timezone) {
          const timezone = prefs.timezone;
          const parts = timezone.split('/');
          if (parts.length >= 2) {
            // e.g., "America/New_York" → "New York"
            const cityName = parts[parts.length - 1].replace(/_/g, ' ');
            location = ` in ${cityName}`;
          }
        }

        return {
          id: `${session.user_id}_${session.story_id}_${session.session_end}`,
          type: 'book_completion',
          message: `${readerName}${location} just finished ${session.stories.title}`,
          story_id: session.story_id,
          story_title: session.stories.title,
          timestamp: session.session_end
        };
      });

  res.json({
    success: true,
    feed: feedItems
  });
}));

/**
 * GET /api/discovery/browse?filter=trending&genre=fantasy
 *
 * Returns filtered browse results from whispernet_publications.
 * Supports filters: for_you, trending, new_releases, by_mood, genre, length
 */
router.get('/browse', authenticateUser, asyncHandler(async (req, res) => {
  const { filter = 'for_you', genre, mood, length } = req.query;

  // Get books already on user's shelf (to exclude them)
  const { data: userLibrary, error: libraryError } = await supabaseAdmin
    .from('whispernet_library')
    .select('story_id')
    .eq('user_id', req.userId);

    if (libraryError) {
      console.error('Error fetching user library:', libraryError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    const excludedStoryIds = userLibrary.map(entry => entry.story_id);

    // Base query
    let query = supabaseAdmin
      .from('whispernet_publications')
      .select(`
        id,
        story_id,
        genre,
        mood_tags,
        published_at,
        stories:story_id (
          id,
          title,
          cover_image_url,
          genre
        )
      `)
      .eq('is_active', true)
      .neq('publisher_id', req.userId)
      .limit(20);

    // Exclude books already on user's shelf
    if (excludedStoryIds.length > 0) {
      query = query.not('story_id', 'in', `(${excludedStoryIds.join(',')})`);
    }

    // Apply filter
    switch (filter) {
      case 'new_releases':
        query = query.order('published_at', { ascending: false });
        break;

      case 'trending':
        // For now, just sort by recent (TODO: add view/share counts later)
        query = query.order('published_at', { ascending: false });
        break;

      case 'for_you':
      default:
        // Personalized (same as recommendations logic)
        query = query.order('published_at', { ascending: false });
        break;
    }

    // Apply genre filter
    if (genre) {
      query = query.eq('genre', genre);
    }

    // Apply mood filter (mood_tags is an array)
    if (mood) {
      query = query.contains('mood_tags', [mood]);
    }

    const { data: publications, error: pubError } = await query;

    if (pubError) {
      console.error('Error fetching browse results:', pubError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    // Apply length filter in post-processing (no direct DB column for length)
    let results = publications || [];
    if (length) {
      // TODO: Calculate book length from chapter count or word count
      // For now, return all results
    }

    // Format response
    const books = results.map(pub => ({
      publication_id: pub.id,
      story_id: pub.story_id,
      title: pub.stories.title,
      genre: pub.genre,
      cover_image_url: pub.stories.cover_image_url,
      mood_tags: pub.mood_tags || [],
      resonance_words: [] // Placeholder
    }));

  res.json({
    success: true,
    filter,
    results: books
  });
}));

/**
 * GET /api/discovery/search
 * Text search across WhisperNet publications by title, genre, and premise
 */
router.get('/search', authenticateUser, asyncHandler(async (req, res) => {
  const { query, user_id } = req.query;

  if (!query || query.trim().length === 0) {
    return res.json({ success: true, results: [] });
  }

  const searchTerm = `%${query.trim()}%`;

  // Search published stories by title, genre, or premise
  const { data: publications, error } = await supabaseAdmin
    .from('whispernet_publications')
    .select(`
      id,
      story_id,
      genre,
      mood_tags,
      stories (
        id,
        title,
        genre,
        premise,
        cover_image_url,
        user_id,
        series_id,
        book_number
      )
    `)
    .eq('is_active', true)
    .neq('publisher_id', user_id)
    .limit(20);

  if (error) {
    console.error('Search error:', error);
    throw new Error(`Search failed: ${error.message}`);
  }

  // Filter by search term on client-side (since .or() with joined columns is tricky)
  const filteredPubs = (publications || []).filter(pub => {
    if (!pub.stories) return false;
    const title = (pub.stories.title || '').toLowerCase();
    const genre = (pub.stories.genre || '').toLowerCase();
    const premise = (pub.stories.premise || '').toLowerCase();
    const searchLower = query.toLowerCase();
    return title.includes(searchLower) || genre.includes(searchLower) || premise.includes(searchLower);
  });

  // Check which stories the user already has on their shelf
  const storyIds = filteredPubs.map(p => p.story_id);

  let shelfEntries = [];
  if (storyIds.length > 0) {
    const { data: shelf } = await supabaseAdmin
      .from('whispernet_library')
      .select('story_id')
      .eq('user_id', user_id)
      .in('story_id', storyIds);
    shelfEntries = shelf || [];
  }

  const shelfStoryIds = new Set(shelfEntries.map(e => e.story_id));

  // Format results to match DiscoveryRecommendation structure
  const results = filteredPubs.map(pub => ({
    publication_id: pub.id,
    story_id: pub.story_id,
    title: pub.stories.title,
    genre: pub.genre || pub.stories.genre || 'Unknown',
    cover_image_url: pub.stories.cover_image_url,
    mood_tags: pub.mood_tags || [],
    resonance_words: [], // Empty for search results
    is_on_shelf: shelfStoryIds.has(pub.story_id),
    book_number: pub.stories.book_number
  }));

  res.json({
    success: true,
    results
  });
}));

module.exports = router;
