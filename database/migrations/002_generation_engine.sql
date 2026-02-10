-- Migration: AI Generation Engine Tables and Enhancements
-- Purpose: Add tables and columns needed for the AI story generation pipeline

-- Create story_bibles table
CREATE TABLE IF NOT EXISTS story_bibles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  premise_id UUID REFERENCES story_premises(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  world_rules JSONB NOT NULL,
  characters JSONB NOT NULL,
  central_conflict JSONB NOT NULL,
  stakes JSONB NOT NULL,
  themes JSONB NOT NULL,
  key_locations JSONB NOT NULL,
  timeline JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bibles_user ON story_bibles(user_id);
CREATE INDEX IF NOT EXISTS idx_bibles_premise ON story_bibles(premise_id);

-- Create story_arcs table
CREATE TABLE IF NOT EXISTS story_arcs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  bible_id UUID NOT NULL REFERENCES story_bibles(id) ON DELETE CASCADE,
  chapters JSONB NOT NULL,
  pacing_notes TEXT,
  story_threads JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_arcs_story ON story_arcs(story_id);
CREATE INDEX IF NOT EXISTS idx_arcs_bible ON story_arcs(bible_id);

-- Enhance existing stories table
ALTER TABLE stories ADD COLUMN IF NOT EXISTS bible_id UUID REFERENCES story_bibles(id);
ALTER TABLE stories ADD COLUMN IF NOT EXISTS generation_progress JSONB DEFAULT '{}';
ALTER TABLE stories ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_stories_bible ON stories(bible_id);

-- Enhance existing chapters table
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS quality_score INTEGER;
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS quality_review JSONB;
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS quality_pass_completed BOOLEAN DEFAULT false;
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS regeneration_count INTEGER DEFAULT 0;
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Create or enhance api_costs table
CREATE TABLE IF NOT EXISTS api_costs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  story_id UUID REFERENCES stories(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost DECIMAL(10, 6) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_costs_user ON api_costs(user_id);
CREATE INDEX IF NOT EXISTS idx_costs_story ON api_costs(story_id);
CREATE INDEX IF NOT EXISTS idx_costs_created ON api_costs(created_at);
CREATE INDEX IF NOT EXISTS idx_costs_operation ON api_costs(operation);

-- Add status column to story_premises if it doesn't exist
ALTER TABLE story_premises ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'offered';
ALTER TABLE story_premises ADD COLUMN IF NOT EXISTS preferences_used JSONB;

-- Comment documentation
COMMENT ON TABLE story_bibles IS 'Comprehensive story world-building and character information';
COMMENT ON TABLE story_arcs IS '12-chapter story outlines with pacing and structure';
COMMENT ON TABLE api_costs IS 'Tracks all AI API usage and associated costs';
COMMENT ON COLUMN stories.generation_progress IS 'JSONB tracking bible_complete, arc_complete, chapters_generated, current_step';
COMMENT ON COLUMN chapters.quality_review IS 'JSONB containing quality scores and review details from AI evaluation';
COMMENT ON COLUMN chapters.regeneration_count IS 'Number of times chapter was regenerated due to quality issues';
