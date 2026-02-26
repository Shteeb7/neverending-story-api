/**
 * WHISPERNET NOTIFICATION SERVICE
 *
 * Handles all WhisperNet push notifications:
 * - Realtime push (throttled: max 1 per 15 min per story)
 * - Daily digest (9am local timezone)
 * - Badge celebrations (in-app, bypasses 'off' setting)
 *
 * Called by whisper_events insert triggers and scheduled jobs.
 */

const { supabaseAdmin } = require('../config/supabase');

// In-memory throttle map: { "storyId_userId": lastPushTimestamp }
// Prevents more than 1 push per 15 minutes per story
const throttleMap = new Map();
const THROTTLE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Cleanup throttle map every hour to prevent memory leak
// Skip in test environment to allow Jest to exit cleanly
if (process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of throttleMap.entries()) {
      if (now - timestamp > THROTTLE_WINDOW_MS * 2) {
        throttleMap.delete(key);
      }
    }
  }, 60 * 60 * 1000); // 1 hour
}

/**
 * EVENT PRIORITY (for throttle window conflicts)
 */
const EVENT_PRIORITY = {
  'resonance_left': 1,
  'badge_earned': 2,
  'whisper_back': 3,
  'book_gifted': 4,
  'book_claimed': 5,
  'reading_started': 6
};

/**
 * Main entry point: process a whisper_event and route to appropriate notification channel
 *
 * @param {Object} event - whisper_event record
 * @returns {Promise<void>}
 */
async function processWhisperEvent(event) {
  try {
    // Determine who should be notified
    const recipientId = await getRecipientId(event);
    if (!recipientId) {
      console.log(`📭 No recipient for event ${event.event_type} (event_id: ${event.id})`);
      return;
    }

    // Get recipient's notification preference
    const { data: prefs, error: prefsError } = await supabaseAdmin
      .from('user_preferences')
      .select('whisper_notification_pref, apns_device_token, timezone')
      .eq('user_id', recipientId)
      .maybeSingle();

    if (prefsError) {
      console.error('Error fetching notification preferences:', prefsError);
      return;
    }

    const notificationPref = prefs?.whisper_notification_pref || 'daily';

    // Special handling: badge_earned always triggers in-app celebration (even if pref is 'off')
    if (event.event_type === 'badge_earned') {
      await storePendingBadgeNotification(recipientId, event);
      // If pref is 'off', stop here (no push, only in-app)
      if (notificationPref === 'off') {
        console.log(`🏅 Badge celebration queued for in-app display (user has notifications off)`);
        return;
      }
    }

    // Route based on preference
    if (notificationPref === 'off') {
      // Skip entirely (unless badge, which was already handled above)
      console.log(`📭 Skipping notification for user ${recipientId} (pref: off)`);
      return;
    } else if (notificationPref === 'realtime') {
      await sendRealtimePush(recipientId, event, prefs);
    } else if (notificationPref === 'daily') {
      await queueForDigest(recipientId, event);
    }

  } catch (error) {
    console.error('Error processing whisper event for notifications:', error);
  }
}

/**
 * Determine who should receive notification for this event
 * - Most events: story owner
 * - badge_earned: user who earned the badge (from metadata.user_id)
 */
async function getRecipientId(event) {
  if (event.event_type === 'badge_earned') {
    // Badge notifications go to the user who earned it
    return event.metadata?.user_id || null;
  }

  // All other events notify the story owner
  if (!event.story_id) {
    return null;
  }

  const { data: story, error } = await supabaseAdmin
    .from('stories')
    .select('user_id')
    .eq('id', event.story_id)
    .maybeSingle();

  if (error || !story) {
    console.error('Error fetching story owner:', error);
    return null;
  }

  return story.user_id;
}

/**
 * Send realtime push notification (with throttling)
 */
async function sendRealtimePush(userId, event, userPrefs) {
  // Check throttle
  const throttleKey = `${event.story_id}_${userId}`;
  const now = Date.now();
  const lastPushTime = throttleMap.get(throttleKey);

  if (lastPushTime && (now - lastPushTime) < THROTTLE_WINDOW_MS) {
    // Within throttle window - queue for next digest instead
    console.log(`⏱️  Throttled: event ${event.event_type} for story ${event.story_id} (< 15 min since last push)`);
    await queueForDigest(userId, event);
    return;
  }

  // Not throttled - send push
  const deviceToken = userPrefs?.apns_device_token;
  if (!deviceToken) {
    console.log(`📭 No device token for user ${userId} - cannot send push`);
    await queueForDigest(userId, event); // Queue for digest as fallback
    return;
  }

  const pushPayload = buildPushPayload(event);

  // TODO: Implement actual APNS sending (Task 45)
  // For now, log the payload
  console.log(`🔔 [REALTIME PUSH] to user ${userId}:`, pushPayload.alert);
  console.log(`   Device token: ${deviceToken.substring(0, 20)}...`);

  // Update throttle map
  throttleMap.set(throttleKey, now);

  // In production, would call:
  // await sendAPNS(deviceToken, pushPayload);
}

/**
 * Build push notification payload from event
 */
function buildPushPayload(event) {
  const metadata = event.metadata || {};
  const storyTitle = metadata.story_title || 'your story';
  const displayName = metadata.display_name || 'A reader';
  const resonanceWord = metadata.word || '';
  const badgeName = metadata.badge_name || '';

  let alert = '';

  switch (event.event_type) {
    case 'resonance_left':
      alert = `A reader left a Resonance on ${storyTitle}: ${resonanceWord}`;
      break;
    case 'badge_earned':
      alert = `Your story ${storyTitle} earned the ${badgeName} badge`;
      break;
    case 'whisper_back':
      alert = `A reader whispered back on ${storyTitle}`;
      break;
    case 'book_gifted':
      alert = `${displayName} gifted ${storyTitle} to someone new`;
      break;
    case 'book_claimed':
      alert = `Someone started reading ${storyTitle}`;
      break;
    default:
      alert = `New activity on ${storyTitle}`;
  }

  return {
    alert,
    badge: 1,
    sound: 'default',
    data: {
      event_type: event.event_type,
      story_id: event.story_id,
      event_id: event.id
    }
  };
}

/**
 * Queue event for daily digest (no immediate push)
 */
async function queueForDigest(userId, event) {
  // Events are already stored in whisper_events table
  // Daily digest job will query them
  console.log(`📬 Queued for digest: ${event.event_type} for user ${userId}`);
  // No-op - whisper_events table is the queue
}

/**
 * Store pending badge notification for in-app display
 * (Used when user has notifications OFF but earned a badge)
 */
async function storePendingBadgeNotification(userId, event) {
  // Badge celebrations are handled by the existing badge system from Prompt 7:
  // - iOS LibraryView calls GET /api/badges/recent?since=<UserDefaults timestamp> on app launch
  // - New badges are auto-discovered and shown via BadgeCelebrationOverlay
  // - No additional storage needed here - earned_badges table is the source of truth
  console.log(`🏅 Badge notification ready for in-app display (will auto-discover via GET /api/badges/recent)`);
}

module.exports = {
  processWhisperEvent
};
