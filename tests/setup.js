// Jest setup file - loads environment variables before tests run
require('dotenv').config();

// Set test environment variables if not already set
if (!process.env.OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = 'test-key';
}

if (!process.env.ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = 'test-key';
}

if (!process.env.SUPABASE_URL) {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
}
