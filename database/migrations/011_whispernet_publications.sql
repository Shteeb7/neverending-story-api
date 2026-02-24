-- Migration 011: WhisperNet Publications & Content Classification
-- Creates the publications table for tracking published books in the WhisperNet discovery portal

-- ====================
-- 1. WHISPERNET_PUBLICATIONS TABLE
-- ====================
-- Tracks books that have been released to WhisperNet for discovery
CREATE TABLE IF NOT EXISTS public.whispernet_publications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID UNIQUE NOT NULL REFERENCES public.stories(id) ON DELETE CASCADE,
    publisher_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    genre TEXT NOT NULL,
    mood_tags TEXT[],
    maturity_rating TEXT NOT NULL CHECK (maturity_rating IN ('all_ages', 'teen_13', 'mature_17')),
    language TEXT NOT NULL DEFAULT 'en',
    is_active BOOLEAN NOT NULL DEFAULT true
);

-- Indexes for discovery queries
CREATE INDEX IF NOT EXISTS idx_whispernet_publications_genre ON public.whispernet_publications(genre) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_whispernet_publications_maturity ON public.whispernet_publications(maturity_rating) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_whispernet_publications_published_at ON public.whispernet_publications(published_at DESC) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_whispernet_publications_publisher ON public.whispernet_publications(publisher_id);

-- ====================
-- 2. RLS POLICIES
-- ====================
ALTER TABLE public.whispernet_publications ENABLE ROW LEVEL SECURITY;

-- Publisher can view their own publications
CREATE POLICY "Publishers can view their own publications"
    ON public.whispernet_publications
    FOR SELECT
    USING (auth.uid() = publisher_id);

-- All authenticated users can view active publications (for browse/discovery)
CREATE POLICY "Authenticated users can browse active publications"
    ON public.whispernet_publications
    FOR SELECT
    USING (auth.uid() IS NOT NULL AND is_active = true);

-- Only publisher can insert their own publications
CREATE POLICY "Publishers can publish their own stories"
    ON public.whispernet_publications
    FOR INSERT
    WITH CHECK (auth.uid() = publisher_id);

-- Only publisher can update their own publications
CREATE POLICY "Publishers can update their own publications"
    ON public.whispernet_publications
    FOR UPDATE
    USING (auth.uid() = publisher_id)
    WITH CHECK (auth.uid() = publisher_id);

-- Only publisher can delete their own publications
CREATE POLICY "Publishers can delete their own publications"
    ON public.whispernet_publications
    FOR DELETE
    USING (auth.uid() = publisher_id);

-- ====================
-- 3. ADD CHECK CONSTRAINT TO STORIES.MATURITY_RATING
-- ====================
-- Stories table already has maturity_rating column (from migration 010)
-- Add CHECK constraint to match whispernet_publications
ALTER TABLE public.stories
    DROP CONSTRAINT IF EXISTS stories_maturity_rating_check;

ALTER TABLE public.stories
    ADD CONSTRAINT stories_maturity_rating_check
    CHECK (maturity_rating IS NULL OR maturity_rating IN ('all_ages', 'teen_13', 'mature_17'));
