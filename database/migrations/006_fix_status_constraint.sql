-- Migration 006: Fix stories status constraint to include 'error' and 'generating'
-- Date: 2026-02-13
-- Description: Allows setting stories to error/generating status for better generation tracking

-- Drop the old constraint
ALTER TABLE stories DROP CONSTRAINT IF EXISTS stories_status_check;

-- Add new constraint with additional statuses
ALTER TABLE stories ADD CONSTRAINT stories_status_check
  CHECK (status IN ('active', 'abandoned', 'completed', 'archived', 'error', 'generating'));

-- Verify the constraint
SELECT conname, consrc FROM pg_constraint WHERE conname = 'stories_status_check';
