const express = require('express');
const { buildCodebaseContext } = require('../services/codebase-context');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

// Admin email list (same as bug-reports.js)
const ADMIN_EMAILS = [
  'steven.labrum@gmail.com'
];

/**
 * Check if a user is an admin based on their email
 */
function isAdmin(user) {
  return user && user.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
}

/**
 * POST /admin/build-context
 * Build codebase context package and upload to Supabase Storage
 * Admin-only endpoint
 */
router.post('/admin/build-context', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;

  // Check admin authorization
  if (!isAdmin(req.user)) {
    return res.status(403).json({
      success: false,
      error: 'Unauthorized - admin access required'
    });
  }

  console.log(`📦 Admin ${req.user.email} triggered context package build`);

  try {
    const result = await buildCodebaseContext();

    res.json(result);
  } catch (error) {
    console.error('❌ Failed to build context package:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to build context package'
    });
  }
}));

module.exports = router;
