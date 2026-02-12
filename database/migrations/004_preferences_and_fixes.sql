-- Migration: User Writing Preferences + Quality Score Fix
-- Purpose: Add preference learning engine and fix quality_score column type

-- ============================================
-- FIX: quality_score Column Type
-- ============================================
-- Problem: quality_score was INTEGER but weighted rubric produces decimals (7.5, 8.2, etc.)
-- Impact: Postgres silently rounds on insert, losing precision (7.4→7, 7.5→8)
-- Fix: Change to NUMERIC(4,2) to support 2 decimal places

ALTER TABLE chapters ALTER COLUMN quality_score TYPE NUMERIC(4,2);

COMMENT ON COLUMN chapters.quality_score IS 'Weighted quality score from rubric evaluation (supports decimals like 7.5)';

-- ============================================
-- User Writing Preferences Table
-- ============================================
-- Purpose: Store LEARNED writing style preferences derived from feedback analysis
-- Different from user_preferences (onboarding preferences) - this is ML-derived patterns

CREATE TABLE IF NOT EXISTS user_writing_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Learned style preferences (JSONB for flexibility)
  preferred_pacing JSONB DEFAULT '{}',
  preferred_dialogue_style JSONB DEFAULT '{}',
  preferred_complexity JSONB DEFAULT '{}',
  character_voice_preferences JSONB DEFAULT '{}',

  -- Prompt injection data (these get added to chapter generation prompts)
  custom_instructions TEXT[] DEFAULT '{}',
  avoid_patterns TEXT[] DEFAULT '{}',

  -- Learning metadata
  stories_analyzed INTEGER DEFAULT 0,
  feedback_data_points INTEGER DEFAULT 0,
  confidence_score NUMERIC(3,2) DEFAULT 0.00,
  analysis_summary TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_updated TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_writing_prefs_user ON user_writing_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_writing_prefs_confidence ON user_writing_preferences(confidence_score);
CREATE INDEX IF NOT EXISTS idx_writing_prefs_updated ON user_writing_preferences(last_updated);

-- ============================================
-- Row Level Security (RLS)
-- ============================================

ALTER TABLE user_writing_preferences ENABLE ROW LEVEL SECURITY;

-- Users can view their own writing preferences
CREATE POLICY "Users can view their own writing preferences"
  ON user_writing_preferences FOR SELECT
  USING (auth.uid() = user_id);

-- Service role handles inserts/updates (analysis runs server-side)
-- No INSERT/UPDATE policies for regular users - only service role

-- ============================================
-- Comments
-- ============================================

COMMENT ON TABLE user_writing_preferences IS 'ML-derived writing style preferences learned from user feedback patterns across multiple stories';
COMMENT ON COLUMN user_writing_preferences.preferred_pacing IS 'JSONB: action_density, description_ratio, summary';
COMMENT ON COLUMN user_writing_preferences.preferred_dialogue_style IS 'JSONB: style (snappy/balanced/literary), humor_level, summary';
COMMENT ON COLUMN user_writing_preferences.preferred_complexity IS 'JSONB: vocabulary_grade_level, sentence_variation, summary';
COMMENT ON COLUMN user_writing_preferences.custom_instructions IS 'Array of specific writing instructions for this reader (injected into chapter prompts)';
COMMENT ON COLUMN user_writing_preferences.avoid_patterns IS 'Array of patterns this reader dislikes (used to guide generation)';
COMMENT ON COLUMN user_writing_preferences.stories_analyzed IS 'Number of completed stories used in analysis (need >= 2)';
COMMENT ON COLUMN user_writing_preferences.feedback_data_points IS 'Total feedback rows + interview rows used in analysis';
COMMENT ON COLUMN user_writing_preferences.confidence_score IS 'Claude confidence in analysis (0.0-1.0), need >= 0.5 to inject preferences';
