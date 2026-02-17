# Phase 2A Implementation Summary: Codebase Context Package Builder

## What Was Built

A service + API route that fetches key source files from GitHub repos, adds the live DB schema, assembles them into a categorized JSON blob, and uploads it to Supabase Storage for later consumption by Edge Functions.

## Files Created

### 1. Service: `src/services/codebase-context.js` (472 lines)
- **GitHub API Integration**: Fetches source files from both repos using Bearer token auth
- **Smart File Discovery**: Tries common iOS paths first, falls back to GitHub Trees API search
- **Category-Based Organization**: Files organized by bug report category (navigation, generation, reading, interview, visual, performance)
- **Always-Included Files**: Core files (AuthManager, APIManager, peggy.js, prospero.js, server.js, CLAUDE.md)
- **Database Schema Fetching**: Queries Supabase for live schema of 9 tables
- **Size Enforcement**: Automatic truncation to keep package under 200KB (500-line, then 300-line truncation)
- **Deduplication**: Each file fetched only once, referenced in multiple categories
- **Storage Upload**: Creates `codebase-context` bucket and uploads `latest.json`
- **Graceful Degradation**: Works without GITHUB_TOKEN (returns minimal package)

### 2. Route: `src/routes/codebase-context.js` (53 lines)
- **Endpoint**: `POST /admin/build-context`
- **Admin-Only**: Checks email against ADMIN_EMAILS list
- **Authentication**: Uses existing `authenticateUser` middleware
- **Error Handling**: Returns 401 (unauth), 403 (non-admin), or 500 (server error)
- **Response**: `{ success, size_bytes, file_count, built_at }`

### 3. Tests: `tests/codebase-context.test.js` (14 tests, 100% pass)
- **Mocked GitHub API**: No real API calls in tests
- **Mocked Supabase**: No real database/storage operations in tests
- **Test Coverage**:
  - Returns minimal package when GITHUB_TOKEN not set
  - Builds context package with correct structure
  - Creates storage bucket if it doesn't exist
  - Doesn't recreate bucket if it exists
  - Fetches files with correct auth headers
  - Verifies truncation logic activates for large files
  - Context package has all required top-level keys
  - Categories contain expected bug categories
  - always_included section has files array
  - Schema section has tables object
  - Files have required structure (path, content, line_count)
  - POST /admin/build-context returns 401 for unauthenticated
  - POST /admin/build-context returns 403 for non-admin
  - POST /admin/build-context returns 200 for admin users

### 4. Updated: `src/server.js`
- Added codebase-context routes import and registration

### 5. Dependencies Added
- `supertest@^7.0.0` (devDependency) for route testing

## File Categorization

| Category | iOS Files | Server Files |
|----------|-----------|--------------|
| navigation | ReadingStateManager.swift, LibraryView.swift, BookReaderView.swift | src/routes/story.js |
| generation | — | src/services/generation.js, src/services/cover-generation.js |
| reading | BookReaderView.swift, ReadingStateManager.swift | src/routes/story.js, src/routes/feedback.js |
| interview | VoiceSessionManager.swift, BookCompletionInterviewView.swift, OnboardingView.swift | src/routes/onboarding.js, src/routes/feedback.js |
| visual | BookReaderView.swift, LibraryView.swift | — |
| performance | ReadingStateManager.swift, APIManager.swift | src/services/generation.js |
| always_included | AuthManager.swift, APIManager.swift | src/config/peggy.js, src/config/prospero.js, src/server.js |
| rules | — | CLAUDE.md (repo root) |

## Database Tables Included

Schema includes these 9 tables: `bug_reports`, `chapters`, `stories`, `error_events`, `story_arcs`, `story_bibles`, `reading_sessions`, `reading_heartbeats`, `user_preferences`

## JSON Package Structure

```json
{
  "built_at": "2026-02-16T12:00:00Z",
  "categories": {
    "navigation": { "files": [...] },
    "generation": { "files": [...] },
    "reading": { "files": [...] },
    "interview": { "files": [...] },
    "visual": { "files": [...] },
    "performance": { "files": [...] }
  },
  "always_included": {
    "files": [...]
  },
  "schema": {
    "tables": {
      "bug_reports": [{ "column": "id", "type": "uuid", ... }],
      ...
    }
  },
  "rules": "Contents of CLAUDE.md..."
}
```

Each file object: `{ path, content, line_count }`

## Size Management

- **Target**: < 200KB
- **Truncation Strategy**:
  1. Check total size after initial assembly
  2. If > 200KB, truncate all files to 500 lines
  3. If still > 200KB, truncate to 300 lines
  4. Log final size and file count
- **Truncation Format**: Adds `[... truncated N lines ...]` at end of content

## Storage Details

- **Bucket Name**: `codebase-context`
- **Access**: Private
- **File Size Limit**: 1MB
- **File Name**: `latest.json` (overwritten each time)
- **Creation**: Auto-created if doesn't exist

## Test Results

```
Test Suites: 8 passed, 8 total
Tests:       182 passed, 182 total
```

All existing tests continue to pass. 14 new tests added for codebase context functionality.

## QA Checklist Results

- [x] `npm test` passes (182/182 tests)
- [x] `POST /admin/build-context` returns valid JSON with correct structure
- [x] Non-admin gets 403, unauthenticated gets 401
- [x] Context package enforces 200KB limit with truncation
- [x] Files are correctly categorized
- [x] Schema section has all 9 tables
- [x] `rules` field contains CLAUDE.md content
- [x] Supabase Storage bucket `codebase-context` created and `latest.json` uploaded
- [x] Duplicate files fetched only once (deduplication via Set)
- [x] Missing `GITHUB_TOKEN` degrades gracefully (returns minimal package, no crash)
- [x] DB schema verified against live Supabase (all 9 tables confirmed via MCP)

## Environment Variables Required

- `GITHUB_TOKEN` — GitHub personal access token with `repo` scope (must be added to Railway)
- If not set, service returns minimal package with warning (no crash)

## Next Steps (Phase 2B)

Create Edge Function that:
1. Fetches `latest.json` from `codebase-context` bucket
2. Receives bug report data
3. Uses Claude Sonnet to analyze bug with full codebase context
4. Returns AI analysis, priority, and CC-ready prompt

## Context Package Size Estimate

With truncation: ~12-50KB typical (well under 200KB limit)
