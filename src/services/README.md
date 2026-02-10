# AI Generation Service

This service handles all AI-powered story generation using Claude Opus 4.6.

## Overview

The generation pipeline transforms user preferences into complete stories through five main stages:

1. **Premise Generation** - Creates 3 unique story concepts from user preferences
2. **Bible Creation** - Builds comprehensive world-building and character details
3. **Arc Outlining** - Structures a 12-chapter story outline
4. **Chapter Generation** - Writes individual chapters (2500-3500 words each)
5. **Quality Review** - Evaluates and regenerates chapters as needed

## Functions

### `generatePremises(userId, preferences)`
Generates 3 unique story premises from user preferences.

**Input:**
- `userId`: User UUID
- `preferences`: Object with `favorite_series`, `favorite_genres`, `loved_elements`, `disliked_elements`

**Output:**
```javascript
{
  premises: [
    {
      title: "Story Title",
      description: "2-3 sentence description",
      hook: "One sentence hook",
      genre: "fantasy",
      themes: ["theme1", "theme2"],
      age_range: "8-12"
    }
  ],
  premisesId: "uuid"
}
```

**Cost:** ~$0.05
**Time:** ~5-10 seconds

---

### `generateStoryBible(premiseId, userId)`
Creates comprehensive story bible and initializes story record.

**Input:**
- `premiseId`: UUID of selected premise
- `userId`: User UUID

**Output:**
```javascript
{
  bible: {
    title: "Story Title",
    world_rules: { ... },
    characters: { protagonist, antagonist, supporting },
    central_conflict: { ... },
    stakes: { ... },
    themes: [...],
    key_locations: [...],
    timeline: { ... }
  },
  storyId: "uuid"
}
```

**Cost:** ~$0.75
**Time:** ~30-60 seconds

---

### `generateArcOutline(storyId, userId)`
Creates 12-chapter story structure following 3-act format.

**Input:**
- `storyId`: UUID of story
- `userId`: User UUID

**Output:**
```javascript
{
  arc: {
    chapters: [
      {
        chapter_number: 1,
        title: "Chapter Title",
        events_summary: "What happens",
        character_focus: "Who is featured",
        tension_level: "low/medium/high",
        key_revelations: [...],
        word_count_target: 3000
      }
      // ... 12 chapters total
    ],
    pacing_notes: "Overall strategy",
    story_threads: { ... }
  }
}
```

**Cost:** ~$0.50
**Time:** ~20-40 seconds

---

### `generateChapter(storyId, chapterNumber, userId)`
Generates a single chapter with quality review and optional regeneration.

**Process:**
1. Generate chapter content (2500-3500 words)
2. Run quality review (score 1-10 on 6 criteria)
3. If score < 7, regenerate with feedback (max 2 regenerations)
4. Store final chapter in database

**Input:**
- `storyId`: UUID of story
- `chapterNumber`: Integer (1-12)
- `userId`: User UUID

**Output:**
```javascript
{
  id: "uuid",
  chapter_number: 1,
  title: "Chapter Title",
  content: "Full chapter text...",
  word_count: 3000,
  quality_score: 8,
  quality_review: { ... },
  regeneration_count: 0
}
```

**Cost:** ~$0.90 (can be ~$1.50 if regenerated)
**Time:** ~60-120 seconds

---

### `orchestratePreGeneration(storyId, userId)`
Runs the complete generation pipeline: Bible → Arc → Chapters 1-8.

**Process:**
1. Generate arc outline
2. Generate chapters 1-8 sequentially
3. 1-second pause between chapters
4. Update `generation_progress` after each step
5. Set story status to `active` on completion

**Input:**
- `storyId`: UUID of story (bible must already exist)
- `userId`: User UUID

**Output:** None (updates database directly)

**Cost:** ~$8.45 total
- Bible: $0.75
- Arc: $0.50
- Chapters 1-8: $7.20

**Time:** 10-15 minutes

**Error Handling:**
- Progress saved at each step
- On failure, story status set to `error` with message
- Completed chapters remain in database

## Utility Functions

### `callClaudeWithRetry(messages, maxTokens, metadata, attempts)`
Wraps Claude API calls with retry logic.

**Features:**
- Exponential backoff: 0s, 1s, 2s delays
- Retries on rate limits (529), overloaded errors, network timeouts
- Returns `{ response, inputTokens, outputTokens, cost }`

### `logApiCost(userId, operation, inputTokens, outputTokens, metadata)`
Records API usage to `api_costs` table.

**Never throws** - logs errors to console instead.

### `calculateCost(inputTokens, outputTokens)`
Computes USD cost using Claude Opus 4.6 pricing:
- $15 per million input tokens
- $75 per million output tokens

