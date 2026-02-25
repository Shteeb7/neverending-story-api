-- Migration 013: Fantasy Name Generation
-- Adds last_name_generation_at column to user_preferences for rate limiting

ALTER TABLE user_preferences
ADD COLUMN IF NOT EXISTS last_name_generation_at TIMESTAMPTZ;

COMMENT ON COLUMN user_preferences.last_name_generation_at IS 'Timestamp of last fantasy name generation request (rate limit: once per 7 days)';
