const { supabaseAdmin } = require('../config/supabase');

/**
 * Check if user has granted AI consent
 * Required for all AI-related operations (chat, story generation, etc.)
 */
async function requireAIConsent(userId) {
  const { data } = await supabaseAdmin
    .from('user_preferences')
    .select('ai_consent')
    .eq('user_id', userId)
    .maybeSingle();

  if (!data?.ai_consent) {
    const error = new Error('AI consent is required to use this feature');
    error.code = 'AI_CONSENT_REQUIRED';
    error.statusCode = 403;
    throw error;
  }
}

/**
 * Check if user has granted voice consent
 * Required for voice interview operations
 * Also requires AI consent (voice is a superset)
 */
async function requireVoiceConsent(userId) {
  await requireAIConsent(userId); // Voice requires AI consent too

  const { data } = await supabaseAdmin
    .from('user_preferences')
    .select('voice_consent')
    .eq('user_id', userId)
    .maybeSingle();

  if (!data?.voice_consent) {
    const error = new Error('Voice consent is required to use voice features');
    error.code = 'VOICE_CONSENT_REQUIRED';
    error.statusCode = 403;
    throw error;
  }
}

/**
 * Express middleware wrapper for AI consent check
 * Use: router.post('/endpoint', authenticateUser, requireAIConsentMiddleware, ...)
 */
async function requireAIConsentMiddleware(req, res, next) {
  try {
    await requireAIConsent(req.userId);
    next();
  } catch (error) {
    if (error.code === 'AI_CONSENT_REQUIRED') {
      return res.status(403).json({
        success: false,
        error: error.message,
        code: 'AI_CONSENT_REQUIRED'
      });
    }
    next(error);
  }
}

/**
 * Express middleware wrapper for voice consent check
 * Use: router.post('/endpoint', authenticateUser, requireVoiceConsentMiddleware, ...)
 */
async function requireVoiceConsentMiddleware(req, res, next) {
  try {
    await requireVoiceConsent(req.userId);
    next();
  } catch (error) {
    if (error.code === 'AI_CONSENT_REQUIRED' || error.code === 'VOICE_CONSENT_REQUIRED') {
      return res.status(403).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }
    next(error);
  }
}

module.exports = {
  requireAIConsent,
  requireVoiceConsent,
  requireAIConsentMiddleware,
  requireVoiceConsentMiddleware
};
