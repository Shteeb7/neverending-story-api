# Migration 003: Apply Instructions

## Status: ⚠️ NOT YET APPLIED TO DATABASE

The migration file exists but hasn't been applied to the production database yet.

---

## What This Migration Does

Migration 003 adds the **Feedback & Sequel System** to the database:

### New Tables (3)
1. **`story_feedback`** - Stores reader feedback at checkpoints (chapters 3, 6, 9)
2. **`book_completion_interviews`** - Stores voice interviews after chapter 12
3. **`story_series_context`** - Stores continuity data for sequels

### New Columns in `stories` Table (3)
1. **`series_id`** - Links all books in the same series
2. **`book_number`** - Position in series (1, 2, 3...)
3. **`parent_story_id`** - Reference to previous book

---

## How to Apply the Migration

### Option 1: Via Supabase Dashboard (EASIEST)

1. Go to https://supabase.com/dashboard
2. Select your project: **NeverendingStory**
3. Click **SQL Editor** in the left sidebar
4. Click **+ New Query**
5. Copy the contents of `database/migrations/003_feedback_and_series.sql`
6. Paste into the query editor
7. Click **Run** (or press Cmd+Enter)
8. Wait for "Success. No rows returned"

### Option 2: Via Command Line

If you have `psql` installed and have the database connection string:

```bash
# Get your connection string from Supabase Dashboard > Project Settings > Database
# It looks like: postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres

psql "postgresql://postgres:YOUR_PASSWORD@db.your-project.supabase.co:5432/postgres" \
  -f database/migrations/003_feedback_and_series.sql
```

### Option 3: Via Node.js Script (if credentials work)

```bash
# First, update .env with valid credentials from Supabase Dashboard
# Then run:
node apply-migration-003.js
```

---

## Verification

After applying the migration, verify it worked:

```bash
node verify-migration-003.js
```

You should see:
```
✅ story_feedback
✅ book_completion_interviews
✅ story_series_context
✅ stories.series_id
✅ stories.book_number
✅ stories.parent_story_id

🎉 Migration 003 is FULLY APPLIED!
```

---

## Current Issue: Invalid API Key

The verification script shows "Invalid API key" errors. This means:

1. **Supabase credentials in `.env` are outdated/invalid**
2. **Solution:** Get new credentials from Supabase Dashboard:
   - Go to Project Settings > API
   - Copy the `service_role` key (secret, not anon public)
   - Copy the Project URL
   - Update `.env` file:
     ```
     SUPABASE_URL=https://your-project.supabase.co
     SUPABASE_SERVICE_KEY=eyJhbGc... (service_role key)
     ```

---

## What Happens After Migration is Applied?

Once migration 003 is applied, the backend will automatically:

1. ✅ Generate **6 initial chapters** (instead of 12)
2. ✅ Show **feedback dialogs** at chapters 4, 7, and 10
3. ✅ Auto-generate **chapters 7-9** based on Chapter 3 feedback
4. ✅ Auto-generate **chapters 10-12** based on Chapter 6 feedback
5. ✅ Enable **voice interviews** after chapter 12
6. ✅ Allow **unlimited sequels** (Book 2, 3, 4...) with character continuity

---

## Files Related to This Migration

- **Migration SQL:** `database/migrations/003_feedback_and_series.sql`
- **Backend Routes:** `src/routes/feedback.js`
- **Sequel Logic:** `src/services/generation.js` (lines 1019-1300)
- **iOS Integration:** `Views/Feedback/*.swift`
- **Verification Script:** `verify-migration-003.js`

---

## Next Steps

1. **Update Supabase credentials** in `.env` (if needed)
2. **Apply migration** via Supabase Dashboard (easiest method)
3. **Run verification:** `node verify-migration-003.js`
4. **Test the system:** Create a new story and read to chapter 4 to see feedback dialog

---

**Last Updated:** 2026-02-12
**Status:** Migration file created ✅ | Applied to database ⚠️ (pending)
