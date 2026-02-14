-- Migration 004: Add premise_tier to stories and discovery_tolerance to user_preferences
-- Implements Comfort/Stretch/Wildcard premise generation framework

-- Add premise_tier column to stories table
ALTER TABLE stories ADD COLUMN IF NOT EXISTS premise_tier TEXT
  CHECK (premise_tier IN ('comfort', 'stretch', 'wildcard'));

-- Add discovery_tolerance to user_preferences table
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS discovery_tolerance NUMERIC DEFAULT 0.5;

-- Add index for better query performance
CREATE INDEX IF NOT EXISTS idx_stories_premise_tier ON stories(premise_tier);

-- Comment the columns
COMMENT ON COLUMN stories.premise_tier IS 'Tier of the selected premise: comfort (direct match), stretch (unexpected combo), or wildcard (surprise based on emotional drivers)';
COMMENT ON COLUMN user_preferences.discovery_tolerance IS 'Reader discovery tolerance: 0.0-0.3 = comfort-seeker, 0.4-0.6 = balanced, 0.7-1.0 = explorer';
