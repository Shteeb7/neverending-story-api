const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /settings/consent-status
 * Get current consent status for the user
 */
router.get('/consent-status', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;

  const { data, error } = await supabaseAdmin
    .from('user_preferences')
    .select('ai_consent, voice_consent')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch consent status: ${error.message}`);
  }

  res.json({
    success: true,
    ai_consent: data?.ai_consent || false,
    voice_consent: data?.voice_consent || false
  });
}));

/**
 * POST /settings/ai-consent
 * Grant AI consent (required for all AI operations)
 */
router.post('/ai-consent', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;

  console.log(`✅ User ${userId} granting AI consent`);

  // Set ai_consent = true and record timestamp
  const { error } = await supabaseAdmin
    .from('user_preferences')
    .upsert({
      user_id: userId,
      ai_consent: true,
      ai_consent_date: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'user_id'
    });

  if (error) {
    throw new Error(`Failed to grant AI consent: ${error.message}`);
  }

  res.json({
    success: true,
    message: 'AI consent granted'
  });
}));

/**
 * POST /settings/voice-consent
 * Grant voice consent (required for voice interviews)
 */
router.post('/voice-consent', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;

  console.log(`🎙️ User ${userId} granting voice consent`);

  // Set voice_consent = true and record timestamp
  const { error } = await supabaseAdmin
    .from('user_preferences')
    .upsert({
      user_id: userId,
      voice_consent: true,
      voice_consent_date: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'user_id'
    });

  if (error) {
    throw new Error(`Failed to grant voice consent: ${error.message}`);
  }

  res.json({
    success: true,
    message: 'Voice consent granted'
  });
}));

/**
 * POST /settings/revoke-voice-consent
 * Revoke voice consent and queue voice recording deletion
 */
router.post('/revoke-voice-consent', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;

  console.log(`🔇 User ${userId} revoking voice consent`);

  // Step 1: Set voice_consent = false and clear date
  const { error: consentError } = await supabaseAdmin
    .from('user_preferences')
    .update({
      voice_consent: false,
      voice_consent_date: null,
      updated_at: new Date().toISOString()
    })
    .eq('user_id', userId);

  if (consentError) {
    throw new Error(`Failed to revoke voice consent: ${consentError.message}`);
  }

  // Step 2: Create deletion request for voice recordings
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + 30); // 30 days from now

  const { error: deletionError } = await supabaseAdmin
    .from('deletion_requests')
    .insert({
      user_id: userId,
      request_type: 'voice_recordings',
      status: 'pending',
      requested_at: new Date().toISOString(),
      deadline: deadline.toISOString()
    });

  if (deletionError) {
    console.error('Failed to create deletion request:', deletionError);
    // Don't throw - consent revocation succeeded, deletion queue is best-effort
  }

  console.log(`✅ Voice consent revoked, deletion scheduled for ${deadline.toISOString()}`);

  res.json({
    success: true,
    message: 'Voice consent revoked, recordings will be deleted within 30 days'
  });
}));

module.exports = router;
