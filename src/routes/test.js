const express = require('express');
const { anthropic } = require('../config/ai-clients');
const { asyncHandler } = require('../middleware/error-handler');
const {
  generatePremises,
  generateStoryBible,
  generateArcOutline,
  generateChapter
} = require('../services/generation');

const router = express.Router();

// Hardcoded test user ID (consistent across test runs)
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

// Read generation model from environment
const GENERATION_MODEL = process.env.CLAUDE_GENERATION_MODEL || 'claude-opus-4-6';

/**
 * GET /test/claude
 * Test Claude API integration with a simple story premise generation
 */
router.get('/claude', asyncHandler(async (req, res) => {
  const startTime = Date.now();

  try {
    // Call Claude API with a simple prompt
    const message = await anthropic.messages.create({
      model: GENERATION_MODEL,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: 'Write a one-sentence premise for a fantasy story.'
      }]
    });

    const responseTime = Date.now() - startTime;

    // Extract token usage
    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;

    // Calculate cost (Claude Opus 4.6 pricing as of 2026)
    // Input: $5 per million tokens, Output: $25 per million tokens
    const inputCost = (inputTokens / 1_000_000) * 5;
    const outputCost = (outputTokens / 1_000_000) * 25;
    const totalCost = inputCost + outputCost;

    // Extract the generated text
    const generatedPremise = message.content[0].text;

    res.json({
      success: true,
      test: 'Claude API Integration',
      model: GENERATION_MODEL,
      premise: generatedPremise,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens
      },
      cost: {
        inputCost: `$${inputCost.toFixed(6)}`,
        outputCost: `$${outputCost.toFixed(6)}`,
        totalCost: `$${totalCost.toFixed(6)}`
      },
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Claude API Error:', error);

    // Return detailed error information
    res.status(500).json({
      success: false,
      test: 'Claude API Integration',
      error: error.message,
      errorType: error.constructor.name,
      details: error.error || null,
      timestamp: new Date().toISOString()
    });
  }
}));

/**
 * GET /test/health
 * Simple health check for the test routes
 */
router.get('/health', asyncHandler(async (req, res) => {
  res.json({
    success: true,
    message: 'Test routes are operational',
    availableTests: [
      'GET /test/claude - Test Claude API integration',
      'POST /test/generate-story - Full end-to-end generation test',
      'GET /test/schema - Check actual database schema',
      'GET /test/health - This endpoint'
    ]
  });
}));

/**
 * GET /test/schema
 * Query actual database schema - try inserting with minimal data to see what's required
 */
router.get('/schema', asyncHandler(async (req, res) => {
  const { supabaseAdmin } = require('../config/supabase');

  const results = {
    success: true,
    story_bibles: { required_fields: [], errors: [] },
    stories: { required_fields: [], errors: [] }
  };

  // Test 1: Try to insert minimal story_bibles record to see what fields are required
  try {
    const { error } = await supabaseAdmin
      .from('story_bibles')
      .insert({ user_id: '00000000-0000-0000-0000-000000000001' })
      .select();

    if (error) {
      results.story_bibles.errors.push(error.message);
      // Parse error to extract required fields
      if (error.message.includes('violates not-null constraint')) {
        const match = error.message.match(/column "([^"]+)"/);
        if (match) results.story_bibles.required_fields.push(match[1]);
      }
    }
  } catch (e) {
    results.story_bibles.errors.push(e.message);
  }

  // Test 2: Try to insert minimal stories record
  try {
    const { error } = await supabaseAdmin
      .from('stories')
      .insert({ user_id: '00000000-0000-0000-0000-000000000001' })
      .select();

    if (error) {
      results.stories.errors.push(error.message);
      if (error.message.includes('violates not-null constraint')) {
        const match = error.message.match(/column "([^"]+)"/);
        if (match) results.stories.required_fields.push(match[1]);
      }
      if (error.message.includes('violates check constraint')) {
        results.stories.errors.push('Has CHECK constraints - see error details');
      }
    }
  } catch (e) {
    results.stories.errors.push(e.message);
  }

  res.json(results);
}));

/**
 * POST /test/generate-story
 * Full end-to-end test of the story generation pipeline
 * NO AUTHENTICATION REQUIRED - test endpoint only
 *
 * Tests:
 * 1. Generate 3 premises from preferences
 * 2. Generate story bible from first premise
 * 3. Generate arc outline
 * 4. Generate first chapter with quality pass
 *
 * Expected time: ~3-4 minutes
 * Expected cost: ~$1.50
 */
