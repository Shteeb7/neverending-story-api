const express = require('express');
const { buildCodebaseContext } = require('../services/codebase-context');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');
const { isAdmin } = require('../config/admin');

const router = express.Router();

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
