-- Migration: Feedback System and Series Tracking
-- Purpose: Add tables for reader feedback, series continuity, and sequel generation

-- Add series tracking columns to stories table
ALTER TABLE stories ADD COLUMN IF NOT EXISTS series_id UUID;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS book_number INTEGER DEFAULT 1;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS parent_story_id UUID REFERENCES stories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stories_series ON stories(series_id, book_number);
CREATE INDEX IF NOT EXISTS idx_stories_parent ON stories(parent_story_id);

-- Story feedback table (for checkpoints at chapters 3, 6, 9)
CREATE TABLE IF NOT EXISTS story_feedback (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  checkpoint TEXT NOT NULL, -- 'chapter_3', 'chapter_6', 'chapter_9'
  response TEXT NOT NULL, -- 'Great', 'Fantastic', 'Meh'
  follow_up_action TEXT, -- For 'Meh': 'different_story', 'keep_reading', 'voice_tips'
  voice_transcript TEXT, -- If user gave voice feedback
  voice_session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, story_id, checkpoint)
);

CREATE INDEX IF NOT EXISTS idx_feedback_user_story ON story_feedback(user_id, story_id);
CREATE INDEX IF NOT EXISTS idx_feedback_checkpoint ON story_feedback(checkpoint);

-- Book completion interviews (after chapter 12)
CREATE TABLE IF NOT EXISTS book_completion_interviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  series_id UUID,
  book_number INTEGER NOT NULL,
  transcript TEXT NOT NULL,
  session_id TEXT,
  preferences_extracted JSONB, -- Structured: {liked, wants_more, interested_in, etc.}
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, story_id)
);

CREATE INDEX IF NOT EXISTS idx_completion_interviews_story ON book_completion_interviews(story_id);
CREATE INDEX IF NOT EXISTS idx_completion_interviews_series ON book_completion_interviews(series_id);

-- Series context table (stores continuity data between books)
CREATE TABLE IF NOT EXISTS story_series_context (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  series_id UUID NOT NULL,
  book_number INTEGER NOT NULL,
  bible_id UUID NOT NULL REFERENCES story_bibles(id) ON DELETE CASCADE,

  -- Character states at end of this book
  character_states JSONB,
  -- Example: {
  --   "protagonist": {
  --     "growth": "learned to trust others",
  --     "skills_gained": ["sword fighting", "basic magic"],
  --     "emotional_state": "confident but cautious",
  --     "current_location": "home village as hero"
  --   },
  --   "supporting": [...]
  -- }

  -- World state changes from this book
  world_state JSONB,
  -- Example: ["Dark forest now safe", "Village knows magic exists"]

  -- Relationships developed
  relationships JSONB,
  -- Example: {"Alice + Bob": "close friends", "Alice + Mentor": "mutual respect"}

  -- Key accomplishments
  accomplishments JSONB,
  -- Example: ["Defeated shadow creature", "United villages"]

  -- Major events to reference in sequels
  key_events JSONB,
  -- Example: ["The Battle of Moonlight Grove", "Discovery of Hidden Library"]

  -- Reader preferences for next book
  reader_preferences JSONB,
  -- From completion interview

  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(series_id, book_number)
);

CREATE INDEX IF NOT EXISTS idx_series_context_series ON story_series_context(series_id);
CREATE INDEX IF NOT EXISTS idx_series_context_bible ON story_series_context(bible_id);

-- Enable Row Level Security
ALTER TABLE story_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE book_completion_interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_series_context ENABLE ROW LEVEL SECURITY;

-- RLS Policies for story_feedback
CREATE POLICY "Users can view their own feedback"
  ON story_feedback FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own feedback"
  ON story_feedback FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- RLS Policies for book_completion_interviews
CREATE POLICY "Users can view their own completion interviews"
  ON book_completion_interviews FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own completion interviews"
  ON book_completion_interviews FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- RLS Policies for story_series_context (service role only for writes)
CREATE POLICY "Users can view series context for their stories"
  ON story_series_context FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM stories
      WHERE stories.series_id = story_series_context.series_id
      AND stories.user_id = auth.uid()
    )
  );

-- Comments
COMMENT ON TABLE story_feedback IS 'Reader feedback at checkpoints (chapters 3, 6, 9)';
COMMENT ON TABLE book_completion_interviews IS 'Voice interviews after completing each book (chapter 12)';
COMMENT ON TABLE story_series_context IS 'Continuity data for generating sequels with preserved character development';
COMMENT ON COLUMN stories.series_id IS 'Links all books in the same series (Book 1, 2, 3...)';
COMMENT ON COLUMN stories.book_number IS 'Position in series (1, 2, 3...)';
COMMENT ON COLUMN stories.parent_story_id IS 'Reference to previous book in series';
