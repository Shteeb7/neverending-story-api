-- Migration: Backfill null genres on legacy stories
-- Date: 2026-02-15
-- Purpose: Ensure all stories have a genre for improved cover generation

-- Set default genre to 'Fantasy' for stories with null genre
-- This is a reasonable default since fantasy is the most common genre in the system
-- The cover generation will still be unique because it uses the full story bible data
UPDATE stories
SET genre = 'Fantasy'
WHERE genre IS NULL;

-- Log the change
DO $$
DECLARE
  updated_count INTEGER;
BEGIN
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RAISE NOTICE 'Backfilled % stories with null genres to default "Fantasy"', updated_count;
END $$;
