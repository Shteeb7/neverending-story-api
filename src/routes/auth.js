const express = require('express');
const { supabaseClient, supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /auth/google
 * Handle Google OAuth authentication
 */
router.post('/google', asyncHandler(async (req, res) => {
  const { idToken, accessToken } = req.body;

  if (!idToken && !accessToken) {
    return res.status(400).json({
      success: false,
      error: 'Missing idToken or accessToken'
    });
  }

  // Sign in with Google OAuth token
  const { data, error } = await supabaseClient.auth.signInWithIdToken({
    provider: 'google',
    token: idToken || accessToken,
  });

  if (error) {
    return res.status(401).json({
      success: false,
      error: error.message
    });
  }

  res.json({
    success: true,
    user: data.user,
    session: data.session
  });
}));

/**
 * POST /auth/apple
 * Handle Apple OAuth authentication
 */
router.post('/apple', asyncHandler(async (req, res) => {
  const { idToken, nonce } = req.body;

  if (!idToken) {
    return res.status(400).json({
      success: false,
      error: 'Missing idToken'
    });
  }

  // Sign in with Apple OAuth token
  const { data, error } = await supabaseClient.auth.signInWithIdToken({
    provider: 'apple',
    token: idToken,
    nonce: nonce
  });

  if (error) {
    return res.status(401).json({
      success: false,
      error: error.message
    });
  }

  res.json({
    success: true,
    user: data.user,
    session: data.session
  });
}));

/**
 * GET /auth/session
 * Validate current session token
 */
router.get('/session', authenticateUser, asyncHandler(async (req, res) => {
  res.json({
    success: true,
    user: req.user,
    userId: req.userId,
    message: 'Session is valid'
  });
}));

module.exports = router;
