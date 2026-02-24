/**
 * WHISPERNET PUBLICATIONS ROUTES
 *
 * Handles publication of stories to WhisperNet discovery portal and content classification.
 */

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

/**
 * POST /api/publications
 * Publish a story to WhisperNet
 */
router.post('/', authenticateUser, asyncHandler(async (req, res) => {
  const { story_id, genre, mood_tags, maturity_rating } = req.body;
  const { userId } = req;

  // Validate required fields
  if (!story_id || !genre || !mood_tags || !maturity_rating) {
    return res.status(400).json({
      success: false,
      error: 'story_id, genre, mood_tags, and maturity_rating required'
    });
  }

  // Validate maturity_rating
  if (!['All Ages', 'Teen 13+', 'Mature 17+'].includes(maturity_rating)) {
    return res.status(400).json({
      success: false,
      error: 'maturity_rating must be "All Ages", "Teen 13+", or "Mature 17+"'
    });
  }

  // Map display values to database values
  const maturityMap = {
    'All Ages': 'all_ages',
    'Teen 13+': 'teen_13',
    'Mature 17+': 'mature_17'
  };
  const dbMaturityRating = maturityMap[maturity_rating];

  // Verify story ownership
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('id, user_id, title, whispernet_published')
    .eq('id', story_id)
    .single();

  if (storyError || !story) {
    console.error('Story not found:', storyError);
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  if (story.user_id !== userId) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden: not story owner'
    });
  }

  // Check if already published (CLAUDE.md Rule 3)
  if (story.whispernet_published) {
    return res.status(409).json({
      success: false,
      error: 'Story already published to WhisperNet'
    });
  }

  // Check if publication already exists
  const { data: existingPub, error: checkError } = await supabaseAdmin
    .from('whispernet_publications')
    .select('id')
    .eq('story_id', story_id)
    .maybeSingle();

  if (checkError) {
    console.error('Error checking for existing publication:', checkError);
    throw new Error(`Failed to check for existing publication: ${checkError.message}`);
  }

  if (existingPub) {
    return res.status(409).json({
      success: false,
      error: 'Publication already exists'
    });
  }

  // Create publication record
  const { data: publication, error: insertError } = await supabaseAdmin
    .from('whispernet_publications')
    .insert({
      story_id,
      publisher_id: userId,
      genre,
      mood_tags,
      maturity_rating: dbMaturityRating,
      is_active: true
    })
    .select()
    .single();

  if (insertError) {
    console.error('Error creating publication:', insertError);
    throw new Error(`Failed to create publication: ${insertError.message}`);
  }

  // Update story record
  const { error: updateError } = await supabaseAdmin
    .from('stories')
    .update({
      whispernet_published: true,
      maturity_rating: dbMaturityRating
    })
    .eq('id', story_id);

  if (updateError) {
    console.error('Error updating story:', updateError);
    // Publication exists but story update failed - log and continue
    // The publication record is the source of truth
  }

  res.json({
    success: true,
    publication_id: publication.id,
    published_at: publication.published_at
  });
}));

/**
 * GET /api/publications/activity?user_id=X
 * Get recent activity on user's published stories
 */
router.get('/activity', authenticateUser, asyncHandler(async (req, res) => {
  const { user_id } = req.query;
  const { userId } = req;

  // Verify user can only see their own activity
  if (user_id !== userId) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden'
    });
  }

  // Get user's published stories
  const { data: publications, error: pubError } = await supabaseAdmin
    .from('whispernet_publications')
    .select('story_id, stories:story_id (title)')
    .eq('stories.user_id', userId)
    .eq('is_active', true);

  if (pubError) {
    console.error('Error fetching publications:', pubError);
    throw new Error(`Failed to fetch publications: ${pubError.message}`);
  }

  if (!publications || publications.length === 0) {
    return res.json({
      success: true,
      activity: []
    });
  }

  const storyIds = publications.map(p => p.story_id);
  const storyTitles = {};
  publications.forEach(p => {
    if (p.stories) {
      storyTitles[p.story_id] = p.stories.title;
    }
  });

  // Get reading events from last 24 hours
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: sessions, error: sessionsError } = await supabaseAdmin
    .from('reading_sessions')
    .select(`
      id,
      story_id,
      user_id,
      started_at,
      chapter_number,
      user_preferences:user_id (
        whispernet_display_name,
        whispernet_show_city,
        city
      )
    `)
    .in('story_id', storyIds)
    .gte('started_at', oneDayAgo)
    .order('started_at', { ascending: false })
    .limit(20);

  if (sessionsError) {
    console.error('Error fetching reading sessions:', sessionsError);
    throw new Error(`Failed to fetch reading sessions: ${sessionsError.message}`);
  }

  // Transform sessions into activity items
  const activity = (sessions || []).map(session => {
    const displayName = session.user_preferences?.whispernet_display_name || 'A Fellow Reader';
    const showCity = session.user_preferences?.whispernet_show_city ?? false;
    const city = showCity ? session.user_preferences?.city : null;
    const storyTitle = storyTitles[session.story_id] || 'your story';

    let message;
    if (session.chapter_number === 1) {
      message = city
        ? `${displayName} in ${city} just started reading ${storyTitle}`
        : `${displayName} just started reading ${storyTitle}`;
    } else {
      message = city
        ? `${displayName} in ${city} is reading ${storyTitle}`
        : `${displayName} is reading ${storyTitle}`;
    }

    return {
      id: session.id,
      type: 'reading',
      message,
      story_id: session.story_id,
      story_title: storyTitle,
      timestamp: session.started_at
    };
  });

  res.json({
    success: true,
    activity
  });
}));

/**
 * POST /api/publications/:id/classify
 *
 * Content classification stub endpoint.
 * For now, accepts publisher self-classification.
 * Full classification pipeline (AI, reviewer, or hybrid) is owned by WhisperNet team.
 */
router.post('/:id/classify', authenticateUser, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { maturity_rating } = req.body;
  const { userId } = req;

  // Validate maturity_rating
  const validRatings = ['all_ages', 'teen_13', 'mature_17'];
  if (!maturity_rating || !validRatings.includes(maturity_rating)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid maturity_rating. Must be one of: all_ages, teen_13, mature_17'
    });
  }

  // Verify publication exists and belongs to user
  const { data: publication, error: pubError } = await supabaseAdmin
    .from('whispernet_publications')
    .select('publisher_id')
    .eq('id', id)
    .maybeSingle();

  if (pubError) {
    console.error('Error fetching publication:', pubError);
    throw new Error(`Failed to fetch publication: ${pubError.message}`);
  }

  if (!publication) {
    return res.status(404).json({ success: false, error: 'Publication not found' });
  }

  if (publication.publisher_id !== userId) {
    return res.status(403).json({ success: false, error: 'Forbidden: not the publisher' });
  }

  // Update maturity rating (stub - full classification pipeline is WhisperNet team scope)
  const { error: updateError } = await supabaseAdmin
    .from('whispernet_publications')
    .update({ maturity_rating })
    .eq('id', id);

  if (updateError) {
    console.error('Error updating maturity rating:', updateError);
    throw new Error(`Failed to update classification: ${updateError.message}`);
  }

  res.json({
    success: true,
    maturity_rating,
    message: 'Classification updated (self-classified by publisher)'
  });
}));

module.exports = router;
