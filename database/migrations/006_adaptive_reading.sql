-- Migration 006: Adaptive Reading Engine
-- Adds dimension-based feedback tracking and writing intelligence tables
-- Created: 2026-02-14

-- Add dimension columns to story_feedback table
ALTER TABLE story_feedback
  ADD COLUMN pacing_feedback TEXT,           -- 'hooked', 'slow', 'fast'
  ADD COLUMN tone_feedback TEXT,             -- 'right', 'serious', 'light'
  ADD COLUMN character_feedback TEXT,        -- 'love', 'warming', 'not_clicking'
  ADD COLUMN protagonist_name TEXT;          -- for context in aggregate analysis

-- Create writing intelligence snapshots table for aggregate feedback analysis
CREATE TABLE writing_intelligence_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL,
  genre TEXT,
  age_range TEXT,
  checkpoint TEXT,                           -- 'chapter_2', 'chapter_5', 'chapter_8'
  total_responses INTEGER NOT NULL,
  pacing_distribution JSONB,                 -- {"hooked": 45, "slow": 38, "fast": 17}
  tone_distribution JSONB,                   -- {"right": 52, "serious": 35, "light": 13}
  character_distribution JSONB,              -- {"love": 60, "warming": 30, "not_clicking": 10}
  correction_success_rate NUMERIC(5,2),      -- % of corrections that resulted in improvement
  abandonment_rate NUMERIC(5,2),             -- % of readers who stopped after this checkpoint
  insights JSONB,                            -- Claude-generated analysis
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create prompt adjustment log table
CREATE TABLE prompt_adjustment_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_type TEXT NOT NULL,             -- 'base_prompt', 'genre_default', 'quality_rubric'
  genre TEXT,
  description TEXT NOT NULL,                 -- human-readable what changed
  previous_value TEXT,
  new_value TEXT,
  data_basis TEXT,                           -- what aggregate data motivated this
  snapshot_id UUID REFERENCES writing_intelligence_snapshots(id),
  applied_by TEXT NOT NULL,                  -- 'manual' or 'auto'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on new tables
ALTER TABLE writing_intelligence_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_adjustment_log ENABLE ROW LEVEL SECURITY;

-- RLS policies for writing_intelligence_snapshots (admin-only read)
CREATE POLICY "Admin read writing intelligence snapshots"
  ON writing_intelligence_snapshots
  FOR SELECT
  USING (auth.uid() IN (
    SELECT user_id FROM user_preferences WHERE preferences->>'role' = 'admin'
  ));

-- RLS policies for prompt_adjustment_log (admin-only read)
CREATE POLICY "Admin read prompt adjustment log"
  ON prompt_adjustment_log
  FOR SELECT
  USING (auth.uid() IN (
    SELECT user_id FROM user_preferences WHERE preferences->>'role' = 'admin'
  ));

-- Add comments for documentation
COMMENT ON COLUMN story_feedback.pacing_feedback IS 'Reader feedback on pacing: hooked, slow, or fast';
COMMENT ON COLUMN story_feedback.tone_feedback IS 'Reader feedback on tone: right, serious, or light';
COMMENT ON COLUMN story_feedback.character_feedback IS 'Reader feedback on character: love, warming, or not_clicking';
COMMENT ON COLUMN story_feedback.protagonist_name IS 'Protagonist name for aggregate analysis context';

COMMENT ON TABLE writing_intelligence_snapshots IS 'Aggregate feedback patterns across all readers for system-wide improvements';
COMMENT ON TABLE prompt_adjustment_log IS 'Audit trail of base prompt changes motivated by aggregate feedback';
