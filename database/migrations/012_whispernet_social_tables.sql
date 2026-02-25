-- Migration 012: WhisperNet Social Tables
-- Creates all tables needed for the social reading layer:
-- whisper_events, resonances, whisper_backs, earned_badges, content_reviews, content_reports,
-- recommendation_impressions, pending_claims
-- Also adds columns to share_links and stories

-- 1. Create whisper_events table
CREATE TABLE IF NOT EXISTS whisper_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL CHECK (event_type IN (
        'book_finished',
        'resonance_left',
        'badge_earned',
        'book_published',
        'book_gifted',
        'book_claimed'
    )),
    actor_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    story_id UUID REFERENCES stories(id) ON DELETE CASCADE, -- nullable for user-level events like badges
    metadata JSONB DEFAULT '{}', -- event-specific data, privacy baked in at write time
    is_public BOOLEAN DEFAULT true, -- controls visibility in feeds
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for whisper_events
CREATE INDEX IF NOT EXISTS idx_whisper_events_story_created ON whisper_events(story_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whisper_events_actor_created ON whisper_events(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whisper_events_type_created ON whisper_events(event_type, created_at DESC);

COMMENT ON TABLE whisper_events IS 'Feed of all WhisperNet activity. Privacy baked in at write time via metadata JSONB.';
COMMENT ON COLUMN whisper_events.metadata IS 'Event-specific data. Includes display_name and city (if allowed) at write time. Never needs resolution.';

-- 2. Create resonances table
CREATE TABLE IF NOT EXISTS resonances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    word TEXT NOT NULL, -- single Resonance word (e.g., "hope", "longing", "defiance")
    sentiment TEXT, -- positive/negative/neutral/mixed
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(story_id, user_id) -- one Resonance per reader per story
);

COMMENT ON TABLE resonances IS 'Reader Resonance words left after finishing WhisperNet books.';

-- 3. Create whisper_backs table
CREATE TABLE IF NOT EXISTS whisper_backs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resonance_id UUID NOT NULL REFERENCES resonances(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    message TEXT NOT NULL CHECK (char_length(message) <= 280),
    display_name TEXT NOT NULL, -- snapshot of whispernet_display_name at write time
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(resonance_id, user_id) -- one whisper back per reader per resonance
);

COMMENT ON TABLE whisper_backs IS 'Short messages readers leave for story authors after Resonance.';
COMMENT ON COLUMN whisper_backs.display_name IS 'Snapshot at write time. Privacy locked in.';

-- 4. Create earned_badges table
CREATE TABLE IF NOT EXISTS earned_badges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    badge_type TEXT NOT NULL CHECK (badge_type IN (
        'ember',
        'current',
        'worldwalker',
        'resonant',
        'wanderer',
        'lamplighter',
        'chainmaker'
    )),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, -- for user-level badges
    story_id UUID REFERENCES stories(id) ON DELETE CASCADE, -- for story-level badges (ember, current, worldwalker, resonant)
    earned_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(badge_type, user_id, story_id) -- idempotent: same badge can't be earned twice for same story
);

COMMENT ON TABLE earned_badges IS 'Badges earned by users, split into story-level and user-level achievements.';

-- 5. Create content_reviews table
CREATE TABLE IF NOT EXISTS content_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    publisher_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ai_rating TEXT NOT NULL, -- AI's proposed maturity rating
    publisher_rating TEXT, -- publisher's counter-proposal
    final_rating TEXT, -- resolved rating (set by internal review)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'resolved',
        'escalated'
    )),
    prospero_conversation JSONB, -- transcript of Prospero classification conversation
    created_at TIMESTAMPTZ DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

COMMENT ON TABLE content_reviews IS 'AI maturity classification disputes requiring internal review.';

-- 6. Create content_reports table
CREATE TABLE IF NOT EXISTS content_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    reporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK (reason IN (
        'inappropriate_content',
        'wrong_maturity_rating',
        'spam',
        'other'
    )),
    detail TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'reviewed',
        'action_taken',
        'dismissed'
    )),
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(story_id, reporter_id) -- one report per user per story
);

COMMENT ON TABLE content_reports IS 'User-submitted reports of problematic content on WhisperNet.';

-- 7. Create recommendation_impressions table
CREATE TABLE IF NOT EXISTS recommendation_impressions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    shown_at TIMESTAMPTZ DEFAULT now(),
    action TEXT CHECK (action IN ('added', 'dismissed', 'ignored')), -- what the user did
    UNIQUE(user_id, story_id) -- track each story impression once per user
);

COMMENT ON TABLE recommendation_impressions IS 'Tracks which stories were shown to which users in discovery to prevent repeats.';