router.post('/generate-story', asyncHandler(async (req, res) => {
  console.log('\n🧪 Starting full generation test...');
  const overallStartTime = Date.now();

  const results = {
    success: true,
    test: 'Full Story Generation Pipeline',
    test_user_id: TEST_USER_ID,
    timestamps: {},
    timings: {},
    costs: {},
    errors: []
  };

  try {
    // Step 1: Generate 3 premises
    console.log('📚 Step 1: Generating premises...');
    const premisesStartTime = Date.now();

    const preferences = {
      favorite_series: ['Harry Potter'],
      favorite_genres: ['fantasy'],
      loved_elements: ['magic', 'adventure'],
      disliked_elements: []
    };

    const { premises, premisesId } = await generatePremises(TEST_USER_ID, preferences);

    results.premises = premises.map(p => ({
      id: p.id,
      title: p.title,
      genre: p.genre,
      hook: p.hook,
      themes: p.themes
    }));
    results.premises_id = premisesId;
    results.timestamps.premises_generated = new Date().toISOString();
    results.timings.premises_generation = `${((Date.now() - premisesStartTime) / 1000).toFixed(1)}s`;

    console.log(`✅ Generated ${premises.length} premises in ${results.timings.premises_generation}`);

    // Step 2: Generate story bible from first premise
    console.log('📖 Step 2: Generating story bible...');
    const bibleStartTime = Date.now();

    const { bible, storyId } = await generateStoryBible(premisesId, TEST_USER_ID);

    results.story_id = storyId;
    results.bible = {
      title: bible.title,
      protagonist: bible.characters.protagonist.name,
      antagonist: bible.characters.antagonist.name,
      central_conflict: bible.central_conflict.description,
      themes: bible.themes,
      key_locations_count: bible.key_locations.length
    };
    results.timestamps.bible_generated = new Date().toISOString();
    results.timings.bible_generation = `${((Date.now() - bibleStartTime) / 1000).toFixed(1)}s`;

    console.log(`✅ Generated story bible in ${results.timings.bible_generation}`);

    // Step 3: Generate arc outline
    console.log('📋 Step 3: Generating arc outline...');
    const arcStartTime = Date.now();

    const { arc } = await generateArcOutline(storyId, TEST_USER_ID);

    results.arc = {
      chapter_count: arc.chapters.length,
      chapters: arc.chapters.map(ch => ({
        number: ch.chapter_number,
        title: ch.title,
        tension_level: ch.tension_level,
        word_count_target: ch.word_count_target
      })),
      pacing_notes: arc.pacing_notes
    };
    results.timestamps.arc_generated = new Date().toISOString();
    results.timings.arc_generation = `${((Date.now() - arcStartTime) / 1000).toFixed(1)}s`;

    console.log(`✅ Generated ${arc.chapters.length}-chapter arc in ${results.timings.arc_generation}`);

    // Step 4: Generate first chapter
    console.log('✍️  Step 4: Generating first chapter...');
    const chapterStartTime = Date.now();

    const chapter = await generateChapter(storyId, 1, TEST_USER_ID);

    results.chapter_1 = {
      id: chapter.id,
      title: chapter.title,
      word_count: chapter.word_count,
      quality_score: chapter.quality_score,
      regeneration_count: chapter.regeneration_count,
      content_preview: chapter.content.substring(0, 500) + '...',
      content_full: chapter.content // Include full content for verification
    };

    if (chapter.quality_review) {
      results.chapter_1.quality_review = {
        criteria_scores: chapter.quality_review.criteria_scores,
        strengths: chapter.quality_review.strengths,
        passed: chapter.quality_review.pass
      };
    }

    results.timestamps.chapter_generated = new Date().toISOString();
    results.timings.chapter_generation = `${((Date.now() - chapterStartTime) / 1000).toFixed(1)}s`;

    console.log(`✅ Generated chapter 1 in ${results.timings.chapter_generation}`);
    console.log(`   Word count: ${chapter.word_count}`);
    console.log(`   Quality score: ${chapter.quality_score}/10`);
    console.log(`   Regenerations: ${chapter.regeneration_count}`);

    // Calculate totals
    const totalTime = (Date.now() - overallStartTime) / 1000;
    results.timings.total = `${totalTime.toFixed(1)}s`;
    results.timings.total_minutes = `${(totalTime / 60).toFixed(2)}min`;

    // Estimate cost (rough calculation based on typical token usage)
    // These are estimates - actual costs tracked in api_costs table
    const estimatedCosts = {
      premises: 0.05,
      bible: 0.75,
      arc: 0.50,
      chapter: 0.90
    };

    const totalEstimatedCost = Object.values(estimatedCosts).reduce((a, b) => a + b, 0);

    results.costs = {
      premises_estimated: `$${estimatedCosts.premises.toFixed(2)}`,
      bible_estimated: `$${estimatedCosts.bible.toFixed(2)}`,
      arc_estimated: `$${estimatedCosts.arc.toFixed(2)}`,
      chapter_estimated: `$${estimatedCosts.chapter.toFixed(2)}`,
      total_estimated: `$${totalEstimatedCost.toFixed(2)}`,
      note: 'Actual costs tracked in api_costs table - query for exact values'
    };

    console.log(`\n✅ Full generation test completed in ${results.timings.total}`);
    console.log(`💰 Estimated cost: ${results.costs.total_estimated}`);

    res.json(results);

  } catch (error) {
    console.error('❌ Generation test failed:', error);

    // Return partial results with error
    results.success = false;
    results.error = error.message;
    results.error_type = error.constructor.name;
    results.error_stack = error.stack;
    results.timings.total = `${((Date.now() - overallStartTime) / 1000).toFixed(1)}s (failed)`;

    res.status(500).json(results);
  }
}));

module.exports = router;
