-- Migration 010: WhisperNet Library Integration
-- Creates tables and columns for WhisperNet shelf, sharing, and custom shelves

-- ====================
-- 1. WHISPERNET_LIBRARY TABLE
-- ====================
-- Tracks which books a user has added to their WhisperNet shelf
CREATE TABLE IF NOT EXISTS public.whispernet_library (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    story_id UUID NOT NULL REFERENCES public.stories(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('shared', 'browsed')),
    shared_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    seen BOOLEAN NOT NULL DEFAULT false,
    UNIQUE(user_id, story_id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_whispernet_library_user_id ON public.whispernet_library(user_id);
CREATE INDEX IF NOT EXISTS idx_whispernet_library_story_id ON public.whispernet_library(story_id);
CREATE INDEX IF NOT EXISTS idx_whispernet_library_user_unseen ON public.whispernet_library(user_id, seen) WHERE seen = false;

-- RLS Policies
ALTER TABLE public.whispernet_library ENABLE ROW LEVEL SECURITY;

-- Users can select their own library entries
CREATE POLICY "Users can view their own WhisperNet library"
    ON public.whispernet_library
    FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert into their own library
CREATE POLICY "Users can add to their own WhisperNet library"
    ON public.whispernet_library
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own library entries (e.g., mark as seen)
CREATE POLICY "Users can update their own WhisperNet library"
    ON public.whispernet_library
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Users can delete from their own library
CREATE POLICY "Users can delete from their own WhisperNet library"
    ON public.whispernet_library
    FOR DELETE
    USING (auth.uid() = user_id);


-- ====================
-- 2. SHARE_LINKS TABLE
-- ====================
-- Tracks gift links for sharing stories
CREATE TABLE IF NOT EXISTS public.share_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES public.stories(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
    claimed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    claimed_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_share_links_token ON public.share_links(token);
CREATE INDEX IF NOT EXISTS idx_share_links_sender ON public.share_links(sender_id);
CREATE INDEX IF NOT EXISTS idx_share_links_story ON public.share_links(story_id);

-- RLS Policies
ALTER TABLE public.share_links ENABLE ROW LEVEL SECURITY;

-- Sender can view their own links
CREATE POLICY "Senders can view their own share links"
    ON public.share_links
    FOR SELECT
    USING (auth.uid() = sender_id);

-- Anyone can select by token (for claiming) - public claim endpoint will use this
CREATE POLICY "Anyone can view share links by token"
    ON public.share_links
    FOR SELECT
    USING (true);

-- Only sender can create links
CREATE POLICY "Senders can create share links"
    ON public.share_links
    FOR INSERT
    WITH CHECK (auth.uid() = sender_id);

-- Anyone can update to claim a link (set claimed_by and claimed_at)
-- In practice, the app will validate the token before allowing this
CREATE POLICY "Anyone can claim share links"
    ON public.share_links
    FOR UPDATE
    USING (true)
    WITH CHECK (claimed_by IS NOT NULL AND claimed_at IS NOT NULL);


-- ====================
-- 3. USER_SHELVES TABLE
-- ====================
-- Custom user-created shelves for organizing books
CREATE TABLE IF NOT EXISTS public.user_shelves (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    shelf_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    display_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, shelf_name)
);

-- Index
CREATE INDEX IF NOT EXISTS idx_user_shelves_user_id ON public.user_shelves(user_id);

-- RLS Policies
ALTER TABLE public.user_shelves ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own shelves"
    ON public.user_shelves
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);


-- ====================
-- 4. USER_SHELF_BOOKS TABLE
-- ====================
-- Junction table for many-to-many relationship between shelves and books
CREATE TABLE IF NOT EXISTS public.user_shelf_books (
    shelf_id UUID NOT NULL REFERENCES public.user_shelves(id) ON DELETE CASCADE,
    story_id UUID NOT NULL REFERENCES public.stories(id) ON DELETE CASCADE,
    PRIMARY KEY (shelf_id, story_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_user_shelf_books_shelf ON public.user_shelf_books(shelf_id);
CREATE INDEX IF NOT EXISTS idx_user_shelf_books_story ON public.user_shelf_books(story_id);

-- RLS Policies
ALTER TABLE public.user_shelf_books ENABLE ROW LEVEL SECURITY;

-- Users can manage books on their own shelves (verified via join to user_shelves)
CREATE POLICY "Users can manage books on their own shelves"
    ON public.user_shelf_books
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.user_shelves
            WHERE user_shelves.id = user_shelf_books.shelf_id
            AND user_shelves.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.user_shelves
            WHERE user_shelves.id = user_shelf_books.shelf_id
            AND user_shelves.user_id = auth.uid()
        )
    );


-- ====================
-- 5. ADD COLUMNS TO EXISTING TABLES
-- ====================

-- Add WhisperNet columns to stories table
ALTER TABLE public.stories
    ADD COLUMN IF NOT EXISTS whispernet_published BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS maturity_rating TEXT;

-- Add WhisperNet columns to user_preferences table
ALTER TABLE public.user_preferences
    ADD COLUMN IF NOT EXISTS whispernet_display_name TEXT,
    ADD COLUMN IF NOT EXISTS whispernet_show_city BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS whisper_notification_pref TEXT NOT NULL DEFAULT 'daily'
        CHECK (whisper_notification_pref IN ('off', 'daily', 'realtime'));

-- Create indexes for new columns
CREATE INDEX IF NOT EXISTS idx_stories_whispernet_published ON public.stories(whispernet_published) WHERE whispernet_published = true;
CREATE INDEX IF NOT EXISTS idx_user_preferences_whisper_notification ON public.user_preferences(whisper_notification_pref);
