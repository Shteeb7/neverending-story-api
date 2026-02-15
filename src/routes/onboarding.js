const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { anthropic, openai } = require('../config/ai-clients');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

// OpenAI Realtime API pricing (as of Feb 2026)
// Audio input: $0.06 per minute, Audio output: $0.24 per minute
// Text input: $5/1M tokens, Text output: $20/1M tokens
// We estimate based on transcript length since we don't have exact audio duration
const REALTIME_PRICING = {
  TEXT_INPUT_PER_MILLION: 5,
  TEXT_OUTPUT_PER_MILLION: 20,
  // Rough estimate: ~150 words = 200 tokens, ~1 minute of speech
  // Blended rate for audio + text: ~$0.15 per 200 tokens equivalent
  ESTIMATED_COST_PER_TOKEN: 0.00075  // $0.75 per 1000 tokens (conservative estimate)
};

/**
 * Log API cost for OpenAI Realtime voice session
 */
async function logVoiceCost(userId, operation, estimatedTokens, metadata = {}) {
  const cost = estimatedTokens * REALTIME_PRICING.ESTIMATED_COST_PER_TOKEN;

  try {
    await supabaseAdmin
      .from('api_costs')
      .insert({
        user_id: userId,
        story_id: null,  // Voice onboarding isn't tied to a specific story yet
        provider: 'openai',
        model: process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-mini-realtime-preview-2024-12-17',
        operation,
        input_tokens: Math.floor(estimatedTokens * 0.4),  // Rough split: 40% input (user speaking)
        output_tokens: Math.floor(estimatedTokens * 0.6), // 60% output (AI speaking)
        total_tokens: estimatedTokens,
        cost,
        metadata,
        created_at: new Date().toISOString()
      });
  } catch (error) {
    // Don't throw on cost logging failures - log to console instead
    console.error('Failed to log voice session cost:', error);
  }
}

/**
 * Helper function to normalize discoveryTolerance to numeric value
 * "low" (comfort-seeker) = 0.2
 * "medium" (balanced) = 0.5
 * "high" (adventurer) = 0.8
 */
function normalizeDiscoveryTolerance(tolerance) {
  const mapping = {
    'low': 0.2,
    'medium': 0.5,
    'high': 0.8
  };
  return mapping[tolerance] || 0.5; // default to medium
}

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
      model: process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-mini-realtime-preview-2024-12-17',
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
    ageRange: extractedData.ageRange || 'adult', // Default to adult, not child

    // New experience-mining fields
    emotionalDrivers: extractedData.emotionalDrivers || [],
    belovedStories: extractedData.belovedStories || [],
    readingMotivation: extractedData.readingMotivation || '',
    discoveryTolerance: normalizeDiscoveryTolerance(extractedData.discoveryTolerance),
    pacePreference: extractedData.pacePreference || 'varied'
  };

  // Log warning if ageRange wasn't provided
  if (!extractedData.ageRange) {
    console.log('⚠️ WARNING: ageRange not provided by iOS, defaulting to "adult"');
  }

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

  // Log cost for voice session (estimate tokens from transcript length)
  // Rough estimate: 1 token ≈ 0.75 words, so words / 0.75 = tokens
  const estimatedTokens = Math.ceil(transcript.split(/\s+/).length / 0.75);
  await logVoiceCost(userId, 'voice_onboarding', estimatedTokens, {
    sessionId,
    transcriptLength: transcript.length,
    estimatedTokens
  });

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
      error: 'Creative instincts not yet captured. Complete onboarding first.'
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
    message: 'Story premises conjured successfully'
  });
}));

/**
 * GET /onboarding/premises/:userId
 * Retrieve UNUSED premises for a user (filters out already selected premises)
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

  // Step 1: Fetch ALL premise sets for this user (not just latest)
  const { data: premiseSets, error: premisesError } = await supabaseAdmin
    .from('story_premises')
    .select('id, premises, generated_at')
    .eq('user_id', userId)
    .order('generated_at', { ascending: false });

  if (premisesError) {
    throw new Error(`Failed to retrieve premises: ${premisesError.message}`);
  }

  if (!premiseSets || premiseSets.length === 0) {
    console.log('📭 No premises found for user');
    return res.json({
      success: true,
      premises: [],
      allPremisesUsed: false,
      needsNewInterview: true
    });
  }

  // Step 2: Get all stories created by this user to find which premises were used
  const { data: stories, error: storiesError } = await supabaseAdmin
    .from('stories')
    .select('id, title, premise_id')
    .eq('user_id', userId);

  if (storiesError) {
    console.log('⚠️ Error fetching stories:', storiesError);
    // Continue anyway - if we can't fetch stories, show all premises
  }

  // Step 3: Build a set of used premise IDs from stories
  // Note: Stories store the parent story_premises record ID, but we need individual premise UUIDs
  // We need to look at which individual premises within each set have been used
  const usedPremiseIds = new Set();

  if (stories && stories.length > 0) {
    console.log(`📚 User has ${stories.length} existing stories`);

    // For each story, find which specific premise was used
    for (const story of stories) {
      // Search through all premise sets to find matching premises by title
      for (const premiseSet of premiseSets) {
        if (Array.isArray(premiseSet.premises)) {
          const matchedPremise = premiseSet.premises.find(p => p.title === story.title);
          if (matchedPremise) {
            usedPremiseIds.add(matchedPremise.id);
            console.log(`   ✓ Premise used: "${matchedPremise.title}" (${matchedPremise.id})`);
          }
        }
      }
    }
  }

  console.log(`🔍 Found ${usedPremiseIds.size} used premises`);

  // Step 4: Collect all unused premises from ALL premise sets
  const allUnusedPremises = [];
  let mostRecentPremisesId = null;

  for (const premiseSet of premiseSets) {
    if (Array.isArray(premiseSet.premises)) {
      const unusedInThisSet = premiseSet.premises.filter(p => !usedPremiseIds.has(p.id));
      if (unusedInThisSet.length > 0 && !mostRecentPremisesId) {
        // Store the ID of the most recent set with unused premises
        mostRecentPremisesId = premiseSet.id;
      }
      allUnusedPremises.push(...unusedInThisSet);
    }
  }

  console.log(`✅ Returning ${allUnusedPremises.length} unused premises`);
  console.log(`   Most recent premises ID: ${mostRecentPremisesId}`);

  res.json({
    success: true,
    premises: allUnusedPremises,
    allPremisesUsed: allUnusedPremises.length === 0,
    needsNewInterview: allUnusedPremises.length === 0,
    premisesId: mostRecentPremisesId
  });
}));

/**
 * GET /onboarding/user-preferences/:userId
 * Retrieve user preferences for voice session context
 */
