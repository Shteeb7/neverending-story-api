-- Migration 007: Character Relationship Ledger
-- Adds per-chapter character relationship tracking for deep character continuity
-- Created: 2026-02-15
-- Phase 1: Ledger Extraction + Continuity Injection
-- (Phase 2: Character Voice Review tables will be added later)

-- Create character ledger entries table
CREATE TABLE character_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL,
  ledger_data JSONB NOT NULL,          -- the full structured ledger JSON
  compressed_summary TEXT,              -- compressed version for older chapters
  callback_bank JSONB,                  -- accumulated callbacks with status tracking
  token_count INTEGER,                  -- approximate token count for budget management
  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(story_id, chapter_number)      -- one ledger entry per chapter per story
);

-- Index for quick lookup during generation
CREATE INDEX idx_character_ledger_story ON character_ledger_entries(story_id, chapter_number);

-- Enable RLS
ALTER TABLE character_ledger_entries ENABLE ROW LEVEL SECURITY;

-- RLS policy: Users can read their own story ledgers
CREATE POLICY "Users can read own story ledgers"
  ON character_ledger_entries
  FOR SELECT
  USING (
    story_id IN (SELECT id FROM stories WHERE user_id = auth.uid())
  );

-- Add comment for documentation
COMMENT ON TABLE character_ledger_entries IS 'Stores per-chapter character relationship tracking data for continuity injection into generation prompts';
COMMENT ON COLUMN character_ledger_entries.ledger_data IS 'Full structured ledger JSON: emotional_state, chapter_experience, new_knowledge, private_thoughts, relationship_shifts';
COMMENT ON COLUMN character_ledger_entries.compressed_summary IS 'Compressed text summary for older chapters (reduces context window usage)';
COMMENT ON COLUMN character_ledger_entries.callback_bank IS 'Accumulated callbacks from all chapters with status tracking (used/expired/ripe)';
COMMENT ON COLUMN character_ledger_entries.token_count IS 'Approximate token count for context window budget management';
