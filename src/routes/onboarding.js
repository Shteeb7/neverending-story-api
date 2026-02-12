const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { anthropic, openai } = require('../config/ai-clients');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /onboarding/start
 * Initialize voice conversation session for onboarding
 * Creates an ephemeral OpenAI Realtime session and returns credentials to client
 */
router.post('/start', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;

  console.log('🎙️ Creating OpenAI Realtime session for user:', userId);

  // Create ephemeral OpenAI Realtime session
  const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-realtime-preview-2024-12-17',
      voice: 'alloy'
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('OpenAI session creation failed:', error);
    throw new Error(`Failed to create OpenAI session: ${response.status}`);
  }

  const session = await response.json();

  console.log('✅ OpenAI Realtime session created:', session.id);
  console.log('   Full session object:', JSON.stringify(session, null, 2));
  console.log('   Client secret type:', typeof session.client_secret);

  // Extract the actual token value from the client_secret object
  // OpenAI returns: { client_secret: { value: "eph_...", expires_at: ... } }
  const secretValue = typeof session.client_secret === 'object'
    ? session.client_secret.value
    : session.client_secret;

  console.log('   Extracted token value (first 20 chars):', secretValue?.substring(0, 20));

  res.json({
    success: true,
    sessionId: session.id,
    clientSecret: secretValue,  // Return the actual token string, not the object
    expiresAt: session.expires_at,
    message: 'Voice session initialized'
  });
}));

/**
 * POST /onboarding/process-transcript
 * Process voice conversation transcript and extract user preferences
 */
router.post('/process-transcript', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { transcript, sessionId, preferences } = req.body;

  if (!transcript) {
    return res.status(400).json({
      success: false,
      error: 'Transcript is required'
    });
  }

  // Use preferences from iOS app (collected via OpenAI function call)
  // or fall back to mock data for testing
  const extractedData = preferences || {
    genres: ['fantasy', 'adventure'],
    themes: ['friendship', 'courage'],
    ageRange: '8-12',
    interests: ['dragons', 'magic', 'exploration'],
    specificRequests: 'Story about a young explorer'
  };

  console.log('💾 Storing user preferences:', extractedData);

  // Transform iOS preferences to match expected format
  const normalizedPreferences = {
    genres: extractedData.favoriteGenres || extractedData.genres || [],
    themes: extractedData.preferredThemes || extractedData.themes || [],
    mood: extractedData.mood || 'varied',
    dislikedElements: extractedData.dislikedElements || [],
    characterTypes: extractedData.characterTypes || 'varied',
    name: extractedData.name || 'Reader',
    ageRange: extractedData.ageRange || '8-12'
  };

  console.log('✅ Normalized preferences:', normalizedPreferences);

  // Store in database
  const { data, error } = await supabaseAdmin
    .from('user_preferences')
    .upsert({
      user_id: userId,
      preferences: normalizedPreferences,
      transcript: transcript,
      session_id: sessionId,
      updated_at: new Date().toISOString()
    });

  if (error) {
    throw new Error(`Failed to store preferences: ${error.message}`);
  }

  res.json({
    success: true,
    preferences: normalizedPreferences,
    message: 'Transcript processed successfully'
  });
}));

/**
 * POST /onboarding/generate-premises
 * Generate 3 story premises based on user preferences
 */
router.post('/generate-premises', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  console.log(`🎬 /generate-premises called for user: ${userId}`);

  // Fetch user preferences from database
  console.log('📊 Fetching user preferences from database...');
  const { data: userPrefs, error: prefsError } = await supabaseAdmin
    .from('user_preferences')
    .select('preferences')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false})
    .limit(1)
    .single();

  if (prefsError) {
    console.log('❌ Error fetching preferences:', prefsError);
    return res.status(400).json({
      success: false,
      error: `Failed to fetch preferences: ${prefsError.message}`
    });
  }

  if (!userPrefs) {
    console.log('❌ No user preferences found for user:', userId);
    return res.status(400).json({
      success: false,
      error: 'User preferences not found. Complete onboarding first.'
    });
  }

  console.log('✅ User preferences found:', userPrefs.preferences);

  // Call generation service
  console.log('🤖 Calling Claude API to generate premises...');
  const { generatePremises } = require('../services/generation');
  const { premises, premisesId } = await generatePremises(userId, userPrefs.preferences);
  console.log(`✅ Generated ${premises.length} premises with ID: ${premisesId}`);

  res.json({
    success: true,
    premises,
    premisesId,
    message: 'Story premises generated successfully'
  });
}));

/**
 * GET /onboarding/premises/:userId
 * Retrieve generated premises for a user
 */
router.get('/premises/:userId', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req.params;

  console.log('🔍 GET /premises/:userId - Authorization check:');
  console.log(`   req.userId (from token): "${req.userId}"`);
  console.log(`   userId (from URL): "${userId}"`);
  console.log(`   Strict match: ${req.userId === userId}`);
  console.log(`   Case-insensitive match: ${req.userId?.toLowerCase() === userId?.toLowerCase()}`);

  // Verify requesting user matches (case-insensitive UUID comparison)
  if (req.userId?.toLowerCase() !== userId?.toLowerCase()) {
    console.log('❌ Authorization FAILED - user IDs do not match');
    return res.status(403).json({
      success: false,
      error: 'Unauthorized access'
    });
  }

  console.log('✅ Authorization passed');

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

/**
 * POST /onboarding/complete
 * Mark user's onboarding as complete
 */
router.post('/complete', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;

  // Update user metadata in Supabase auth
  const { data, error } = await supabaseAdmin.auth.admin.updateUserById(
    userId,
    {
      user_metadata: {
        has_completed_onboarding: true
      }
    }
  );

  if (error) {
    throw new Error(`Failed to update user metadata: ${error.message}`);
  }

  res.json({
    success: true,
    message: 'Onboarding marked as complete'
  });
}));

module.exports = router;
