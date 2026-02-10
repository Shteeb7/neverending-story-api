# Quick Start Guide - AI Generation Engine

Get the AI story generation engine up and running in 5 minutes.

## Prerequisites

- ✅ Node.js installed
- ✅ Supabase project set up
- ✅ Anthropic API key (Claude)

## Setup Steps

### 1. Install Dependencies

```bash
npm install @anthropic-ai/sdk
```

### 2. Configure Environment

Create or update `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-api03-...
SUPABASE_URL=https://yourproject.supabase.co
SUPABASE_SERVICE_KEY=your_service_key_here
```

### 3. Run Database Migration

**Option A - Supabase Dashboard (Recommended):**

1. Go to https://app.supabase.com
2. Select your project
3. Click "SQL Editor" in sidebar
4. Click "New Query"
5. Copy entire contents of `database/migrations/002_generation_engine.sql`
6. Paste and click "Run"

**Option B - Supabase CLI:**

```bash
supabase db push
```

### 4. Verify Setup

```bash
node scripts/test-generation.js
```

This runs through the generation pipeline:
- ✅ Cost calculation
- ✅ Generate 3 premises (~10 sec)
- ✅ Generate story bible (~60 sec)
- ✅ Generate arc outline (~40 sec)
- ✅ Generate chapter 1 (~120 sec)

**Total time:** ~4-5 minutes
**Total cost:** ~$2.20

### 5. Test Full Pre-Generation (Optional)

```bash
node scripts/test-generation.js --full
```

This generates a complete story (bible + arc + 8 chapters).

**Total time:** ~10-15 minutes
**Total cost:** ~$8.45

## API Usage

### Generate Story Premises

```bash
curl -X POST http://localhost:3000/onboarding/generate-premises \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
  "success": true,
  "premises": [
    {
      "title": "The Dragon's Apprentice",
      "description": "A young explorer discovers...",
      "hook": "What if dragons taught humans to fly?",
      "genre": "fantasy",
      "themes": ["adventure", "friendship"],
      "age_range": "8-12"
    }
  ],
  "premisesId": "uuid"
}
```

### Start Story Generation

```bash
curl -X POST http://localhost:3000/story/select-premise \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"premiseId": "UUID_FROM_ABOVE"}'
```

**Response:**
```json
{
  "success": true,
  "storyId": "story-uuid",
  "status": "generating",
  "message": "Story generation started. Check status with GET /story/generation-status/:storyId",
  "estimatedTime": "10-15 minutes"
}
```

### Check Generation Progress

```bash
curl -X GET http://localhost:3000/story/generation-status/STORY_UUID \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "storyId": "uuid",
  "title": "The Dragon's Apprentice",
  "status": "generating",
  "progress": {
    "bible_complete": true,
    "arc_complete": true,
    "chapters_generated": 5,
    "current_step": "generating_chapter_6",
    "last_updated": "2026-02-09T12:34:56Z"
  },
  "chaptersAvailable": 5,
  "error": null
}
```

### Generate Additional Chapters

```bash
curl -X POST http://localhost:3000/story/STORY_UUID/generate-next \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"count": 1}'
```

**Response:**
```json
{
  "success": true,
  "message": "Generated 1 chapter(s)",
  "chapters": [
    {
      "id": "chapter-uuid",
      "chapter_number": 9,
      "title": "The Secret Cave",
      "word_count": 3200
    }
  ]
}
```

### Read Generated Chapters

```bash
curl -X GET http://localhost:3000/story/STORY_UUID/chapters \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "storyId": "uuid",
  "chapters": [
    {
      "id": "uuid",
      "chapter_number": 1,
      "title": "The First Flight",
      "content": "Long chapter text here...",
      "word_count": 3150,
      "quality_score": 8,
      "created_at": "2026-02-09T12:00:00Z"
    }
  ]
}
```

## Cost Breakdown

| Operation | Time | Cost |
|-----------|------|------|
| Generate 3 Premises | ~10s | $0.05 |
| Generate Story Bible | ~60s | $0.75 |
| Generate Arc Outline | ~40s | $0.50 |
| Generate 1 Chapter | ~120s | $0.90 |
| Full Pre-Generation (8 chapters) | ~15min | $8.45 |

## Monitoring

### Check API Costs

```sql
SELECT
  operation,
  SUM(cost) as total_cost,
  COUNT(*) as calls,
  AVG(cost) as avg_cost
FROM api_costs
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY operation;
```

### Check Story Status

```sql
SELECT
  status,
  COUNT(*) as count
FROM stories
GROUP BY status;
```

### Check Quality Scores

```sql
SELECT
  AVG(quality_score) as avg_score,
  MIN(quality_score) as min_score,
  MAX(quality_score) as max_score,
  AVG(regeneration_count) as avg_regenerations
FROM chapters
WHERE quality_pass_completed = true;
```

## Troubleshooting

### Error: "User preferences not found"
**Fix:** User must complete onboarding first via `POST /onboarding/process-transcript`

### Error: "Story is still in initial generation"
**Fix:** Wait for pre-generation to complete (check with `/generation-status`)

### Error: "Premise not found"
**Fix:** Ensure premiseId is valid and belongs to the user

### Error: Rate limit (429/529)
**Fix:** Wait 60 seconds and retry. Check if you're hitting Claude API limits.

### Error: "Failed to parse JSON"
**Fix:** Claude response format issue. Check generation.js prompts and parseAndValidateJSON().

## Next Steps

1. ✅ Set up RLS policies (see DATABASE_SETUP.md)
2. ✅ Configure monitoring/alerts
3. ✅ Test with real user accounts
4. ✅ Monitor costs in production
5. ✅ Implement caching if needed
6. ✅ Add webhooks for progress updates (optional)

## Support

- **Full Documentation:** See IMPLEMENTATION_SUMMARY.md
- **Service API Docs:** See src/services/README.md
- **Database Setup:** See DATABASE_SETUP.md
- **Test Suite:** Run `node scripts/test-generation.js`

---

**Ready to generate stories!** 🎉

Start with `POST /onboarding/generate-premises` and follow the flow above.
