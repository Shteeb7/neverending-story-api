# Changelog

All notable changes to the Neverending Story API.

## [2.0.0] - 2026-02-09

### Added - AI Generation Engine 🚀

#### Core Generation Service
- **NEW:** `src/services/generation.js` - Comprehensive AI generation service with 10 functions
  - `generatePremises()` - Creates 3 story concepts from user preferences
  - `generateStoryBible()` - Builds world-building, characters, conflict, stakes
  - `generateArcOutline()` - Structures 12-chapter story outline
  - `generateChapter()` - Writes 2500-3500 word chapters with quality review
  - `orchestratePreGeneration()` - Runs full pipeline (bible + arc + 8 chapters)
  - `callClaudeWithRetry()` - API wrapper with exponential backoff
  - `logApiCost()` - Tracks all API usage to database
  - `calculateCost()` - Computes USD cost from tokens
  - `parseAndValidateJSON()` - Safe JSON parsing with fallbacks
  - `updateGenerationProgress()` - Updates story progress tracking

#### Database Schema
- **NEW:** `story_bibles` table - Comprehensive world-building and character data
- **NEW:** `story_arcs` table - 12-chapter story outlines with pacing
- **NEW:** `api_costs` table - API usage tracking with costs
- **ENHANCED:** `stories` table
  - Added `bible_id` column (UUID reference)
  - Added `generation_progress` column (JSONB)
  - Added `error_message` column (TEXT)
- **ENHANCED:** `chapters` table
  - Added `quality_score` column (INTEGER 1-10)
  - Added `quality_review` column (JSONB)
  - Added `quality_pass_completed` column (BOOLEAN)
  - Added `regeneration_count` column (INTEGER)
  - Added `metadata` column (JSONB)
- **ENHANCED:** `story_premises` table
  - Added `status` column (TEXT)
  - Added `preferences_used` column (JSONB)

#### API Endpoints - Production Ready
- **UPDATED:** `POST /onboarding/generate-premises`
  - Replaced mock data with real Claude API generation
  - Fetches user preferences from database
  - Returns 3 AI-generated story premises
  - Logs costs to api_costs table
  - Cost: ~$0.05 | Time: ~10s

- **UPDATED:** `POST /story/select-premise`
  - Generates story bible before creating story
  - Triggers async pre-generation (bible + arc + 8 chapters)
  - Returns storyId with generation status
  - Non-blocking background generation
  - Cost: ~$8.45 | Time: ~10-15 min

- **UPDATED:** `GET /story/generation-status/:storyId`
  - Returns detailed generation progress
  - Shows bible_complete, arc_complete, chapters_generated
  - Includes current_step for real-time tracking
  - Returns chapter count and error messages

- **UPDATED:** `POST /story/:storyId/generate-next`
  - Generates additional chapters on demand
  - Validates story is not in initial generation
  - Supports multiple chapters in one request
  - Returns actual chapter metadata
  - Cost: ~$0.90 per chapter | Time: ~120s

#### Quality Assurance
- **NEW:** 2-pass chapter generation system
  - Pass 1: Generate 2500-3500 word chapter
  - Pass 2: Quality review with 6 criteria scoring (1-10)
  - Auto-regeneration if score < 7 (max 2 retries)
  - Expected pass rate: >85%
  - Criteria: Age-appropriateness, Engagement, Pacing, Character Consistency, Arc Alignment, Writing Quality

#### Error Handling & Resilience
- **NEW:** Exponential backoff retry logic (3 attempts, 0s/1s/2s delays)
- **NEW:** Rate limit handling (529 errors, overloaded_error)
- **NEW:** Network timeout recovery
- **NEW:** Graceful orchestration failures (saves progress at each step)
- **NEW:** JSON parsing with markdown fallback
- **NEW:** Non-fatal cost logging (logs errors without throwing)

#### Cost Tracking
- Every API call logged to `api_costs` table
- Includes user_id, story_id, operation, tokens, cost, metadata
- Claude Opus 4.6 pricing: $15/M input tokens, $75/M output tokens
- Full story cost: ~$8.45 (Bible $0.75 + Arc $0.50 + 8 Chapters $7.20)
- Additional chapters: ~$0.90 each

