const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

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
  const durationSeconds = Math.round((sessionEnd - sessionStart) / 1000);

  const finalScrollProgress = scrollProgress !== undefined ? scrollProgress : (session.max_scroll_progress || 0);
  const newMaxScroll = Math.max(session.max_scroll_progress || 0, finalScrollProgress);
  const isCompleted = session.completed || finalScrollProgress >= 90;

  console.log(`📖 Ending reading session: ${sessionId.slice(0, 8)}..., duration=${durationSeconds}s, scroll=${newMaxScroll.toFixed(1)}%, completed=${isCompleted}`);

  // Update session with end time and final stats
  const { error: updateError } = await supabaseAdmin
    .from('reading_sessions')
    .update({
      session_end: sessionEnd.toISOString(),
      reading_duration_seconds: durationSeconds,
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
      total_reading_time_seconds: (existingStats?.total_reading_time_seconds || 0) + durationSeconds,
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
      duration: durationSeconds,
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
