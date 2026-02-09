const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

// Initialize Anthropic (Claude) client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Initialize OpenAI client (for Realtime API)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

module.exports = {
  anthropic,
  openai
};
