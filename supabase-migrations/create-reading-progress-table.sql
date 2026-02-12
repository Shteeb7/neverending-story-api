-- Create reading_progress table to track user reading positions
-- This stores the current chapter and scroll position for each story

CREATE TABLE IF NOT EXISTS public.reading_progress (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    story_id UUID NOT NULL REFERENCES public.stories(id) ON DELETE CASCADE,
    chapter_number INTEGER NOT NULL DEFAULT 1,
    scroll_position DOUBLE PRECISION DEFAULT 0,
    last_read_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- One progress record per user per story
    UNIQUE(user_id, story_id)
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_reading_progress_user_story
ON public.reading_progress(user_id, story_id);

-- Enable Row Level Security
ALTER TABLE public.reading_progress ENABLE ROW LEVEL SECURITY;

-- Users can only read/write their own progress
CREATE POLICY "Users can view their own reading progress"
ON public.reading_progress
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own reading progress"
ON public.reading_progress
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own reading progress"
ON public.reading_progress
FOR UPDATE
USING (auth.uid() = user_id);

-- Automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_reading_progress_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_reading_progress_timestamp
BEFORE UPDATE ON public.reading_progress
FOR EACH ROW
EXECUTE FUNCTION update_reading_progress_updated_at();
