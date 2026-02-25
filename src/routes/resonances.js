const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');
const { sentimentForWord } = require('../utils/sentiment');

const router = express.Router();

/**
 * POST /resonances
 * Create a Resonance word for a story
 */
router.post('/', authenticateUser, asyncHandler(async (req, res) => {
  const { story_id, word, sentiment } = req.body;
  const { userId } = req;

  if (!story_id || !word) {
    return res.status(400).json({
      success: false,
      error: 'story_id and word are required'
    });
  }

  // Validate word length (max 20 characters)
  if (word.length > 20) {
    return res.status(400).json({
      success: false,
      error: 'Resonance word must be 20 characters or less'
    });
  }

  // Auto-detect sentiment if not provided
  const detectedSentiment = sentiment || sentimentForWord(word);

  // Check if user already has a resonance for this story (UNIQUE constraint on story_id + user_id)
  const { data: existing, error: checkError } = await supabaseAdmin
    .from('resonances')
    .select('id')
    .eq('story_id', story_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (checkError) {
    console.error('Error checking for existing resonance:', checkError);
    throw new Error(`Failed to check for existing resonance: ${checkError.message}`);
  }

  if (existing) {
    return res.status(409).json({
      success: false,
      error: 'You have already left a Resonance for this story'
    });
  }

  // Create resonance record
  const { data: resonance, error: insertError } = await supabaseAdmin
    .from('resonances')
    .insert({
      story_id,
      user_id: userId,
      word: word.trim(),
      sentiment: detectedSentiment
    })
    .select()
    .single();

  if (insertError) {
    console.error('Error creating resonance:', insertError);
    throw new Error(`Failed to create resonance: ${insertError.message}`);
  }

  // Fetch the story to get the owner's user_id
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('user_id')
    .eq('id', story_id)
    .single();

  if (storyError) {
    console.error('Error fetching story:', storyError);
    throw new Error('Failed to fetch story');
  }

  // Fetch user's display name for the whisper_event metadata
  const { data: userPrefs, error: prefsError } = await supabaseAdmin
    .from('user_preferences')
    .select('whispernet_display_name')
    .eq('user_id', userId)
    .single();

  if (prefsError) {
    console.error('Error fetching user preferences:', prefsError);
  }

  const displayName = userPrefs?.whispernet_display_name || 'A Reader';

  // Fetch story owner's display name for the Whisper Back prompt
  const { data: authorPrefs, error: authorPrefsError } = await supabaseAdmin
    .from('user_preferences')
    .select('whispernet_display_name')
    .eq('user_id', story.user_id)
    .single();

  if (authorPrefsError) {
    console.error('Error fetching author preferences:', authorPrefsError);
  }

  const authorDisplayName = authorPrefs?.whispernet_display_name || "this story's author";

  // Create whisper_event (privacy baked in at write time)
  const { error: eventError } = await supabaseAdmin
    .from('whisper_events')
    .insert({
      event_type: 'resonance_left',
      actor_id: userId,
      story_id,
      metadata: {
        display_name: displayName,
        resonance_word: word.trim()
      },
      is_public: true
    });

  if (eventError) {
    console.error('Error creating whisper_event:', eventError);
    // Don't fail the request if event creation fails (resonance was still created)
  }

  // Check for badge eligibility (fire-and-forget)
  const { checkBadgeEligibility } = require('../services/badges');
  checkBadgeEligibility('resonance_left', userId, story_id).catch(err => {
    console.error('Badge check failed (non-blocking):', err.message);
  });

  res.json({
    success: true,
    resonance_id: resonance.id,
    author_display_name: authorDisplayName
  });
}));

/**
 * POST /whisper-backs
 * Leave a Whisper Back message for a story author
 */
router.post('/whisper-backs', authenticateUser, asyncHandler(async (req, res) => {
  const { resonance_id, message } = req.body;
  const { userId } = req;

  if (!resonance_id || !message) {
    return res.status(400).json({
      success: false,
      error: 'resonance_id and message are required'
    });
  }

  // Validate message length (max 280 characters)
  if (message.length > 280) {
    return res.status(400).json({
      success: false,
      error: 'Whisper Back must be 280 characters or less'
    });
  }

  // Verify the resonance exists and belongs to the user
  const { data: resonance, error: resonanceError } = await supabaseAdmin
    .from('resonances')
    .select('id, user_id')
    .eq('id', resonance_id)
    .eq('user_id', userId)
    .single();

  if (resonanceError || !resonance) {
    return res.status(404).json({
      success: false,
      error: 'Resonance not found or does not belong to you'
    });
  }

  // Check if user already left a whisper back for this resonance (UNIQUE constraint)
  const { data: existing, error: checkError } = await supabaseAdmin
    .from('whisper_backs')
    .select('id')
    .eq('resonance_id', resonance_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (checkError) {
    console.error('Error checking for existing whisper back:', checkError);
    throw new Error(`Failed to check for existing whisper back: ${checkError.message}`);
  }

  if (existing) {
    return res.status(409).json({
      success: false,
      error: 'You have already left a Whisper Back for this Resonance'
    });
  }

  // Fetch user's current display name to snapshot it
  const { data: userPrefs, error: prefsError } = await supabaseAdmin
    .from('user_preferences')
    .select('whispernet_display_name')
    .eq('user_id', userId)
    .single();

  if (prefsError) {
    console.error('Error fetching user preferences:', prefsError);
    throw new Error('Failed to fetch user preferences');
  }

  const displayName = userPrefs?.whispernet_display_name || 'A Reader';

  // Create whisper_back record
  const { data: whisperBack, error: insertError } = await supabaseAdmin
    .from('whisper_backs')
    .insert({
      resonance_id,
      user_id: userId,
      message: message.trim(),
      display_name: displayName // Snapshot at write time
    })
    .select()
    .single();

  if (insertError) {
    console.error('Error creating whisper back:', insertError);
    throw new Error(`Failed to create whisper back: ${insertError.message}`);
  }

  res.json({
    success: true,
    whisper_back_id: whisperBack.id
  });
}));

/**
 * GET /resonances/story/:storyId/similar-books
 * Get 2-3 similar books for recommendations after Resonance
 */
router.get('/story/:storyId/similar-books', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;

  // Fetch the source story to get genre and mood
  const { data: sourceStory, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('genre')
    .eq('id', storyId)
    .single();

  if (storyError || !sourceStory) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  // Get books already on the user's shelf (to exclude them)
  const { data: shelfBooks, error: shelfError } = await supabaseAdmin
    .from('whispernet_library')
    .select('story_id')
    .eq('user_id', userId);

  if (shelfError) {
    console.error('Error fetching shelf books:', shelfError);
  }

  const shelfStoryIds = shelfBooks ? shelfBooks.map(entry => entry.story_id) : [];

  // Find similar published books (same genre, not on shelf, not the source book)
  const { data: publications, error: pubError } = await supabaseAdmin
    .from('whispernet_publications')
    .select(`
      story_id,
      genre,
      mood_tags,
      maturity_rating,
      stories:story_id (
        id,
        title,
        genre,
        cover_image_url,
        user_id
      )
    `)
    .eq('is_active', true)
    .eq('genre', sourceStory.genre)
    .not('story_id', 'eq', storyId)
    .limit(10); // Get more than needed, then filter

  if (pubError) {
    console.error('Error fetching similar books:', pubError);
    throw new Error('Failed to fetch similar books');
  }

  // Filter out books already on shelf and limit to 3
  const recommendations = publications
    .filter(pub => !shelfStoryIds.includes(pub.story_id) && pub.stories)
    .slice(0, 3);

  // For each recommendation, get the top Resonance word
  const enrichedRecommendations = await Promise.all(
    recommendations.map(async (pub) => {
      const { data: topResonance } = await supabaseAdmin
        .from('resonances')
        .select('word')
        .eq('story_id', pub.story_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      return {
        story_id: pub.story_id,
        title: pub.stories.title,
        genre: pub.genre,
        cover_image_url: pub.stories.cover_image_url,
        maturity_rating: pub.maturity_rating,
        top_resonance_word: topResonance?.word || null
      };
    })
  );

  res.json({
    success: true,
    recommendations: enrichedRecommendations
  });
}));

module.exports = router;
