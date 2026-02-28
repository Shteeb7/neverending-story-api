-- Migration 019: Prospero Editor Improvements
-- Adds interaction_type to reader_corrections and expands correction_category constraint

-- Add interaction_type column to track the type of interaction (correction/misunderstanding/clarification)
ALTER TABLE reader_corrections
ADD COLUMN IF NOT EXISTS interaction_type text DEFAULT 'misunderstanding';

-- Drop existing constraint on correction_category
ALTER TABLE reader_corrections
DROP CONSTRAINT IF EXISTS reader_corrections_correction_category_check;

-- Add updated constraint with vocabulary and lore_question categories
ALTER TABLE reader_corrections
ADD CONSTRAINT reader_corrections_correction_category_check
CHECK (correction_category = ANY (ARRAY[
  'name_inconsistency'::text,
  'timeline_error'::text,
  'description_drift'::text,
  'world_rule'::text,
  'plot_thread'::text,
  'vocabulary'::text,
  'lore_question'::text,
  'other'::text
]));

-- Add index on interaction_type for dashboard analytics
CREATE INDEX IF NOT EXISTS idx_reader_corrections_interaction_type
ON reader_corrections(interaction_type);

-- Add index on correction_category for dashboard analytics
CREATE INDEX IF NOT EXISTS idx_reader_corrections_category
ON reader_corrections(correction_category);
