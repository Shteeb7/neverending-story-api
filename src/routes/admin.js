const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');
const {
  generateWritingIntelligenceSnapshot,
  generateWritingIntelligenceReport,
  logPromptAdjustment
} = require('../services/writing-intelligence');

const {
  computeDashboard,
  getStoryQualityDetail,
  computeStoryQualitySnapshot
} = require('../services/quality-intelligence');

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
 * GET /admin/reading-analytics
 * Get scroll-based reading analytics
 * Shows per-user reading speed, active vs idle time, and fleet averages
 */
router.get('/reading-analytics', authenticateUser, asyncHandler(async (req, res) => {
  // TODO: In production, add admin role check here
  const { storyId, userId } = req.query;

  let query = supabaseAdmin
    .from('reading_sessions')
    .select('user_id, story_id, chapter_number, reading_duration_seconds, active_reading_seconds, idle_seconds, estimated_reading_speed, max_scroll_progress, completed')
    .not('active_reading_seconds', 'is', null);

  if (storyId) query = query.eq('story_id', storyId);
  if (userId) query = query.eq('user_id', userId);

  const { data, error } = await query.order('session_start', { ascending: false }).limit(500);

  if (error) throw new Error(`Failed to fetch reading analytics: ${error.message}`);

  // Aggregate by user
  const byUser = {};
  for (const row of data) {
    if (!byUser[row.user_id]) byUser[row.user_id] = { sessions: [], speeds: [] };
    byUser[row.user_id].sessions.push(row);
    if (row.estimated_reading_speed) byUser[row.user_id].speeds.push(row.estimated_reading_speed);
  }

  const userSummaries = Object.entries(byUser).map(([uid, d]) => ({
    user_id: uid,
    total_active_seconds: d.sessions.reduce((s, r) => s + (r.active_reading_seconds || 0), 0),
    total_wall_seconds: d.sessions.reduce((s, r) => s + (r.reading_duration_seconds || 0), 0),
    total_idle_seconds: d.sessions.reduce((s, r) => s + (r.idle_seconds || 0), 0),
    avg_reading_speed: d.speeds.length ? d.speeds.reduce((a, b) => a + b, 0) / d.speeds.length : null,
    session_count: d.sessions.length
  }));

  res.json({
    success: true,
    analytics: {
      sessions_analyzed: data.length,
      user_summaries: userSummaries,
      fleet_avg_speed: userSummaries.filter(u => u.avg_reading_speed).reduce((s, u) => s + u.avg_reading_speed, 0) / (userSummaries.filter(u => u.avg_reading_speed).length || 1)
    }
  });
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

/**
 * GET /admin/quality/dashboard
 * Compute fleet-level quality metrics across multiple stories
 * Returns aggregated quality scores, dimensions, costs, and feature flag distribution
 */
router.get('/quality/dashboard', authenticateUser, asyncHandler(async (req, res) => {
  // Check admin role
  if (req.user?.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }

  const { since, limit } = req.query;
  console.log(`📊 Computing quality dashboard (since=${since || 'all'}, limit=${limit || 20})`);

  const options = {};
  if (since) options.since = since;
  if (limit) options.limit = parseInt(limit, 10);

  const dashboard = await computeDashboard(options);

  res.json({
    success: true,
    dashboard
  });
}));

/**
 * GET /admin/quality/story/:storyId
 * Get detailed quality breakdown for a single story
 * Returns per-chapter quality, voice authenticity, and quality trend
 */
router.get('/quality/story/:storyId', authenticateUser, asyncHandler(async (req, res) => {
  // Check admin role
  if (req.user?.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }

  const { storyId } = req.params;
  console.log(`📊 Fetching quality detail for story: ${storyId}`);

  const detail = await getStoryQualityDetail(storyId);

  res.json({
    success: true,
    detail
  });
}));

/**
 * POST /admin/quality/snapshot
 * Force-compute and store a quality snapshot for a specific story
 * Useful for manually triggering snapshot creation outside normal flow
 */
router.post('/quality/snapshot', authenticateUser, asyncHandler(async (req, res) => {
  // Check admin role
  if (req.user?.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }

  const { storyId } = req.body;

  if (!storyId) {
    return res.status(400).json({
      success: false,
      error: 'storyId is required'
    });
  }

  console.log(`📊 Force-computing snapshot for story: ${storyId}`);

  const snapshot = await computeStoryQualitySnapshot(storyId);

  res.json({
    success: true,
    snapshot
  });
}));

/**
 * POST /admin/trigger-sequel
 * Admin-only endpoint to manually trigger sequel generation for a user.
 * Used when the iOS callback chain fails and a user's interview data
 * is already stored server-side but the sequel was never created.
 *
 * Auth: Requires SUPABASE_SERVICE_KEY in x-admin-key header.
 * Body: { storyId, userId, userPreferences (optional) }
 */
router.post('/trigger-sequel', asyncHandler(async (req, res) => {
  // Authenticate with service key (not user JWT)
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.SUPABASE_SERVICE_KEY) {
    return res.status(403).json({
      success: false,
      error: 'Invalid admin key'
    });
  }

  const { storyId, userId, userPreferences } = req.body;

  if (!storyId || !userId) {
    return res.status(400).json({
      success: false,
      error: 'storyId and userId are required'
    });
  }

  console.log(`🔧 [Admin] Triggering sequel generation for story ${storyId}, user ${userId}`);

  // Verify story exists and belongs to user
  const { data: book1Story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .eq('user_id', userId)
    .single();

  if (storyError || !book1Story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found or does not belong to user'
    });
  }

  // Check chapter count
  const { data: countData } = await supabaseAdmin
    .from('chapters')
    .select('chapter_number')
    .eq('story_id', storyId);
  const chapterCount = new Set(countData?.map(c => c.chapter_number)).size;

  if (chapterCount < 12) {
    return res.status(400).json({
      success: false,
      error: `Book 1 only has ${chapterCount} chapters — needs 12 for sequel`
    });
  }

  // Check if a sequel already exists
  const { data: existingSequel } = await supabaseAdmin
    .from('stories')
    .select('id, title, status')
    .eq('parent_story_id', storyId)
    .maybeSingle();

  if (existingSequel) {
    return res.status(409).json({
      success: false,
      error: `Sequel already exists: "${existingSequel.title}" (${existingSequel.status})`,
      sequelId: existingSequel.id
    });
  }

  // Generate series_id if needed
  let seriesId = book1Story.series_id;

  if (!seriesId) {
    const { generateSeriesName } = require('../services/generation');

    const { data: book1Bible } = await supabaseAdmin
      .from('story_bibles')
      .select('title, themes, central_conflict, key_locations, characters')
      .eq('story_id', storyId)
      .maybeSingle();

    const seriesName = await generateSeriesName(book1Story.title, book1Story.genre, book1Bible);

    const { data: seriesRecord, error: seriesError } = await supabaseAdmin
      .from('series')
      .insert({
        name: seriesName,
        user_id: userId
      })
      .select()
      .single();

    if (seriesError) {
      throw new Error(`Failed to create series: ${seriesError.message}`);
    }

    seriesId = seriesRecord.id;

    await supabaseAdmin
      .from('stories')
      .update({ series_id: seriesId, book_number: 1 })
      .eq('id', storyId);

    console.log(`📚 [Admin] Created series "${seriesName}" (${seriesId})`);
  }

  // Extract Book 1 context
  const { extractBookContext, generateSequelBible, generateArcOutline, orchestratePreGeneration } = require('../services/generation');

  let book1Context;
  const { data: storedContext } = await supabaseAdmin
    .from('story_series_context')
    .select('*')
    .eq('series_id', seriesId)
    .eq('book_number', 1)
    .maybeSingle();

  if (storedContext) {
    console.log('✅ [Admin] Using stored Book 1 context');
    book1Context = storedContext;
  } else {
    console.log('📊 [Admin] Extracting Book 1 context...');
    const context = await extractBookContext(storyId, userId);

    const { data: book1Bible } = await supabaseAdmin
      .from('story_bibles')
      .select('id')
      .eq('story_id', storyId)
      .single();

    await supabaseAdmin
      .from('story_series_context')
      .insert({
        series_id: seriesId,
        book_number: 1,
        bible_id: book1Bible.id,
        character_states: context.character_states,
        world_state: context.world_state,
        relationships: context.relationships,
        accomplishments: context.accomplishments,
        key_events: context.key_events,
        reader_preferences: userPreferences || {}
      });

    book1Context = context;
  }

  console.log('📚 [Admin] Generating Book 2 bible...');
  const book2BibleContent = await generateSequelBible(storyId, userPreferences, userId);

  // Create Book 2 story record
  const { data: book2Story, error: book2Error } = await supabaseAdmin
    .from('stories')
    .insert({
      user_id: userId,
      series_id: seriesId,
      book_number: 2,
      parent_story_id: storyId,
      title: book2BibleContent.title,
      genre: book1Story.genre || null,
      premise_tier: book1Story.premise_tier || null,
      status: 'generating',
      generation_progress: {
        bible_complete: false,
        arc_complete: false,
        chapters_generated: 0,
        current_step: 'generating_bible'
      }
    })
    .select()
    .single();

  if (book2Error) {
    throw new Error(`Failed to create Book 2 story: ${book2Error.message}`);
  }

  console.log(`✅ [Admin] Created Book 2 story: ${book2Story.id}`);

  // Store Book 2 bible
  const { data: book2Bible, error: bibleError } = await supabaseAdmin
    .from('story_bibles')
    .insert({
      user_id: userId,
      story_id: book2Story.id,
      content: book2BibleContent,
      title: book2BibleContent.title,
      world_rules: book2BibleContent.world_rules,
      characters: book2BibleContent.characters,
      central_conflict: book2BibleContent.central_conflict,
      stakes: book2BibleContent.stakes,
      themes: book2BibleContent.themes,
      key_locations: book2BibleContent.key_locations,
      timeline: book2BibleContent.timeline
    })
    .select()
    .single();

  if (bibleError) {
    throw new Error(`Failed to store Book 2 bible: ${bibleError.message}`);
  }

  console.log('📐 [Admin] Generating Book 2 arc...');
  await generateArcOutline(book2Story.id, userId);

  console.log('📝 [Admin] Starting Book 2 chapter generation (1-3 initial batch)...');
  orchestratePreGeneration(book2Story.id, userId).catch(error => {
    console.error('[Admin] Book 2 pre-generation failed:', error);
  });

  res.json({
    success: true,
    book2: book2Story,
    seriesId,
    message: `Book 2 "${book2BibleContent.title}" is being conjured for ${userId}!`
  });
}));

/**
 * POST /admin/world-continuity/generate/:storyId
 * Manually trigger world codex generation + world state ledger backfill for a story.
 * Useful for stories that were generated before the world continuity system was deployed,
 * or when the system failed silently during generation.
 *
 * Requires: story must have a bible with world_rules
 * Does: generates codex (if missing), backfills ledger for all existing chapters (if missing)
 */
router.post('/world-continuity/generate/:storyId', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;

  console.log(`🌍 [Admin] World continuity generation requested for story ${storyId}`);

  // Fetch story + bible
  const { data: story } = await supabaseAdmin
    .from('stories')
    .select('id, title, genre, user_id, bible_id')
    .eq('id', storyId)
    .single();

  if (!story) {
    return res.status(404).json({ error: 'Story not found' });
  }

  const { data: bible } = await supabaseAdmin
    .from('story_bibles')
    .select('*')
    .eq('story_id', storyId)
    .single();

  if (!bible) {
    return res.status(404).json({ error: 'Bible not found for story' });
  }

  const results = { codex: null, ledger: [] };

  // Step 1: Generate world codex if missing
  const { data: existingCodex } = await supabaseAdmin
    .from('world_codex')
    .select('id')
    .eq('story_id', storyId)
    .maybeSingle();

  if (!existingCodex) {
    try {
      const { generateWorldCodex } = require('../services/generation');
      const codex = await generateWorldCodex(storyId, story.user_id, bible, story.genre || 'fiction');
      results.codex = codex ? 'generated' : 'failed (parse error)';
      console.log(`🌍 [Admin] World codex: ${results.codex}`);
    } catch (err) {
      results.codex = `error: ${err.message}`;
      console.error(`🌍 [Admin] World codex generation failed:`, err.message);
    }
  } else {
    results.codex = 'already exists';
  }

  // Step 2: Backfill world state ledger for existing chapters
  const { data: chapters } = await supabaseAdmin
    .from('chapters')
    .select('chapter_number, content')
    .eq('story_id', storyId)
    .order('chapter_number', { ascending: true });

  if (chapters && chapters.length > 0) {
    const { extractWorldStateLedger } = require('../services/world-continuity');

    for (const chapter of chapters) {
      // Check if ledger entry already exists
      const { data: existing } = await supabaseAdmin
        .from('world_state_ledger')
        .select('id')
        .eq('story_id', storyId)
        .eq('chapter_number', chapter.chapter_number)
        .maybeSingle();

      if (existing) {
        results.ledger.push({ chapter: chapter.chapter_number, status: 'already exists' });
        continue;
      }

      try {
        await extractWorldStateLedger(storyId, chapter.chapter_number, chapter.content, story.user_id);
        results.ledger.push({ chapter: chapter.chapter_number, status: 'generated' });
        console.log(`🌍 [Admin] World ledger extracted for chapter ${chapter.chapter_number}`);
      } catch (err) {
        results.ledger.push({ chapter: chapter.chapter_number, status: `error: ${err.message}` });
        console.error(`🌍 [Admin] World ledger failed for chapter ${chapter.chapter_number}:`, err.message);
      }
    }
  }

  res.json({
    success: true,
    story: story.title,
    results
  });
}));

module.exports = router;
