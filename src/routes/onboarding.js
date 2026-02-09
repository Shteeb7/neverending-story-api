const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { anthropic, openai } = require('../config/ai-clients');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /onboarding/start
 * Initialize voice conversation session for onboarding
 */
router.post('/start', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;

  // TODO: Initialize OpenAI Realtime API session
  // For now, return mock session data
  const sessionId = `session_${Date.now()}_${userId}`;

  res.json({
    success: true,
    sessionId,
    message: 'Voice session initialized',
    // In production, return WebSocket URL or session token for OpenAI Realtime API
    websocketUrl: `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01`
  });
}));

/**
 * POST /onboarding/process-transcript
 * Process voice conversation transcript and extract user preferences
 */
router.post('/process-transcript', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { transcript, sessionId } = req.body;

  if (!transcript) {
    return res.status(400).json({
      success: false,
      error: 'Transcript is required'
    });
  }

  // TODO: Use Claude to analyze transcript and extract:
  // - Reading preferences (genres, themes)
  // - Age/reading level
  // - Interests and hobbies
  // - Any specific story requests

  // Mock extracted data for now
  const extractedData = {
    genres: ['fantasy', 'adventure'],
    themes: ['friendship', 'courage'],
    ageRange: '8-12',
    interests: ['dragons', 'magic', 'exploration'],
    specificRequests: 'Story about a young explorer'
  };

  // Store in database
  const { data, error } = await supabaseAdmin
    .from('user_preferences')
    .upsert({
      user_id: userId,
      preferences: extractedData,
      transcript: transcript,
      session_id: sessionId,
      updated_at: new Date().toISOString()
    });

  if (error) {
    throw new Error(`Failed to store preferences: ${error.message}`);
  }

  res.json({
    success: true,
    preferences: extractedData,
    message: 'Transcript processed successfully'
  });
}));

/**
 * POST /onboarding/generate-premises
 * Generate 3 story premises based on user preferences
 */
router.post('/generate-premises', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { preferences } = req.body;

  // TODO: Use Claude to generate 3 unique story premises
  // Based on user preferences from onboarding

  // Mock premises for now
  const premises = [
    {
      id: 1,
      title: 'The Dragon\'s Apprentice',
      description: 'A young explorer discovers a hidden valley where dragons teach humans the ancient art of sky-sailing.',
      genre: 'fantasy',
      themes: ['adventure', 'friendship', 'discovery']
    },
    {
      id: 2,
      title: 'The Courage Stone',
      description: 'A shy child finds a magical stone that grants bravery, but must learn that true courage comes from within.',
      genre: 'fantasy',
      themes: ['courage', 'self-discovery', 'magic']
    },
    {
      id: 3,
      title: 'Explorer\'s Map',
      description: 'An enchanted map leads three friends on a quest to find a legendary treasure hidden in the Whispering Woods.',
      genre: 'adventure',
      themes: ['friendship', 'exploration', 'mystery']
    }
  ];

  // Store premises in database
  const { data, error } = await supabaseAdmin
    .from('story_premises')
    .insert({
      user_id: userId,
      premises: premises,
      generated_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to store premises: ${error.message}`);
  }

  res.json({
    success: true,
    premises,
    premisesId: data?.id
  });
}));

/**
 * GET /onboarding/premises/:userId
 * Retrieve generated premises for a user
 */
router.get('/premises/:userId', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req.params;

  // Verify requesting user matches or is admin
  if (req.userId !== userId) {
    return res.status(403).json({
      success: false,
      error: 'Unauthorized access'
    });
  }

  const { data, error } = await supabaseAdmin
    .from('story_premises')
    .select('*')
    .eq('user_id', userId)
    .order('generated_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    throw new Error(`Failed to retrieve premises: ${error.message}`);
  }

  res.json({
    success: true,
    premises: data?.premises || []
  });
}));

module.exports = router;
