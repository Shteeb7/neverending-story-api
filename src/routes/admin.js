const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');
const {
  generateWritingIntelligenceSnapshot,
  generateWritingIntelligenceReport,
  logPromptAdjustment
} = require('../services/writing-intelligence');

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

/**
 * GET /admin/writing-intelligence
 * Generate and return a comprehensive writing intelligence report
 * Analyzes aggregate reader feedback patterns and recommends prompt adjustments
 */
router.get('/writing-intelligence', authenticateUser, asyncHandler(async (req, res) => {
  // TODO: In production, add admin role check here
  console.log('📊 Generating writing intelligence report for admin...');

  const result = await generateWritingIntelligenceReport();

  res.json(result);
}));

/**
 * POST /admin/writing-intelligence/snapshot
 * Trigger generation of a new writing intelligence snapshot
 * Aggregates all dimension feedback data and calculates distributions/metrics
 */
router.post('/writing-intelligence/snapshot', authenticateUser, asyncHandler(async (req, res) => {
  // TODO: In production, add admin role check here
  console.log('📊 Triggering writing intelligence snapshot generation...');

  const result = await generateWritingIntelligenceSnapshot();

  res.json(result);
}));

/**
 * POST /admin/writing-intelligence/log-adjustment
 * Log a manual prompt adjustment made based on intelligence report
 * Records what changed and why for future analysis
 */
router.post('/writing-intelligence/log-adjustment', authenticateUser, asyncHandler(async (req, res) => {
  // TODO: In production, add admin role check here
  const {
    adjustmentType,
    genre,
    description,
    previousValue,
    newValue,
    dataBasis,
    snapshotId
  } = req.body;

  // Validate required fields
  if (!adjustmentType || !description) {
    return res.status(400).json({
      success: false,
      error: 'adjustmentType and description are required'
    });
  }

  console.log('📝 Logging prompt adjustment:', description);

  const result = await logPromptAdjustment(
    adjustmentType,
    genre,
    description,
    previousValue,
    newValue,
    dataBasis,
    snapshotId,
    'manual' // appliedBy
  );

  res.json(result);
}));

/**
 * GET /admin/character-intelligence
 * Get character intelligence system health metrics
 * Shows ledger usage, voice review stats, callback utilization, and authenticity scores
 */
router.get('/character-intelligence', authenticateUser, asyncHandler(async (req, res) => {
  // TODO: In production, add admin role check here
  console.log('📚 Fetching character intelligence metrics...');

  // Voice review stats
  const { data: reviews } = await supabaseAdmin
    .from('character_voice_reviews')
    .select('review_data, flags_count, revision_applied, chapter_number');

  // Ledger stats
  const { data: ledgers } = await supabaseAdmin
    .from('character_ledger_entries')
    .select('story_id, chapter_number, token_count, callback_bank');

  // Calculate metrics
  const totalReviews = reviews?.length || 0;
  const revisionsApplied = reviews?.filter(r => r.revision_applied).length || 0;
  const revisionRate = totalReviews > 0 ? (revisionsApplied / totalReviews * 100).toFixed(1) : 0;

  // Average authenticity scores
  const allScores = [];
  for (const review of reviews || []) {
    for (const check of review.review_data?.voice_checks || []) {
      allScores.push(check.authenticity_score);
    }
  }
  const avgAuthenticity = allScores.length > 0
    ? (allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(2)
    : 'N/A';
  const passRate = allScores.length > 0
    ? (allScores.filter(s => s >= 0.85).length / allScores.length * 100).toFixed(1)
    : 'N/A';

  // Callback utilization
  const totalCallbacks = ledgers?.reduce((sum, l) => sum + (l.callback_bank?.length || 0), 0) || 0;
  const usedCallbacks = ledgers?.reduce((sum, l) =>
    sum + (l.callback_bank?.filter(cb => cb.status === 'used')?.length || 0), 0) || 0;
  const callbackUtilization = totalCallbacks > 0
    ? (usedCallbacks / totalCallbacks * 100).toFixed(1)
    : 'N/A';

  // Token usage
  const avgTokens = ledgers?.length > 0
    ? Math.round(ledgers.reduce((sum, l) => sum + (l.token_count || 0), 0) / ledgers.length)
    : 0;

  // Unique stories using the system
  const uniqueStories = new Set(ledgers?.map(l => l.story_id) || []).size;

  res.json({
    character_intelligence: {
      stories_tracked: uniqueStories,
      ledger_entries: ledgers?.length || 0,
      avg_token_count: avgTokens,
      voice_reviews: {
        total: totalReviews,
        revisions_applied: revisionsApplied,
        revision_rate: `${revisionRate}%`,
        avg_authenticity_score: avgAuthenticity,
        pass_rate_085: `${passRate}%`
      },
      callback_bank: {
        total_callbacks: totalCallbacks,
        used_callbacks: usedCallbacks,
        utilization_rate: `${callbackUtilization}%`
      }
    }
  });
}));

module.exports = router;