-- 8. Create pending_claims table
CREATE TABLE IF NOT EXISTS pending_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token UUID NOT NULL, -- the share link token
    email TEXT NOT NULL, -- email the link was shared with (for deferred claiming after signup)
    created_at TIMESTAMPTZ DEFAULT now(),
    claimed BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_pending_claims_email ON pending_claims(email);

COMMENT ON TABLE pending_claims IS 'Deferred deep links: gift links saved for users who signed up after receiving the link.';

-- 9. Add columns to existing tables

-- Add to share_links for share chain tracking
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS parent_link_id UUID REFERENCES share_links(id) ON DELETE SET NULL;
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS share_chain_depth INTEGER DEFAULT 0;

COMMENT ON COLUMN share_links.parent_link_id IS 'Links to the share_link through which the sharer received this book (for viral chain tracking).';
COMMENT ON COLUMN share_links.share_chain_depth IS 'Depth in the share chain. 0 = original publisher, 1 = first reshare, etc.';

-- Add to stories for content classification status
ALTER TABLE stories ADD COLUMN IF NOT EXISTS content_classification_status TEXT CHECK (content_classification_status IN (
    'pending',
    'ai_classified',
    'publisher_confirmed',
    'disputed',
    'escalated',
    'resolved'
));

COMMENT ON COLUMN stories.content_classification_status IS 'Tracks the maturity classification flow state.';

-- 10. RLS Policies

-- whisper_events: All authenticated users can SELECT public events. Users can INSERT their own events.
ALTER TABLE whisper_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY whisper_events_select_public ON whisper_events
    FOR SELECT
    USING (is_public = true);

CREATE POLICY whisper_events_insert_own ON whisper_events
    FOR INSERT
    WITH CHECK (actor_id = auth.uid());

-- resonances: Creator can INSERT/SELECT own. All authenticated can SELECT (public data).
ALTER TABLE resonances ENABLE ROW LEVEL SECURITY;

CREATE POLICY resonances_select_all ON resonances
    FOR SELECT
    USING (true);

CREATE POLICY resonances_insert_own ON resonances
    FOR INSERT
    WITH CHECK (user_id = auth.uid());

-- whisper_backs: Creator can INSERT/SELECT own. Story owner can SELECT all on their stories.
ALTER TABLE whisper_backs ENABLE ROW LEVEL SECURITY;

CREATE POLICY whisper_backs_select_own ON whisper_backs
    FOR SELECT
    USING (user_id = auth.uid() OR EXISTS (
        SELECT 1 FROM resonances r
        JOIN stories s ON r.story_id = s.id
        WHERE r.id = whisper_backs.resonance_id
        AND s.user_id = auth.uid()
    ));

CREATE POLICY whisper_backs_insert_own ON whisper_backs
    FOR INSERT
    WITH CHECK (user_id = auth.uid());

-- earned_badges: Owner can SELECT own. Public can SELECT (badges are public achievements).
ALTER TABLE earned_badges ENABLE ROW LEVEL SECURITY;

CREATE POLICY earned_badges_select_all ON earned_badges
    FOR SELECT
    USING (true);

-- content_reviews: Publisher can SELECT own. (Admin role check to be added later)
ALTER TABLE content_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY content_reviews_select_own ON content_reviews
    FOR SELECT
    USING (publisher_id = auth.uid());

-- content_reports: Reporter can INSERT/SELECT own. (Admin role check to be added later)
ALTER TABLE content_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY content_reports_select_own ON content_reports
    FOR SELECT
    USING (reporter_id = auth.uid());

CREATE POLICY content_reports_insert_own ON content_reports
    FOR INSERT
    WITH CHECK (reporter_id = auth.uid());

-- recommendation_impressions: Owner can SELECT/INSERT/UPDATE own.
ALTER TABLE recommendation_impressions ENABLE ROW LEVEL SECURITY;

CREATE POLICY recommendation_impressions_all_own ON recommendation_impressions
    FOR ALL
    USING (user_id = auth.uid());

-- pending_claims: No direct user access — server-side only via service key.
ALTER TABLE pending_claims ENABLE ROW LEVEL SECURITY;

-- 11. Data Retention: pg_cron job to delete old whisper_events
-- NOTE: This must be set up manually in Supabase Dashboard > Database > Cron Jobs
-- Job name: cleanup_old_whisper_events
-- Schedule: 0 3 * * * (daily at 3am UTC)
-- Command:
-- DELETE FROM whisper_events
-- WHERE created_at < now() - interval '90 days'
-- AND event_type != 'badge_earned';
--
-- (badge_earned events are permanent achievements and should never be deleted)

COMMENT ON TABLE whisper_events IS 'Feed of all WhisperNet activity. Privacy baked in at write time via metadata JSONB. Auto-cleanup: events older than 90 days are deleted (except badge_earned).';
