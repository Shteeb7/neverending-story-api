const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /admin/costs/:userId
 * Get cost breakdown for a user's AI API usage
 */
router.get('/costs/:userId', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req.params;

  // In production, add admin role check here
  // For now, users can only see their own costs
  if (req.userId !== userId) {
    return res.status(403).json({
      success: false,
      error: 'Unauthorized access'
    });
  }

  // TODO: Query actual cost tracking table
  // This should track:
  // - Claude API usage (tokens, cost)
  // - OpenAI API usage (tokens, cost)
  // - Breakdown by story/chapter
  // - Timestamp and cumulative costs

  const { data: costs, error } = await supabaseAdmin
    .from('api_costs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    // If table doesn't exist yet, return mock data
    return res.json({
      success: true,
      costs: [],
      summary: {
        totalCost: 0,
        claudeCost: 0,
        openaiCost: 0,
        totalTokens: 0
      },
      message: 'Cost tracking not yet implemented'
    });
  }

  // Calculate summary
  const summary = {
    totalCost: costs.reduce((sum, c) => sum + (c.cost || 0), 0),
    claudeCost: costs.filter(c => c.provider === 'claude').reduce((sum, c) => sum + (c.cost || 0), 0),
    openaiCost: costs.filter(c => c.provider === 'openai').reduce((sum, c) => sum + (c.cost || 0), 0),
    totalTokens: costs.reduce((sum, c) => sum + (c.tokens || 0), 0)
  };

  res.json({
    success: true,
    costs,
    summary
  });
}));

/**
 * GET /admin/generation-metrics
 * Track story generation performance metrics
 */
router.get('/generation-metrics', authenticateUser, asyncHandler(async (req, res) => {
  // In production, add admin role check here

  // TODO: Query generation metrics:
  // - Average generation time per chapter
  // - Success/failure rates
  // - Token usage statistics
  // - User engagement metrics

  const { data: metrics, error } = await supabaseAdmin
    .from('generation_metrics')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    // If table doesn't exist yet, return mock data
    return res.json({
      success: true,
      metrics: {
        avgGenerationTime: 0,
        successRate: 0,
        totalGenerations: 0,
        avgTokensPerChapter: 0
      },
      message: 'Metrics tracking not yet implemented'
    });
  }

  res.json({
    success: true,
    metrics: metrics || []
  });
}));

/**
 * GET /admin/health
 * Health check endpoint for monitoring
 */
router.get('/health', asyncHandler(async (req, res) => {
  // Check database connectivity
  const { error: dbError } = await supabaseAdmin
    .from('stories')
    .select('id')
    .limit(1);

  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      database: dbError ? 'unhealthy' : 'healthy',
      api: 'healthy'
    }
  };

  if (dbError) {
    health.status = 'degraded';
  }

  res.json(health);
}));

module.exports = router;
