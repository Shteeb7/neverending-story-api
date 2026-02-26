const { supabaseAdmin } = require('../config/supabase');
const { processWhisperEvent } = require('./notifications');

/**
 * Badge System
 *
 * 7 badges total:
 * - Story-level (4): Ember, Current, Worldwalker, Resonant
 * - User-level (3): Wanderer, Lamplighter, Chainmaker
 *
 * Called after every whisper_event insert.
 * Idempotent via UNIQUE constraint on (badge_type, user_id, story_id).
 */

const BADGE_DEFINITIONS = {
  // Story-level badges
  ember: {
    name: 'Ember',
    tagline: 'Your story has warmed 5 hearths',
    level: 'story'
  },
  current: {
    name: 'Current',
    tagline: 'Your story flows through 3 degrees of sharing',
    level: 'story'
  },
  worldwalker: {
    name: 'Worldwalker',
    tagline: 'Your story has crossed borders',
    level: 'story'
  },
  resonant: {
    name: 'Resonant',
    tagline: 'Your story echoes with 25 voices',
    level: 'story'
  },
  // User-level badges
  wanderer: {
    name: 'Wanderer',
    tagline: 'You have explored 10 worlds beyond your own',
    level: 'user'
  },
  lamplighter: {
    name: 'Lamplighter',
    tagline: 'Your gift lit someone\'s first flame',
    level: 'user'
  },
  chainmaker: {
    name: 'Chainmaker',
    tagline: 'A story you shared has reached 3 degrees',
    level: 'user'
  }
};

/**
 * Check and award badges based on a whisper_event
 * @param {string} eventType - The type of event that triggered this check
 * @param {string} actorId - The user who triggered the event
 * @param {string} storyId - The story associated with the event (nullable for user-level events)
 * @returns {Promise<Array>} - List of newly earned badges
 */
async function checkBadgeEligibility(eventType, actorId, storyId) {
  const newlyEarned = [];

  try {
    // Determine which badges to check based on event type
    const checksToRun = [];

    if (['book_claimed', 'book_gifted'].includes(eventType) && storyId) {
      checksToRun.push(
        checkEmberBadge(storyId),
        checkCurrentBadge(storyId),
        checkChainmakerBadge(actorId)
      );
    }

    if (eventType === 'book_finished' && storyId) {
      checksToRun.push(
        checkWorldwalkerBadge(storyId),
        checkWandererBadge(actorId)
      );
    }

    if (eventType === 'resonance_left' && storyId) {
      checksToRun.push(checkResonantBadge(storyId));
    }

    if (eventType === 'book_claimed') {
      checksToRun.push(checkLamplighterBadge(actorId));
    }

    // Run all checks in parallel
    const results = await Promise.all(checksToRun);

    // Filter out nulls and collect newly earned badges
    for (const badge of results.filter(Boolean)) {
      newlyEarned.push(badge);
    }

    // Log badge awards
    for (const badge of newlyEarned) {
      const storyInfo = badge.story_title ? ` for "${badge.story_title}"` : '';
      console.log(`🏅 [Badge] ${badge.badge_type} earned${storyInfo} by ${badge.user_display_name || badge.user_id}`);
    }

  } catch (error) {
    console.error('❌ Badge eligibility check failed:', error);
    // Don't throw — badge checks are fire-and-forget
  }

  return newlyEarned;
}

/**
 * Ember Badge: Your story has warmed 5 hearths
 * Trigger: 5+ unique readers on WhisperNet shelf
 */
async function checkEmberBadge(storyId) {
  const { data: story } = await supabaseAdmin
    .from('stories')
    .select('user_id, title')
    .eq('id', storyId)
    .maybeSingle();

  if (!story) return null;

  // Count unique readers who have this story on their shelf
  const { count } = await supabaseAdmin
    .from('whispernet_library')
    .select('user_id', { count: 'exact', head: true })
    .eq('story_id', storyId);

  if (count >= 5) {
    return await awardBadge('ember', story.user_id, storyId, story.title);
  }

  return null;
}

/**
 * Current Badge: Your story flows through 3 degrees of sharing
 * Trigger: Share chain depth >= 3
 */
