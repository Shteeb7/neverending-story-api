const express = require('express');
const { anthropic } = require('../config/ai-clients');
const { asyncHandler } = require('../middleware/error-handler');

const router = express.Router();

/**
 * GET /test/claude
 * Test Claude API integration with a simple story premise generation
 */
router.get('/claude', asyncHandler(async (req, res) => {
  const startTime = Date.now();

  try {
    // Call Claude API with a simple prompt
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4.5-20250929',
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

    // Calculate cost (Claude Sonnet 4.5 pricing as of 2026)
    // Input: $3 per million tokens, Output: $15 per million tokens
    const inputCost = (inputTokens / 1_000_000) * 3;
    const outputCost = (outputTokens / 1_000_000) * 15;
    const totalCost = inputCost + outputCost;

    // Extract the generated text
    const generatedPremise = message.content[0].text;

    res.json({
      success: true,
      test: 'Claude API Integration',
      model: 'claude-sonnet-4.5-20250929',
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
      'GET /test/health - This endpoint'
    ]
  });
}));

module.exports = router;
