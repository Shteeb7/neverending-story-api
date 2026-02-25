-- World Codex: Structured, genre-adaptive world rules per story
CREATE TABLE IF NOT EXISTS world_codex (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  genre TEXT NOT NULL,
  codex_data JSONB NOT NULL,
  token_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(story_id)
);
CREATE INDEX IF NOT EXISTS idx_world_codex_story ON world_codex(story_id);
ALTER TABLE world_codex ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own story codex" ON world_codex FOR SELECT USING (story_id IN (SELECT id FROM stories WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on world_codex" ON world_codex FOR ALL USING (true) WITH CHECK (true);

-- World State Ledger: Per-chapter world facts tracking
CREATE TABLE IF NOT EXISTS world_state_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL,
  ledger_data JSONB NOT NULL,
  compressed_summary TEXT,
  token_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(story_id, chapter_number)
);
CREATE INDEX IF NOT EXISTS idx_world_ledger_story ON world_state_ledger(story_id, chapter_number);
ALTER TABLE world_state_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own story world ledger" ON world_state_ledger FOR SELECT USING (story_id IN (SELECT id FROM stories WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on world_state_ledger" ON world_state_ledger FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE world_codex IS 'Structured, genre-specific world rules extracted from story bible — one per story';
COMMENT ON TABLE world_state_ledger IS 'Per-chapter world state tracking: facts established, rules demonstrated, promises planted';
