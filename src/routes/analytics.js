const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

/**
 * Compute active reading time from heartbeat trail
 * Returns active seconds, idle seconds, and reading speed (scroll % per minute)
 */
async function computeActiveReadingTime(sessionId, sessionStart) {
  // 1. Fetch all heartbeats for this session, ordered by time
  const { data: heartbeats } = await supabaseAdmin
    .from('reading_heartbeats')
    .select('scroll_position, recorded_at')
    .eq('session_id', sessionId)
    .order('recorded_at', { ascending: true });

  if (!heartbeats || heartbeats.length < 2) {
    // Not enough data — fall back to wall-clock, capped at 60s
    return {
      activeSeconds: null,  // signals "not enough data"
      idleSeconds: null,
      readingSpeed: null
    };
  }

  const IDLE_THRESHOLD_MS = 10000;  // 10 seconds with no scroll movement = idle
  let activeMs = 0;
  let idleMs = 0;
  let totalScrollDelta = 0;
  let activeScrollTime = 0;

  for (let i = 1; i < heartbeats.length; i++) {
    const prev = heartbeats[i - 1];
    const curr = heartbeats[i];
    const timeDelta = new Date(curr.recorded_at) - new Date(prev.recorded_at);
    const scrollDelta = Math.abs(curr.scroll_position - prev.scroll_position);

    if (scrollDelta > 0 && timeDelta < IDLE_THRESHOLD_MS) {
      // Active reading: scroll moved within threshold
      activeMs += timeDelta;
      totalScrollDelta += scrollDelta;
      activeScrollTime += timeDelta;
    } else if (scrollDelta === 0 && timeDelta < IDLE_THRESHOLD_MS) {
      // Paused but not idle yet (could be reading visible text)
      // Count up to 5 seconds of no-scroll as active, then idle
      const pauseCredit = Math.min(timeDelta, 5000);
      activeMs += pauseCredit;
      idleMs += (timeDelta - pauseCredit);
    } else {
      // Gap exceeds threshold — user was idle
      idleMs += timeDelta;
    }
  }

  // Reading speed: scroll % per minute of active time
  const activeMinutes = activeMs / 60000;
  const readingSpeed = activeMinutes > 0 ? totalScrollDelta / activeMinutes : null;

  // Head estimation: time from session_start to first heartbeat
  const firstHeartbeat = new Date(heartbeats[0].recorded_at);
  const headMs = firstHeartbeat - new Date(sessionStart);
  // Only count head time if reasonable (< 30s) — beyond that, they opened and walked away
  const headCredit = Math.min(Math.max(headMs, 0), 30000);

  // Tail estimation: based on reading speed, estimate time to read remaining visible content
  // Assume ~15% of chapter is visible in viewport at any time
  const tailCredit = readingSpeed ? (15 / readingSpeed) * 60000 : 10000;  // default 10s
  const cappedTail = Math.min(tailCredit, 30000);  // cap at 30s

  const totalActiveMs = activeMs + headCredit + cappedTail;

  return {
    activeSeconds: Math.round(totalActiveMs / 1000),
    idleSeconds: Math.round(idleMs / 1000),
    readingSpeed: readingSpeed ? Math.round(readingSpeed * 100) / 100 : null
  };
}

/**
 * POST /analytics/session/start
 * Start a new reading session for a chapter
 */
