-- Migration: Reading Analytics & Session Tracking
-- Purpose: Track reading behavior, session duration, abandonment, and chapter-level engagement

-- ============================================
-- Reading Sessions Table
-- ============================================
-- Purpose: Track individual reading sessions per chapter
-- Each time a user opens a chapter, a new session starts

CREATE TABLE IF NOT EXISTS reading_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL,

  session_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_end TIMESTAMPTZ,  -- null = session still active or abandoned
  reading_duration_seconds INTEGER,  -- computed on session end

  max_scroll_progress NUMERIC(5,2) DEFAULT 0,  -- 0-100 percentage
  completed BOOLEAN DEFAULT false,  -- true if scroll progress hit 90%+
  abandoned BOOLEAN DEFAULT false,  -- true if session ended without completion AND user didn't return within 24 hours

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reading_sessions_user_story ON reading_sessions(user_id, story_id);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_user_chapter ON reading_sessions(user_id, chapter_number);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_completed ON reading_sessions(completed);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_abandoned ON reading_sessions(abandoned);

-- ============================================
-- Chapter Reading Stats (Aggregated)
-- ============================================
-- Purpose: Materialized per-chapter aggregate stats
-- Updated on each session end

CREATE TABLE IF NOT EXISTS chapter_reading_stats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL,

  total_reading_time_seconds INTEGER DEFAULT 0,
  session_count INTEGER DEFAULT 0,
  max_scroll_progress NUMERIC(5,2) DEFAULT 0,

  first_opened TIMESTAMPTZ,
  last_read TIMESTAMPTZ,
  completed BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, story_id, chapter_number)
);

CREATE INDEX IF NOT EXISTS idx_chapter_stats_user_story ON chapter_reading_stats(user_id, story_id);
CREATE INDEX IF NOT EXISTS idx_chapter_stats_completed ON chapter_reading_stats(completed);

-- ============================================
-- Row Level Security (RLS)
-- ============================================

ALTER TABLE reading_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chapter_reading_stats ENABLE ROW LEVEL SECURITY;

-- Users can view their own reading sessions
CREATE POLICY "Users can view their own reading sessions"
  ON reading_sessions FOR SELECT
  USING (auth.uid() = user_id);

-- Users can view their own chapter reading stats
CREATE POLICY "Users can view their own chapter reading stats"
  ON chapter_reading_stats FOR SELECT
  USING (auth.uid() = user_id);

-- Service role handles inserts/updates (analytics runs server-side)

-- ============================================
-- Comments
-- ============================================

COMMENT ON TABLE reading_sessions IS 'Individual reading sessions tracking when users open/close chapters';
COMMENT ON COLUMN reading_sessions.session_start IS 'When the user opened this chapter';
COMMENT ON COLUMN reading_sessions.session_end IS 'When the session ended (null = still active or abandoned)';
COMMENT ON COLUMN reading_sessions.reading_duration_seconds IS 'Calculated duration: session_end - session_start';
COMMENT ON COLUMN reading_sessions.max_scroll_progress IS 'Highest scroll position reached (0-100 percent)';
COMMENT ON COLUMN reading_sessions.completed IS 'True if user scrolled to 90%+';
COMMENT ON COLUMN reading_sessions.abandoned IS 'True if session ended without completion and no return within 24h';

COMMENT ON TABLE chapter_reading_stats IS 'Aggregated per-chapter reading statistics (updated on session end)';
COMMENT ON COLUMN chapter_reading_stats.total_reading_time_seconds IS 'Sum of all session durations for this chapter';
COMMENT ON COLUMN chapter_reading_stats.session_count IS 'Number of times user opened this chapter';
COMMENT ON COLUMN chapter_reading_stats.max_scroll_progress IS 'Highest scroll position ever reached';
COMMENT ON COLUMN chapter_reading_stats.first_opened IS 'First time user opened this chapter';
COMMENT ON COLUMN chapter_reading_stats.last_read IS 'Most recent session for this chapter';
COMMENT ON COLUMN chapter_reading_stats.completed IS 'True if user ever scrolled to 90%+';
