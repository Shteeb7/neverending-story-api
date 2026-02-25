const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');
const { BADGE_DEFINITIONS } = require('../services/badges');

const router = express.Router();

/**
 * GET /mine
 * Get all earned badges for the authenticated user
 * Returns badges with display names, taglines, story titles (for story-level), and earned_at timestamps
 */
router.get('/mine', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;

  // Fetch all earned badges for this user
  const { data: earnedBadges, error: badgesError } = await supabaseAdmin
    .from('earned_badges')
    .select(`
      id,
      badge_type,
      story_id,
      earned_at,
      stories:story_id (
        title
      )
    `)
    .eq('user_id', userId)
    .order('earned_at', { ascending: false });

  if (badgesError) {
    console.error('Error fetching earned badges:', badgesError);
    throw new Error(`Failed to fetch badges: ${badgesError.message}`);
  }

  // Format badges with definitions and story titles
  const formattedBadges = earnedBadges.map(badge => {
    const definition = BADGE_DEFINITIONS[badge.badge_type];

    return {
      badge_type: badge.badge_type,
      display_name: definition?.name || badge.badge_type,
      tagline: definition?.tagline || '',
      level: definition?.level || 'unknown',
      story_title: badge.stories?.title || null,
      earned_at: badge.earned_at
    };
  });

  // Group by badge_type for the response
  const groupedBadges = formattedBadges.reduce((acc, badge) => {
    if (!acc[badge.badge_type]) {
      acc[badge.badge_type] = [];
    }
    acc[badge.badge_type].push(badge);
    return acc;
  }, {});

  res.json({
    success: true,
    badges: formattedBadges,
    grouped: groupedBadges,
    total_count: formattedBadges.length
  });
}));

/**
 * GET /recent?since=<ISO timestamp>
 * Get badges earned since a specific timestamp
 * Used for checking for newly earned badges to show celebration
 */
router.get('/recent', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { since } = req.query;

  if (!since) {
    return res.status(400).json({
      success: false,
      error: 'since parameter is required (ISO timestamp)'
    });
  }

  // Validate ISO timestamp format
  const sinceDate = new Date(since);
  if (isNaN(sinceDate.getTime())) {
    return res.status(400).json({
      success: false,
      error: 'since must be a valid ISO timestamp'
    });
  }

  // Fetch badges earned after the since timestamp
  const { data: earnedBadges, error: badgesError } = await supabaseAdmin
    .from('earned_badges')
    .select(`
      id,
      badge_type,
      story_id,
      earned_at,
      stories:story_id (
        title
      )
    `)
    .eq('user_id', userId)
    .gt('earned_at', since)
    .order('earned_at', { ascending: false });

  if (badgesError) {
    console.error('Error fetching recent badges:', badgesError);
    throw new Error(`Failed to fetch recent badges: ${badgesError.message}`);
  }

  // Format badges with definitions
  const formattedBadges = (earnedBadges || []).map(badge => {
    const definition = BADGE_DEFINITIONS[badge.badge_type];

    return {
      badge_type: badge.badge_type,
      display_name: definition?.name || badge.badge_type,
      tagline: definition?.tagline || '',
      level: definition?.level || 'unknown',
      story_title: badge.stories?.title || null,
      earned_at: badge.earned_at
    };
  });

  res.json({
    success: true,
    badges: formattedBadges,
    count: formattedBadges.length
  });
}));

module.exports = router;
