-- Comprehensive schema check for all tables used in generation pipeline
-- Run this in Supabase SQL Editor

SELECT
  table_name,
  column_name,
  data_type,
  is_nullable,
  column_default,
  CASE WHEN is_nullable = 'NO' THEN '⚠️ REQUIRED' ELSE '✓ optional' END as requirement
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('stories', 'story_bibles', 'story_arcs', 'chapters', 'story_premises', 'api_costs')
ORDER BY
  table_name,
  CASE WHEN is_nullable = 'NO' THEN 0 ELSE 1 END,
  column_name;
