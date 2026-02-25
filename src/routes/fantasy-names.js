/**
 * Fantasy Names Routes
 *
 * POST /api/fantasy-names/generate - Generate 3 fantasy name options
 * POST /api/fantasy-names/select - Select a fantasy name
 */

const express = require('express');
const router = express.Router();
const { generateFantasyName, selectFantasyName } = require('../services/fantasy-names');
const { authenticateUser } = require('../middleware/auth');

/**
 * POST /api/fantasy-names/generate
 * Generate 3 fantasy name options for the authenticated user
 *
 * Rate limit: 1 generation per 7 days per user
 *
 * Response 200:
 * {
 *   options: ["Thornwick", "Amberly Dusk", "Fable Wren"]
 * }
 *
 * Response 429 (rate limit exceeded):
 * {
 *   error: "Rate limit exceeded",
 *   retry_after: 518400 // seconds remaining
 * }
 */
router.post('/generate', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;

    console.log(`🎭 [Fantasy Names] Generate request from user ${userId}`);

    const result = await generateFantasyName(userId);

    if (!result.success) {
      if (result.error === 'Rate limit exceeded') {
        return res.status(429).json({
          error: result.error,
          retry_after: result.retry_after
        });
      }

      return res.status(500).json({
        error: result.error || 'Failed to generate fantasy names'
      });
    }

    res.json({ options: result.options });

  } catch (error) {
    console.error('❌ [Fantasy Names] Generate endpoint error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/fantasy-names/select
 * Select a fantasy name for the authenticated user
 *
 * Body:
 * {
 *   name: "Thornwick"
 * }
 *
 * Response 200:
 * {
 *   display_name: "Thornwick"
 * }
 *
 * Response 400:
 * {
 *   error: "This name is already taken"
 * }
 */
router.post('/select', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        error: 'Name is required'
      });
    }

    console.log(`🎭 [Fantasy Names] Select request from user ${userId}: "${name}"`);

    const result = await selectFantasyName(userId, name);

    if (!result.success) {
      return res.status(400).json({
        error: result.error || 'Failed to select fantasy name'
      });
    }

    res.json({ display_name: result.display_name });

  } catch (error) {
    console.error('❌ [Fantasy Names] Select endpoint error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

module.exports = router;
