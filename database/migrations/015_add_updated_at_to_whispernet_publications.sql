/**
 * Migration 015: Add updated_at to whispernet_publications
 *
 * Adds updated_at column for tracking recall cooldown periods.
 * Initialized to published_at for existing rows.
 */

-- Add updated_at column
ALTER TABLE whispernet_publications
ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();

-- Set updated_at to published_at for existing rows (so recalls have correct baseline)
UPDATE whispernet_publications
SET updated_at = published_at
WHERE updated_at IS NULL;

-- Make it non-nullable now that we've backfilled
ALTER TABLE whispernet_publications
ALTER COLUMN updated_at SET NOT NULL;

-- Create trigger to auto-update updated_at on row changes
CREATE OR REPLACE FUNCTION update_whispernet_publications_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_whispernet_publications_updated_at
BEFORE UPDATE ON whispernet_publications
FOR EACH ROW
EXECUTE FUNCTION update_whispernet_publications_updated_at();
