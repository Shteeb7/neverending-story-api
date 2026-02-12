-- Migration 001: Initial Schema
-- Purpose: Create core tables for the Neverending Story app

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- User preferences from onboarding
CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  preferences JSONB NOT NULL,
  transcript TEXT,
  session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_prefs_user ON user_preferences(user_id);

-- Story premises (3 AI-generated story options shown after onboarding)
CREATE TABLE IF NOT EXISTS story_premises (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  tagline TEXT NOT NULL,
  synopsis TEXT NOT NULL,
  genre TEXT NOT NULL,
  themes JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_premises_user ON story_premises(user_id);
CREATE INDEX IF NOT EXISTS idx_premises_created ON story_premises(created_at);

-- Stories (user-selected premise becomes a story)
CREATE TABLE IF NOT EXISTS stories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  premise_id UUID REFERENCES story_premises(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  genre TEXT NOT NULL,
  cover_image_url TEXT,
  status TEXT DEFAULT 'active',
  current_chapter_number INTEGER DEFAULT 0,
  total_chapters_generated INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stories_user ON stories(user_id);
CREATE INDEX IF NOT EXISTS idx_stories_premise ON stories(premise_id);
CREATE INDEX IF NOT EXISTS idx_stories_status ON stories(status);

-- Chapters (individual chapters of a story)
CREATE TABLE IF NOT EXISTS chapters (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  reading_time_minutes INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(story_id, chapter_number)
);

CREATE INDEX IF NOT EXISTS idx_chapters_story ON chapters(story_id);
CREATE INDEX IF NOT EXISTS idx_chapters_number ON chapters(story_id, chapter_number);

-- Reading progress (track where user is in each story)
CREATE TABLE IF NOT EXISTS reading_progress (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  current_chapter_number INTEGER DEFAULT 1,
  last_read_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, story_id)
);

CREATE INDEX IF NOT EXISTS idx_reading_progress_user ON reading_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_reading_progress_story ON reading_progress(story_id);

-- Comments on tables for documentation
COMMENT ON TABLE user_preferences IS 'User reading preferences collected during onboarding';
COMMENT ON TABLE story_premises IS 'AI-generated story premises offered to users after onboarding';
COMMENT ON TABLE stories IS 'Active stories that users are reading';
COMMENT ON TABLE chapters IS 'Individual chapters of each story';
COMMENT ON TABLE reading_progress IS 'Tracks which chapter the user is currently reading for each story';
