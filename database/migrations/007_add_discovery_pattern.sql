-- Migration 007: Add discovery_pattern to user_writing_preferences
-- This tracks whether readers prefer comfort, stretch, or wildcard stories
-- Created: 2026-02-13

-- Add discovery_pattern column
ALTER TABLE user_writing_preferences
ADD COLUMN IF NOT EXISTS discovery_pattern TEXT;

COMMENT ON COLUMN user_writing_preferences.discovery_pattern IS
'Pattern analysis: Does this reader prefer comfort (familiar) stories or wildcards (surprises)? Based on premise_tier selection history and feedback.';