### `parseAndValidateJSON(jsonString, requiredFields)`
Safely parses Claude responses with fallbacks:
1. Try direct `JSON.parse()`
2. Try extracting from markdown code blocks
3. Validate required fields exist
4. Throw descriptive errors

### `updateGenerationProgress(storyId, progressData)`
Updates `stories.generation_progress` with:
- `bible_complete`: boolean
- `arc_complete`: boolean
- `chapters_generated`: number
- `current_step`: string
- `last_updated`: timestamp

## Database Tables

### story_bibles
Stores comprehensive world-building and character information.

### story_arcs
Stores 12-chapter outlines with pacing details.

### chapters (enhanced)
Added columns:
- `quality_score`: Integer (1-10)
- `quality_review`: JSONB with detailed review
- `quality_pass_completed`: Boolean
- `regeneration_count`: Integer
- `metadata`: JSONB (opening_hook, closing_hook, key_events, character_development)

### stories (enhanced)
Added columns:
- `bible_id`: UUID reference
- `generation_progress`: JSONB tracking status
- `error_message`: Text for failures

### api_costs
Tracks every API call:
- `user_id`, `story_id`
- `provider`, `model`, `operation`
- `input_tokens`, `output_tokens`, `total_tokens`
- `cost`: Decimal(10, 6)
- `metadata`: JSONB
- `created_at`

## Rate Limits

Claude Opus 4.6 limits:
- 50 requests/minute
- 200,000 tokens/minute

Our usage (pre-generation):
- ~25 requests over 10 minutes
- ~120,000 tokens over 10 minutes

**Well within limits** with 1-second pauses between chapters.

## Error Handling

### Retries
All Claude calls retry 3 times with exponential backoff on:
- 529 errors (rate limits)
- `overloaded_error`
- Network timeouts

### Cost Logging
Cost logging failures are **non-fatal** - logged to console only.

### Orchestration Failures
If chapter 5 fails:
- Chapters 1-4 remain in database
- Story status set to `error`
- Error message stored in `stories.error_message`
- User can retry from last successful chapter

### JSON Parsing
Handles both raw JSON and markdown-wrapped JSON responses from Claude.

## Quality Assurance

### Review Criteria (1-10 scale)
1. **Age-appropriateness** - Language and content for 8-12 year olds
2. **Engagement** - Maintains reader interest
3. **Pacing** - Balance of action, dialogue, description
4. **Character Consistency** - Characters act true to traits
5. **Arc Alignment** - Follows outline, advances plot
6. **Writing Quality** - Strong prose, vivid descriptions

### Pass Threshold
- Score >= 7 = Pass
- Score < 7 = Regenerate with feedback (max 2 regenerations)

### Expected Pass Rate
**>85%** of chapters pass on first attempt.

## Usage Examples

### Generate Premises
```javascript
const { generatePremises } = require('./services/generation');

const preferences = {
  favorite_series: ['Harry Potter'],
  favorite_genres: ['fantasy', 'adventure'],
  loved_elements: ['magic', 'friendship'],
  disliked_elements: ['excessive violence']
};

const { premises, premisesId } = await generatePremises(userId, preferences);
```

### Full Story Generation
```javascript
const { generateStoryBible, orchestratePreGeneration } = require('./services/generation');

// Step 1: Create bible and story
const { storyId } = await generateStoryBible(premiseId, userId);

// Step 2: Generate arc + 8 chapters (async)
orchestratePreGeneration(storyId, userId).catch(console.error);

// Poll for progress
const { data: story } = await supabase
  .from('stories')
  .select('status, generation_progress')
  .eq('id', storyId)
  .single();
```

### Generate Additional Chapter
```javascript
const { generateChapter } = require('./services/generation');

const chapter = await generateChapter(storyId, 9, userId);
console.log(`Chapter ${chapter.chapter_number}: ${chapter.title}`);
console.log(`Quality score: ${chapter.quality_score}/10`);
```

## Cost Tracking

All costs are logged to the `api_costs` table for:
- User billing
- Cost analysis
- Usage monitoring

Query total cost per story:
```sql
SELECT
  story_id,
  SUM(cost) as total_cost,
  SUM(total_tokens) as total_tokens,
  COUNT(*) as api_calls
FROM api_costs
WHERE story_id = 'uuid'
GROUP BY story_id;
```

Query cost per operation:
```sql
SELECT
  operation,
  AVG(cost) as avg_cost,
  MIN(cost) as min_cost,
  MAX(cost) as max_cost
FROM api_costs
GROUP BY operation;
```