router.get('/user-preferences/:userId', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req.params;

  // Verify requesting user matches
  if (req.userId?.toLowerCase() !== userId?.toLowerCase()) {
    console.log('❌ Authorization FAILED - user IDs do not match');
    return res.status(403).json({
      success: false,
      error: 'Unauthorized access'
    });
  }

  // Fetch user preferences from database
  const { data: userPrefs, error: prefsError } = await supabaseAdmin
    .from('user_preferences')
    .select('preferences')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (prefsError) {
    throw new Error(`Failed to fetch preferences: ${prefsError.message}`);
  }

  // Fetch recently discarded premises (most recent discard event)
  const { data: recentDiscard } = await supabaseAdmin
    .from('premise_discards')
    .select('discarded_premises')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  res.json({
    success: true,
    preferences: userPrefs?.preferences || null,
    recentlyDiscarded: recentDiscard?.discarded_premises || []
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

/**
 * POST /onboarding/confirm-name
 * Confirms and optionally updates the user's name after onboarding
 */
router.post('/confirm-name', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { name } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Name is required and must be a non-empty string'
    });
  }

  const confirmedName = name.trim();

  // Fetch current preferences to merge with new name
  const { data: currentPrefs } = await supabaseAdmin
    .from('user_preferences')
    .select('preferences')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Merge new name into existing preferences
  const updatedPreferences = {
    ...(currentPrefs?.preferences || {}),
    name: confirmedName
  };

  // Update preferences with merged object and set name_confirmed flag
  const { error: updateError } = await supabaseAdmin
    .from('user_preferences')
    .update({
      preferences: updatedPreferences,
      name_confirmed: true
    })
    .eq('user_id', userId);

  if (updateError) {
    throw new Error(`Failed to update name: ${updateError.message}`);
  }

  // Find all stories missing covers for this user
  const { data: storiesNeedingCovers } = await supabaseAdmin
    .from('stories')
    .select('id, title')
    .eq('user_id', userId)
    .is('cover_image_url', null);

  // Fire cover generation for each (non-blocking)
  if (storiesNeedingCovers && storiesNeedingCovers.length > 0) {
    const { generateBookCover } = require('../services/cover-generation');
    for (const story of storiesNeedingCovers) {
      generateBookCover(story.id, userId).catch(err =>
        console.error(`❌ Cover gen failed for "${story.title}":`, err.message)
      );
    }
    console.log(`🎨 Triggered cover generation for ${storiesNeedingCovers.length} stories after name confirmation`);
  }

  res.json({
    success: true,
    name: confirmedName
  });
}));

/**
 * POST /onboarding/discard-premises
 * Log discarded premises when user chooses "Talk to Prospero" without selecting
 */
router.post('/discard-premises', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { premisesId } = req.body;

  if (!premisesId) {
    return res.status(400).json({
      success: false,
      error: 'premisesId is required'
    });
  }

  console.log(`🗑️ Discarding premises for user ${userId}, premises set: ${premisesId}`);

  // Fetch the story_premises record
  const { data: premiseSet, error: fetchError } = await supabaseAdmin
    .from('story_premises')
    .select('premises')
    .eq('id', premisesId)
    .eq('user_id', userId)
    .single();

  if (fetchError || !premiseSet) {
    return res.status(404).json({
      success: false,
      error: 'Premise set not found'
    });
  }

  // Get all stories created by this user to identify which premises were used
  const { data: stories } = await supabaseAdmin
    .from('stories')
    .select('title')
    .eq('user_id', userId);

  const usedTitles = new Set(stories?.map(s => s.title) || []);

  // Filter out premises that were already used (selected)
  const premises = premiseSet.premises || [];
  const discardedPremises = premises.filter(p => !usedTitles.has(p.title));

  console.log(`   Total premises in set: ${premises.length}`);
  console.log(`   Already used: ${premises.length - discardedPremises.length}`);
  console.log(`   Discarded: ${discardedPremises.length}`);

  // Log the discarded premises
  if (discardedPremises.length > 0) {
    const { error: insertError } = await supabaseAdmin
      .from('premise_discards')
      .insert({
        user_id: userId,
        premises_id: premisesId,
        discarded_premises: discardedPremises,
        created_at: new Date().toISOString()
      });

    if (insertError) {
      console.error('Failed to log premise discards:', insertError);
      // Don't throw - this is a learning signal, not critical
    }
  }

  // Update the story_premises record status to 'discarded'
  const { error: updateError } = await supabaseAdmin
    .from('story_premises')
    .update({ status: 'discarded' })
    .eq('id', premisesId);

  if (updateError) {
    console.error('Failed to update premise set status:', updateError);
  }

  res.json({
    success: true,
    discardedCount: discardedPremises.length
  });
}));

module.exports = router;
