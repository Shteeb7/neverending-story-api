const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { openai } = require('../config/ai-clients');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /feedback/quick-tap
 * Record abandonment feedback (quick tap when user stops reading)
 */
router.post('/quick-tap', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { storyId, chapterId, reason, timestamp } = req.body;

  if (!storyId) {
    return res.status(400).json({
      success: false,
      error: 'storyId is required'
    });
  }

  // Store quick feedback
  const { data, error } = await supabaseAdmin
    .from('feedback')
    .insert({
      user_id: userId,
      story_id: storyId,
      chapter_id: chapterId,
      feedback_type: 'quick_tap',
      reason,
      timestamp: timestamp || new Date().toISOString(),
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to record feedback: ${error.message}`);
  }

  res.json({
    success: true,
    feedbackId: data.id,
    message: 'Feedback recorded'
  });
}));

/**
 * POST /feedback/voice-session
 * Start voice conversation session for arc-complete story feedback
 */
router.post('/voice-session', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { storyId } = req.body;

  if (!storyId) {
    return res.status(400).json({
      success: false,
      error: 'storyId is required'
    });
  }

  // TODO: Initialize OpenAI Realtime API session for feedback conversation
  const sessionId = `feedback_${Date.now()}_${userId}_${storyId}`;

  // Store session record
  const { data, error } = await supabaseAdmin
    .from('feedback_sessions')
    .insert({
      user_id: userId,
      story_id: storyId,
      session_id: sessionId,
      status: 'active',
      started_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create feedback session: ${error.message}`);
  }

  res.json({
    success: true,
    sessionId,
    feedbackSessionId: data.id,
    message: 'Feedback session initialized',
    websocketUrl: `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01`
  });
}));

/**
 * POST /feedback/process-conversation
 * Process feedback conversation and extract insights
 */
router.post('/process-conversation', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { sessionId, transcript, storyId } = req.body;

  if (!transcript || !storyId) {
    return res.status(400).json({
      success: false,
      error: 'transcript and storyId are required'
    });
  }

  // TODO: Use Claude to analyze feedback conversation and extract:
  // - What user liked/disliked
  // - Specific plot points or characters mentioned
  // - Suggestions for improvement
  // - Emotional response to the story

  // Mock extracted insights for now
  const insights = {
    liked: ['character development', 'plot twists', 'descriptive language'],
    disliked: ['pacing in chapter 3', 'predictable ending'],
    suggestions: ['more dialogue', 'deeper backstory for antagonist'],
    emotionalResponse: 'positive',
    overallSatisfaction: 8
  };

  // Store processed feedback
  const { data, error } = await supabaseAdmin
    .from('feedback')
    .insert({
      user_id: userId,
      story_id: storyId,
      feedback_type: 'voice_conversation',
      session_id: sessionId,
      transcript,
      insights,
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to store feedback: ${error.message}`);
  }

  // Update feedback session status
  await supabaseAdmin
    .from('feedback_sessions')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString()
    })
    .eq('session_id', sessionId);

  res.json({
    success: true,
    feedbackId: data.id,
    insights,
    message: 'Feedback processed successfully'
  });
}));

module.exports = router;