async function checkCurrentBadge(storyId) {
  const { data: story } = await supabaseAdmin
    .from('stories')
    .select('user_id, title')
    .eq('id', storyId)
    .maybeSingle();

  if (!story) return null;

  // Find max share chain depth for this story
  const { data: links } = await supabaseAdmin
    .from('share_links')
    .select('share_chain_depth')
    .eq('story_id', storyId)
    .order('share_chain_depth', { ascending: false })
    .limit(1);

  const maxDepth = links?.[0]?.share_chain_depth || 0;

  if (maxDepth >= 3) {
    return await awardBadge('current', story.user_id, storyId, story.title);
  }

  return null;
}

/**
 * Worldwalker Badge: Your story has crossed borders
 * Trigger: 2+ unique timezone regions (using timezone prefix as proxy)
 */
async function checkWorldwalkerBadge(storyId) {
  const { data: story } = await supabaseAdmin
    .from('stories')
    .select('user_id, title')
    .eq('id', storyId)
    .maybeSingle();

  if (!story) return null;

  // Get all book_finished events for this story
  const { data: events } = await supabaseAdmin
    .from('whisper_events')
    .select('metadata')
    .eq('story_id', storyId)
    .eq('event_type', 'book_finished');

  if (!events) return null;

  // Extract timezone regions (e.g., 'America/', 'Europe/', 'Asia/')
  const regions = new Set();
  for (const event of events) {
    const timezone = event.metadata?.timezone;
    if (timezone) {
      const region = timezone.split('/')[0]; // Extract region prefix
      regions.add(region);
    }
  }

  if (regions.size >= 2) {
    return await awardBadge('worldwalker', story.user_id, storyId, story.title);
  }

  return null;
}

/**
 * Resonant Badge: Your story echoes with 25 voices
 * Trigger: 25+ resonances
 */
async function checkResonantBadge(storyId) {
  const { data: story } = await supabaseAdmin
    .from('stories')
    .select('user_id, title')
    .eq('id', storyId)
    .maybeSingle();

  if (!story) return null;

  // Count resonances for this story
  const { count } = await supabaseAdmin
    .from('resonances')
    .select('id', { count: 'exact', head: true })
    .eq('story_id', storyId);

  if (count >= 25) {
    return await awardBadge('resonant', story.user_id, storyId, story.title);
  }

  return null;
}

/**
 * Wanderer Badge: You have explored 10 worlds beyond your own
 * Trigger: 10+ WhisperNet books finished
 */
async function checkWandererBadge(userId) {
  // Count distinct WhisperNet books finished by this user
  const { data: finishedBooks } = await supabaseAdmin
    .from('whisper_events')
    .select('story_id')
    .eq('actor_id', userId)
    .eq('event_type', 'book_finished');

  if (!finishedBooks) return null;

  // Filter to only WhisperNet books (books on their whispernet_library shelf)
  const { data: libraryBooks } = await supabaseAdmin
    .from('whispernet_library')
    .select('story_id')
    .eq('user_id', userId);

  if (!libraryBooks) return null;

  const libraryStoryIds = new Set(libraryBooks.map(b => b.story_id));
  const whisperNetFinished = finishedBooks.filter(b => libraryStoryIds.has(b.story_id));
  const uniqueFinished = new Set(whisperNetFinished.map(b => b.story_id));

  if (uniqueFinished.size >= 10) {
    return await awardBadge('wanderer', userId, null, null);
  }

  return null;
}

/**
 * Lamplighter Badge: Your gift lit someone's first flame
 * Trigger: Share link claimed by a new signup (account created within 24h of claim)
 */
async function checkLamplighterBadge(claimerId) {
  // Find share links claimed by this user
  const { data: links } = await supabaseAdmin
    .from('share_links')
    .select('sender_id, claimed_at')
    .eq('claimed_by', claimerId);

  if (!links || links.length === 0) return null;

  // Check if the claimer is a new signup (account created within 24h of first claim)
  const { data: claimer } = await supabaseAdmin
    .from('auth.users')
    .select('created_at')
    .eq('id', claimerId)
    .maybeSingle();

  if (!claimer) return null;

  const accountCreated = new Date(claimer.created_at);

  // Check each link to see if it was claimed within 24h of account creation
  for (const link of links) {
    const claimedAt = new Date(link.claimed_at);
    const hoursDiff = (claimedAt - accountCreated) / (1000 * 60 * 60);

    if (hoursDiff <= 24) {
      // This was a new signup who claimed the link — award Lamplighter to the sender
      return await awardBadge('lamplighter', link.sender_id, null, null);
    }
  }

  return null;
}

