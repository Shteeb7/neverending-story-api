# Database Setup for AI Generation Engine

This guide walks you through setting up the database tables needed for the AI story generation engine.

## Quick Setup

### Option 1: Supabase Dashboard (Recommended)

1. Go to your Supabase project dashboard
2. Navigate to **SQL Editor** in the left sidebar
3. Click **New Query**
4. Copy the entire contents of `database/migrations/002_generation_engine.sql`
5. Paste into the SQL editor
6. Click **Run** to execute

### Option 2: Supabase CLI

If you have the Supabase CLI installed:

```bash
supabase db push
```

Or apply the migration directly:

```bash
psql $DATABASE_URL < database/migrations/002_generation_engine.sql
```

## Tables Created

### 1. story_bibles
Stores comprehensive world-building, characters, and story structure.

**Columns:**
- `id` - UUID primary key
- `user_id` - References auth.users
- `premise_id` - References story_premises
- `title` - Story title
- `world_rules` - JSONB with magic systems, technology, society
- `characters` - JSONB with protagonist, antagonist, supporting cast
- `central_conflict` - JSONB with main problem and complications
- `stakes` - JSONB with personal, broader, and emotional stakes
- `themes` - JSONB array of themes
- `key_locations` - JSONB array of important settings
- `timeline` - JSONB with story duration and milestones
- `created_at` - Timestamp

### 2. story_arcs
Stores 12-chapter story outlines with pacing.

**Columns:**
- `id` - UUID primary key
- `story_id` - References stories
- `bible_id` - References story_bibles
- `chapters` - JSONB array of 12 chapter outlines
- `pacing_notes` - Text with pacing strategy
- `story_threads` - JSONB with main plot and subplots
- `created_at` - Timestamp

### 3. api_costs
Tracks all AI API usage and costs.

**Columns:**
- `id` - UUID primary key
- `user_id` - References auth.users
- `story_id` - References stories (nullable)
- `provider` - Text (e.g., 'claude')
- `model` - Text (e.g., 'claude-opus-4-6')
- `operation` - Text (e.g., 'generate_chapter')
- `input_tokens` - Integer
- `output_tokens` - Integer
- `total_tokens` - Integer
- `cost` - Decimal(10, 6) in USD
- `metadata` - JSONB with additional context
- `created_at` - Timestamp

## Enhanced Existing Tables

### stories (added columns)
- `bible_id` - UUID reference to story_bibles
- `generation_progress` - JSONB with:
  - `bible_complete` - Boolean
  - `arc_complete` - Boolean
  - `chapters_generated` - Number
  - `current_step` - String
  - `last_updated` - Timestamp
- `error_message` - Text for generation failures

### chapters (added columns)
- `quality_score` - Integer (1-10)
- `quality_review` - JSONB with:
  - `score` - Average score
  - `criteria_scores` - Object with 6 criteria
  - `strengths` - Array of strengths
  - `issues` - Array of issues
  - `revision_notes` - String
  - `pass` - Boolean
- `quality_pass_completed` - Boolean
- `regeneration_count` - Integer (how many times regenerated)
- `metadata` - JSONB with:
  - `opening_hook` - String
  - `closing_hook` - String
  - `key_events` - Array
  - `character_development` - String

### story_premises (added columns)
- `status` - Text ('offered', 'selected', 'rejected')
- `preferences_used` - JSONB with user preferences that generated this premise

## Verification

After running the migration, verify the setup:

```sql
-- Check that all tables exist
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('story_bibles', 'story_arcs', 'api_costs');

-- Check stories table enhancements
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'stories'
  AND column_name IN ('bible_id', 'generation_progress', 'error_message');

-- Check chapters table enhancements
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'chapters'
  AND column_name IN ('quality_score', 'quality_review', 'quality_pass_completed', 'regeneration_count', 'metadata');
```

## Rollback (if needed)

If you need to undo these changes:

```sql
-- Drop new tables
DROP TABLE IF EXISTS story_arcs CASCADE;
DROP TABLE IF EXISTS story_bibles CASCADE;
DROP TABLE IF EXISTS api_costs CASCADE;

-- Remove added columns from stories
ALTER TABLE stories DROP COLUMN IF EXISTS bible_id;
ALTER TABLE stories DROP COLUMN IF EXISTS generation_progress;
ALTER TABLE stories DROP COLUMN IF EXISTS error_message;

-- Remove added columns from chapters
ALTER TABLE chapters DROP COLUMN IF EXISTS quality_score;
ALTER TABLE chapters DROP COLUMN IF EXISTS quality_review;
ALTER TABLE chapters DROP COLUMN IF EXISTS quality_pass_completed;
ALTER TABLE chapters DROP COLUMN IF EXISTS regeneration_count;
ALTER TABLE chapters DROP COLUMN IF EXISTS metadata;

-- Remove added columns from story_premises
ALTER TABLE story_premises DROP COLUMN IF EXISTS status;
ALTER TABLE story_premises DROP COLUMN IF EXISTS preferences_used;
```

## Row Level Security (RLS)

After migration, set up RLS policies:

```sql
-- Enable RLS on new tables
ALTER TABLE story_bibles ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_arcs ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_costs ENABLE ROW LEVEL SECURITY;

-- story_bibles policies
CREATE POLICY "Users can view their own bibles"
  ON story_bibles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own bibles"
  ON story_bibles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- story_arcs policies
CREATE POLICY "Users can view arcs for their stories"
  ON story_arcs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM stories
      WHERE stories.id = story_arcs.story_id
      AND stories.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create arcs for their stories"
  ON story_arcs FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM stories
      WHERE stories.id = story_arcs.story_id
      AND stories.user_id = auth.uid()
    )
  );

-- api_costs policies
CREATE POLICY "Users can view their own costs"
  ON api_costs FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can insert costs (for logging from backend)
CREATE POLICY "Service role can insert costs"
  ON api_costs FOR INSERT
  WITH CHECK (true);
```

## Testing the Setup

Run a simple query to verify everything works:

```sql
-- Test inserting a test bible
INSERT INTO story_bibles (
  user_id,
  title,
  world_rules,
  characters,
  central_conflict,
  stakes,
  themes,
  key_locations,
  timeline
) VALUES (
  auth.uid(),
  'Test Story',
  '{"magic_system": "test"}',
  '{"protagonist": {"name": "Test Hero"}}',
  '{"description": "Test conflict"}',
  '{"personal": "Test stakes"}',
  '["adventure"]',
  '[{"name": "Test Location"}]',
  '{"total_duration": "1 week"}'
);

-- Verify insert
SELECT * FROM story_bibles WHERE title = 'Test Story';

-- Clean up test data
DELETE FROM story_bibles WHERE title = 'Test Story';
```

## Next Steps

Once the migration is complete:

1. ✅ Verify all tables exist
2. ✅ Set up RLS policies (see above)
3. ✅ Test the generation service with `npm test` (once tests are created)
4. ✅ Monitor costs in the `api_costs` table
5. ✅ Set up alerts for high API usage (optional)

## Troubleshooting

### "relation already exists" errors
These are safe to ignore - it means the table or column was already created.

### Permission denied errors
Make sure you're using the service role key or have proper database permissions.

### RLS policy errors
If queries fail with RLS errors, check that the user is authenticated and policies are set up correctly.

### Migration won't run
Try running statements individually in the SQL editor to identify the problematic statement.