router.post('/session/start', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { storyId, chapterNumber } = req.body;

  if (!storyId || chapterNumber === undefined) {
    return res.status(400).json({
      success: false,
      error: 'storyId and chapterNumber are required'
    });
  }

  console.log(`📖 Starting reading session: user=${userId.slice(0, 8)}..., story=${storyId.slice(0, 8)}..., ch=${chapterNumber}`);

  // Create new reading session
  const { data, error } = await supabaseAdmin
    .from('reading_sessions')
    .insert({
      user_id: userId,
      story_id: storyId,
      chapter_number: chapterNumber,
      session_start: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to start reading session: ${error.message}`);
  }

  // Update chapter_reading_stats: set first_opened only if this is the first time
  const now = new Date().toISOString();

  // Check if stats row already exists
  const { data: existingStats } = await supabaseAdmin
    .from('chapter_reading_stats')
    .select('first_opened')
    .eq('user_id', userId)
    .eq('story_id', storyId)
    .eq('chapter_number', chapterNumber)
    .maybeSingle();

  const { error: statsError } = await supabaseAdmin
    .from('chapter_reading_stats')
    .upsert({
      user_id: userId,
      story_id: storyId,
      chapter_number: chapterNumber,
      first_opened: existingStats?.first_opened || now,  // Only set if no existing row
      updated_at: now
    }, {
      onConflict: 'user_id,story_id,chapter_number',
      ignoreDuplicates: false
    });

  if (statsError) {
    console.error('Failed to update chapter stats (non-blocking):', statsError.message);
  }

  res.json({
    success: true,
    sessionId: data.id
  });
}));

/**
 * POST /analytics/session/heartbeat
 * Update session with current scroll progress (keep-alive)
 */
router.post('/session/heartbeat', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { sessionId, scrollProgress } = req.body;

  if (!sessionId || scrollProgress === undefined) {
    return res.status(400).json({
      success: false,
      error: 'sessionId and scrollProgress are required'
    });
  }

  // Update session: set session_end to NOW (acts as keep-alive), update max_scroll_progress
  const { data: session, error: fetchError } = await supabaseAdmin
    .from('reading_sessions')
    .select('max_scroll_progress, completed')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .single();

  if (fetchError || !session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found'
    });
  }

  const newMaxScroll = Math.max(session.max_scroll_progress || 0, scrollProgress);
  const isCompleted = session.completed || scrollProgress >= 90;

  const { error: updateError } = await supabaseAdmin
    .from('reading_sessions')
    .update({
      session_end: new Date().toISOString(),
      max_scroll_progress: newMaxScroll,
      completed: isCompleted
    })
    .eq('id', sessionId)
    .eq('user_id', userId);

  if (updateError) {
    throw new Error(`Failed to update session: ${updateError.message}`);
  }

  // Store heartbeat event (fire-and-forget, no await)
  supabaseAdmin
    .from('reading_heartbeats')
    .insert({
      session_id: sessionId,
      scroll_position: scrollProgress,
      recorded_at: new Date().toISOString()
    });

  res.json({
    success: true
  });
}));

/**
 * POST /analytics/session/end
 * End a reading session and update aggregated stats
 */
router.post('/session/end', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { sessionId, scrollProgress } = req.body;

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: 'sessionId is required'
    });
  }

  // Fetch session
  const { data: session, error: fetchError } = await supabaseAdmin
    .from('reading_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .single();

  if (fetchError || !session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found'
    });
  }

  const sessionEnd = new Date();
  const sessionStart = new Date(session.session_start);

  // Compute active reading time from heartbeat trail
  const readingMetrics = await computeActiveReadingTime(sessionId, session.session_start);

  // Use active time if available, fall back to wall-clock (existing behavior)
  const wallClockSeconds = Math.round((sessionEnd - sessionStart) / 1000);
  const finalDuration = readingMetrics.activeSeconds !== null ? readingMetrics.activeSeconds : wallClockSeconds;

  const finalScrollProgress = scrollProgress !== undefined ? scrollProgress : (session.max_scroll_progress || 0);
  const newMaxScroll = Math.max(session.max_scroll_progress || 0, finalScrollProgress);
  const isCompleted = session.completed || finalScrollProgress >= 90;

  console.log(`📖 Ending session: ${sessionId.slice(0, 8)}..., active=${readingMetrics.activeSeconds}s, idle=${readingMetrics.idleSeconds}s, wall=${wallClockSeconds}s, speed=${readingMetrics.readingSpeed}%/min, scroll=${newMaxScroll.toFixed(1)}%`);

  // Update session with end time and final stats
  const { error: updateError } = await supabaseAdmin
    .from('reading_sessions')
    .update({
      session_end: sessionEnd.toISOString(),
      reading_duration_seconds: finalDuration,
      active_reading_seconds: readingMetrics.activeSeconds,
      estimated_reading_speed: readingMetrics.readingSpeed,
      idle_seconds: readingMetrics.idleSeconds,
      max_scroll_progress: newMaxScroll,
      completed: isCompleted
    })
    .eq('id', sessionId)
    .eq('user_id', userId);

  if (updateError) {
    throw new Error(`Failed to end session: ${updateError.message}`);
  }

  // Update chapter_reading_stats: add duration, increment session_count, update max_scroll_progress
  const { data: existingStats } = await supabaseAdmin
    .from('chapter_reading_stats')
    .select('*')
    .eq('user_id', userId)
    .eq('story_id', session.story_id)
    .eq('chapter_number', session.chapter_number)
    .maybeSingle();

  const now = new Date().toISOString();

  const { error: statsError } = await supabaseAdmin
    .from('chapter_reading_stats')
    .upsert({
      user_id: userId,
      story_id: session.story_id,
      chapter_number: session.chapter_number,
      total_reading_time_seconds: (existingStats?.total_reading_time_seconds || 0) + finalDuration,
      total_active_reading_seconds: (existingStats?.total_active_reading_seconds || 0) + (readingMetrics.activeSeconds || finalDuration),
      avg_reading_speed: readingMetrics.readingSpeed || existingStats?.avg_reading_speed,
      session_count: (existingStats?.session_count || 0) + 1,
      max_scroll_progress: Math.max(existingStats?.max_scroll_progress || 0, newMaxScroll),
      first_opened: existingStats?.first_opened || now,
      last_read: now,
      completed: existingStats?.completed || isCompleted,
      updated_at: now
    }, {
      onConflict: 'user_id,story_id,chapter_number'
    });

  if (statsError) {
    console.error('Failed to update chapter reading stats:', statsError.message);
  }

  res.json({
    success: true,
    stats: {
      duration: finalDuration,
      completed: isCompleted
    }
  });
}));

/**
 * GET /analytics/reading-stats/:storyId
 * Get aggregated reading stats for all chapters in a story
 */
router.get('/reading-stats/:storyId', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { storyId } = req.params;

  const { data: stats, error } = await supabaseAdmin
    .from('chapter_reading_stats')
    .select('*')
    .eq('user_id', userId)
    .eq('story_id', storyId)
    .order('chapter_number', { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch reading stats: ${error.message}`);
  }

  res.json({
    success: true,
    stats: stats || []
  });
}));

module.exports = router;