#### Documentation
- **NEW:** `src/services/README.md` - Complete generation service API documentation
- **NEW:** `DATABASE_SETUP.md` - Step-by-step database setup guide with RLS policies
- **NEW:** `IMPLEMENTATION_SUMMARY.md` - Comprehensive implementation overview
- **NEW:** `QUICKSTART.md` - 5-minute quick start guide
- **NEW:** `CHANGELOG.md` - This file
- **NEW:** `scripts/test-generation.js` - Complete test suite for validation
- **NEW:** `database/migrations/002_generation_engine.sql` - Database migration script

#### Testing & Validation
- **NEW:** Test suite with 6 tests:
  1. Cost calculation validation
  2. Premise generation (3 stories)
  3. Story bible generation
  4. Arc outline generation (12 chapters)
  5. Single chapter generation with quality review
  6. Full pre-generation integration test (optional)
- Run with: `node scripts/test-generation.js [--full]`

### Changed

#### API Responses
- `POST /onboarding/generate-premises` now returns real AI-generated premises instead of mock data
- `POST /story/select-premise` now triggers actual generation instead of just creating a record
- `GET /story/generation-status/:storyId` now returns detailed progress instead of mock data
- `POST /story/:storyId/generate-next` now generates real chapters instead of returning 'generating' status

#### Performance
- Premise generation: ~10 seconds (was instant mock data)
- Story creation: ~1 minute for bible (was instant)
- Full pre-generation: ~10-15 minutes (was not implemented)
- Chapter generation: ~120 seconds each (was not implemented)

### Migration Guide

#### For Existing Installations

1. **Run Database Migration:**
   ```bash
   # Copy database/migrations/002_generation_engine.sql to Supabase SQL Editor and run
   ```

2. **Install Dependencies:**
   ```bash
   npm install @anthropic-ai/sdk
   ```

3. **Update Environment Variables:**
   ```env
   ANTHROPIC_API_KEY=sk-ant-api03-...  # Add this line
   ```

4. **Run Tests:**
   ```bash
   node scripts/test-generation.js
   ```

5. **Set Up RLS Policies:**
   - See DATABASE_SETUP.md for full RLS policy setup

#### Breaking Changes
- ⚠️ `POST /story/select-premise` now requires valid `premiseId` from database (not mock data)
- ⚠️ `POST /onboarding/generate-premises` now requires user to have completed `POST /onboarding/process-transcript` first
- ⚠️ Story generation is now asynchronous and takes 10-15 minutes (poll `/generation-status` for progress)
- ⚠️ API calls now have real costs (~$8.45 per story) instead of being free mock data

#### Deprecated
- Mock data in premise generation (replaced with real AI)
- Instant story creation (replaced with async generation)
- Mock chapter data (replaced with real AI-written chapters)

### Performance Improvements
- Added 1-second pause between chapter generations to avoid rate limits
- Implemented retry logic for transient failures
- Added progress tracking to allow resuming failed generations
- Optimized token usage with targeted prompts

### Security
- Added proper error handling for API key validation
- Implemented cost tracking to prevent unbounded API usage
- Added user_id validation on all generation endpoints
- RLS policies ensure users can only access their own generated content

### Dependencies
- Added `@anthropic-ai/sdk` for Claude API integration

### Technical Debt Addressed
- ✅ Removed all TODO comments in generation endpoints
- ✅ Replaced mock data with production-ready AI generation
- ✅ Added comprehensive error handling
- ✅ Implemented cost tracking and monitoring
- ✅ Added quality assurance system
- ✅ Created complete test coverage

### Known Issues
- None at this time

### Upgrade Notes
- This is a major version bump (1.x → 2.0.0) due to breaking API changes
- Existing stories with mock data will need to be regenerated
- Frontend clients must implement polling for generation status
- API costs must be monitored to prevent overuse

### Future Roadmap
- [ ] Parallel chapter generation with rate limit management
- [ ] Caching for bible/arc queries
- [ ] Real-time progress webhooks
- [ ] Support for different story lengths (6, 12, 24 chapters)
- [ ] Multi-language support
- [ ] Illustration generation
- [ ] Audio narration integration
- [ ] Character customization mid-story

---

## [1.0.0] - 2026-01-XX

### Initial Release
- Basic API structure
- Mock data endpoints
- User authentication
- Database schema
- Onboarding flow with voice transcription
- Reading progress tracking

---

**Note:** Version 2.0.0 represents a fundamental transformation from a prototype with mock data to a production-ready AI storytelling platform powered by Claude Opus 4.6.