/**
 * Chainmaker Badge: A story you shared has reached 3 degrees
 * Trigger: Share chain descended from user's link reaches depth 3+
 */
async function checkChainmakerBadge(userId) {
  // Find all share links created by this user
  const { data: userLinks } = await supabaseAdmin
    .from('share_links')
    .select('id')
    .eq('sender_id', userId);

  if (!userLinks || userLinks.length === 0) return null;

  const userLinkIds = userLinks.map(l => l.id);

  // Find any links that have one of the user's links as an ancestor
  const { data: descendantLinks } = await supabaseAdmin
    .from('share_links')
    .select('share_chain_depth, parent_link_id')
    .gte('share_chain_depth', 3);

  if (!descendantLinks) return null;

  // Check if any of these chains trace back to the user
  for (const link of descendantLinks) {
    if (await isAncestor(link.parent_link_id, userLinkIds)) {
      return await awardBadge('chainmaker', userId, null, null);
    }
  }

  return null;
}

/**
 * Helper: Check if a link's ancestry includes any of the target link IDs
 */
async function isAncestor(linkId, targetIds) {
  if (!linkId) return false;
  if (targetIds.includes(linkId)) return true;

  // Recursively check parent
  const { data: link } = await supabaseAdmin
    .from('share_links')
    .select('parent_link_id')
    .eq('id', linkId)
    .maybeSingle();

  if (!link) return false;

  return await isAncestor(link.parent_link_id, targetIds);
}

/**
 * Award a badge (idempotent)
 * @returns {Object|null} - Badge info if newly earned, null if already had it
 */
async function awardBadge(badgeType, userId, storyId, storyTitle) {
  const badgeInfo = BADGE_DEFINITIONS[badgeType];
  if (!badgeInfo) {
    console.error(`❌ Unknown badge type: ${badgeType}`);
    return null;
  }

  // Try to insert badge (idempotent via UNIQUE constraint)
  const { data: badge, error } = await supabaseAdmin
    .from('earned_badges')
    .insert({
      badge_type: badgeType,
      user_id: userId,
      story_id: storyId
    })
    .select()
    .maybeSingle();

  // If error is due to unique constraint, badge already exists — return null
  if (error) {
    if (error.code === '23505') {
      // Unique violation — already earned
      return null;
    }
    console.error(`❌ Failed to award ${badgeType} badge:`, error);
    return null;
  }

  // Badge was newly earned! Create whisper_event
  const { data: userPrefs } = await supabaseAdmin
    .from('user_preferences')
    .select('whispernet_display_name')
    .eq('user_id', userId)
    .maybeSingle();

  const displayName = userPrefs?.whispernet_display_name || 'A Reader';

  await supabaseAdmin
    .from('whisper_events')
    .insert({
      event_type: 'badge_earned',
      actor_id: userId,
      story_id: storyId,
      metadata: {
        badge_type: badgeType,
        badge_name: badgeInfo.name,
        badge_tagline: badgeInfo.tagline,
        story_title: storyTitle,
        display_name: displayName
      },
      is_public: true
    });

  // Process notification routing (fire-and-forget)
  processWhisperEvent({
    event_type: 'badge_earned',
    actor_id: userId,
    story_id: storyId,
    metadata: {
      badge_type: badgeType,
      badge_name: badgeInfo.name,
      badge_tagline: badgeInfo.tagline,
      story_title: storyTitle,
      display_name: displayName,
      user_id: userId // Include for badge special handling
    }
  }).catch(err => {
    console.error('Notification processing failed:', err.message);
  });

  return {
    badge_type: badgeType,
    badge_name: badgeInfo.name,
    badge_tagline: badgeInfo.tagline,
    story_title: storyTitle,
    user_id: userId,
    user_display_name: displayName,
    earned_at: badge.earned_at
  };
}

module.exports = {
  checkBadgeEligibility,
  BADGE_DEFINITIONS
};
