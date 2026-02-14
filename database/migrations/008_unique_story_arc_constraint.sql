-- Migration 008: Prevent duplicate arcs for same story + arc_number
-- This prevents the death loop where recovery creates duplicate arcs
-- Created: 2026-02-13

-- First, clean up any existing duplicates (keep the oldest one per story)
DELETE FROM story_arcs
WHERE id NOT IN (
  SELECT MIN(id)
  FROM story_arcs
  GROUP BY story_id, arc_number
);

-- Add unique constraint
CREATE UNIQUE INDEX IF NOT EXISTS unique_story_arc
ON story_arcs (story_id, arc_number);

COMMENT ON INDEX unique_story_arc IS
'Prevents duplicate arcs for the same story and arc number. Critical for preventing death loops on recovery.';
