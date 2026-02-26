/**
 * NOTIFICATION ROUTES
 *
 * Handles WhisperNet notification preferences and digest retrieval.
 */

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

/**
 * PUT /api/preferences/timezone
 * Update user's timezone
 */
router.put('/timezone', authenticateUser, asyncHandler(async (req, res) => {
  const { timezone } = req.body;
  const { userId } = req;

  if (!timezone) {
    return res.status(400).json({
      success: false,
      error: 'timezone is required'
    });
  }

  // Update timezone
  const { error: updateError } = await supabaseAdmin
    .from('user_preferences')
    .update({ timezone })
    .eq('user_id', userId);

  if (updateError) {
    console.error('Error updating timezone:', updateError);
    throw new Error(`Failed to update timezone: ${updateError.message}`);
  }

  console.log(`🌍 User ${userId} set timezone to: ${timezone}`);

  res.json({
    success: true,
    timezone
  });
}));

/**
 * PUT /api/notifications/preferences
 * Update user's WhisperNet notification preference
 */
router.put('/preferences', authenticateUser, asyncHandler(async (req, res) => {
  const { whisper_notification_pref } = req.body;
  const { userId } = req;

  if (!whisper_notification_pref) {
    return res.status(400).json({
      success: false,
      error: 'whisper_notification_pref is required'
    });
  }

  // Validate value
  const validPrefs = ['off', 'daily', 'realtime'];
  if (!validPrefs.includes(whisper_notification_pref)) {
    return res.status(400).json({
      success: false,
      error: `whisper_notification_pref must be one of: ${validPrefs.join(', ')}`
    });
  }

  // Update preference
  const { error: updateError } = await supabaseAdmin
    .from('user_preferences')
    .update({ whisper_notification_pref })
    .eq('user_id', userId);

  if (updateError) {
    console.error('Error updating notification preference:', updateError);
    throw new Error(`Failed to update preference: ${updateError.message}`);
  }

  console.log(`🔔 User ${userId} set notification pref to: ${whisper_notification_pref}`);

  res.json({
    success: true,
    whisper_notification_pref
  });
}));

/**
 * GET /api/notifications/digest
 * Get recent WhisperNet activity for digest view
 */
router.get('/digest', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;

  // Get user's stories
  const { data: userStories, error: storiesError } = await supabaseAdmin
    .from('stories')
    .select('id, title')
    .eq('user_id', userId);

  if (storiesError) {
    console.error('Error fetching user stories:', storiesError);
    throw new Error(`Failed to fetch stories: ${storiesError.message}`);
  }

  if (!userStories || userStories.length === 0) {
    return res.json({
      success: true,
      digest: []
    });
  }

  const storyIds = userStories.map(s => s.id);
  const storyTitleMap = {};
  userStories.forEach(s => {
    storyTitleMap[s.id] = s.title;
  });

  // Get recent whisper_events for these stories (last 7 days, max 50)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: events, error: eventsError } = await supabaseAdmin
    .from('whisper_events')
    .select('id, event_type, story_id, actor_id, metadata, created_at, is_public')
    .in('story_id', storyIds)
    .eq('is_public', true)
    .gte('created_at', sevenDaysAgo)
    .order('created_at', { ascending: false })
    .limit(50);

  if (eventsError) {
    console.error('Error fetching digest events:', eventsError);
    throw new Error(`Failed to fetch events: ${eventsError.message}`);
  }

  if (!events || events.length === 0) {
    return res.json({
      success: true,
      digest: []
    });
  }

  // Group by story
  const groupedByStory = {};
  for (const event of events) {
    const storyId = event.story_id;
    if (!groupedByStory[storyId]) {
      groupedByStory[storyId] = {
        story_id: storyId,
        story_title: storyTitleMap[storyId] || 'Unknown Story',
        events: []
      };
    }
    groupedByStory[storyId].events.push({
      id: event.id,
      event_type: event.event_type,
      description: buildEventDescription(event, storyTitleMap[storyId]),
      timestamp: event.created_at,
      metadata: event.metadata
    });
  }

  // Convert to array and limit to 20 total items
  const digestItems = [];
  for (const group of Object.values(groupedByStory)) {
    for (const event of group.events) {
      digestItems.push({
        story_id: group.story_id,
        story_title: group.story_title,
        ...event
      });
      if (digestItems.length >= 20) break;
    }
    if (digestItems.length >= 20) break;
  }

  res.json({
    success: true,
    digest: digestItems.slice(0, 20) // Ensure exactly max 20
  });
}));

/**
 * Helper: Build human-readable event description
 */
function buildEventDescription(event, storyTitle) {
  const metadata = event.metadata || {};
  const displayName = metadata.display_name || 'A reader';
  const resonanceWord = metadata.word || '';
  const badgeName = metadata.badge_name || '';

  switch (event.event_type) {
    case 'resonance_left':
      return `${displayName} left a Resonance: ${resonanceWord}`;
    case 'badge_earned':
      return `Your story earned the ${badgeName} badge`;
    case 'whisper_back':
      return `${displayName} whispered back`;
    case 'book_gifted':
      return `${displayName} gifted this story to someone new`;
    case 'book_claimed':
      return `${displayName} started reading`;
    default:
      return 'New activity';
  }
}

module.exports = router;
