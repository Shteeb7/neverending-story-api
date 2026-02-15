-- Migration 008: Character Voice Reviews
-- Phase 2 of Character Relationship Ledger
-- Adds Sonnet-powered character authenticity review after each chapter
-- Created: 2026-02-15

-- Create character voice reviews table
CREATE TABLE character_voice_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL,
  review_data JSONB NOT NULL,           -- the full voice review JSON
  flags_count INTEGER DEFAULT 0,        -- number of authenticity flags raised
  revision_applied BOOLEAN DEFAULT FALSE, -- whether suggestions were incorporated
  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(story_id, chapter_number)
);

CREATE INDEX idx_voice_reviews_story ON character_voice_reviews(story_id, chapter_number);

ALTER TABLE character_voice_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own voice reviews" ON character_voice_reviews
  FOR SELECT USING (
    story_id IN (SELECT id FROM stories WHERE user_id = auth.uid())
  );

COMMENT ON TABLE character_voice_reviews IS 'Stores character voice authenticity reviews used for quality control during generation';
COMMENT ON COLUMN character_voice_reviews.review_data IS 'Full Sonnet review JSON: voice_checks per character with authenticity scores, flags, and missed callback opportunities';
COMMENT ON COLUMN character_voice_reviews.flags_count IS 'Total number of authenticity flags across all characters (for quick filtering)';
COMMENT ON COLUMN character_voice_reviews.revision_applied IS 'True if surgical revision pass was triggered and applied to the chapter';
