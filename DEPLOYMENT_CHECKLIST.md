# Deployment Checklist - AI Generation Engine v2.0.0

Use this checklist to ensure a successful deployment of the AI generation engine.

## Pre-Deployment

### 1. Environment Setup
- [ ] Anthropic API key obtained from https://console.anthropic.com
- [ ] API key added to `.env` file: `ANTHROPIC_API_KEY=sk-ant-...`
- [ ] Supabase URL and service key configured in `.env`
- [ ] All environment variables validated

### 2. Dependencies
- [ ] `@anthropic-ai/sdk` already installed (v0.32.1+)
- [ ] Run `npm install` to ensure all dependencies are current
- [ ] Verify Node.js version >= 18.0.0 with `node --version`

### 3. Database Migration
- [ ] Open Supabase SQL Editor
- [ ] Copy contents of `database/migrations/002_generation_engine.sql`
- [ ] Paste into SQL editor and click "Run"
- [ ] Verify no errors in execution
- [ ] Verify tables exist: `story_bibles`, `story_arcs`, `api_costs`
- [ ] Verify columns added to `stories`, `chapters`, `story_premises`

### 4. Row Level Security (RLS)
- [ ] Enable RLS on new tables: `story_bibles`, `story_arcs`, `api_costs`
- [ ] Create policies for `story_bibles` (users view/create own)
- [ ] Create policies for `story_arcs` (users access through stories)
- [ ] Create policies for `api_costs` (users view own, service role inserts)
- [ ] Test policies with sample queries

### 5. Testing
- [ ] Run basic test: `node scripts/test-generation.js`
- [ ] Verify all 5 tests pass (cost calc, premises, bible, arc, chapter)
- [ ] Check api_costs table has logged entries
- [ ] Verify story created with correct structure
- [ ] Validate chapter quality score >= 7
- [ ] Optional: Run full test with `--full` flag (costs ~$8.45, takes 15 min)

## Deployment

### 6. Code Review
- [ ] Review `src/services/generation.js` (812 lines)
- [ ] Review updated `src/routes/onboarding.js` (lines 85-110)
- [ ] Review updated `src/routes/story.js` (lines 13-35, 56-75, 130-175)
- [ ] Verify all `require()` statements are correct
- [ ] Check error handling in all endpoints

### 7. Git Commit
```bash
git add .
git commit -m "feat: Implement AI generation engine with Claude Opus 4.6

- Add comprehensive generation service (premises, bible, arc, chapters)
- Implement 2-pass quality review system with auto-regeneration
- Add cost tracking for all API calls
- Create database tables for bibles, arcs, and api_costs
- Update endpoints to use real AI generation instead of mocks
- Add extensive documentation and test suite

Breaking changes:
- Story generation now async (10-15 min)
- Requires valid user preferences before premise generation
- API calls have real costs (~$8.45 per story)

Closes #[issue-number]"
```

### 8. Push to Repository
- [ ] Push to development branch: `git push origin dev`
- [ ] Create pull request if using PR workflow
- [ ] Wait for CI/CD checks to pass (if configured)
- [ ] Merge to main branch

### 9. Deploy to Hosting
Choose your platform:

**Railway:**
```bash
railway up
```

**Render:**
```bash
git push origin main
# Auto-deploys if configured
```

**Heroku:**
```bash
git push heroku main
```

**Custom Server:**
```bash
ssh your-server
cd /path/to/app
git pull origin main
npm install
pm2 restart neverending-story-api
```

### 10. Environment Variables (Production)
Verify these are set in your hosting platform:
- [ ] `ANTHROPIC_API_KEY` - Your Claude API key
- [ ] `SUPABASE_URL` - Your Supabase project URL
- [ ] `SUPABASE_SERVICE_KEY` - Your Supabase service role key
- [ ] `SUPABASE_ANON_KEY` - Your Supabase anon key
- [ ] `PORT` - Server port (usually 3000 or auto-assigned)
- [ ] `NODE_ENV` - Set to `production`

## Post-Deployment

### 11. Smoke Tests
- [ ] Hit health endpoint: `GET /health` (if you have one)
- [ ] Test premise generation with real user token
- [ ] Verify response time is acceptable (<15 seconds for premises)
- [ ] Check logs for errors
- [ ] Verify API costs are being logged to Supabase

### 12. End-to-End Test
Run a complete flow:
1. [ ] Create test user account
2. [ ] Complete onboarding: `POST /onboarding/process-transcript`
3. [ ] Generate premises: `POST /onboarding/generate-premises`
4. [ ] Select premise: `POST /story/select-premise`
5. [ ] Poll status: `GET /story/generation-status/:storyId`
6. [ ] Wait 10-15 minutes for completion
7. [ ] Verify status = 'active'
8. [ ] Read chapters: `GET /story/:storyId/chapters`
9. [ ] Verify 8 chapters exist with 2500-3500 words each
10. [ ] Generate chapter 9: `POST /story/:storyId/generate-next`
11. [ ] Check api_costs table for all operations

### 13. Monitoring Setup
- [ ] Set up cost alert (if daily > $50, notify)
- [ ] Set up error alert (if story.status = 'error', notify)
- [ ] Set up quality alert (if quality_score < 5, notify)
- [ ] Set up performance alert (if generation > 20 min, notify)
- [ ] Create dashboard for:
  - Total daily/weekly costs
  - Average quality scores
  - Stories generated per day
  - Average generation time
  - Error rate

### 14. Database Monitoring
Set up queries to run hourly/daily:

```sql
-- Total costs today
SELECT SUM(cost) FROM api_costs WHERE created_at > NOW() - INTERVAL '24 hours';

-- Stories in error state
SELECT COUNT(*) FROM stories WHERE status = 'error';

-- Average quality score
SELECT AVG(quality_score) FROM chapters WHERE quality_pass_completed = true;

-- Generation time distribution
SELECT
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (NOW() - created_at))/60) as median_minutes,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (NOW() - created_at))/60) as p95_minutes
FROM stories WHERE status = 'active';
```

### 15. Documentation
- [ ] Update API documentation with new endpoints
- [ ] Share QUICKSTART.md with team
- [ ] Update frontend documentation about async generation
- [ ] Document cost estimates for stakeholders
- [ ] Create runbook for common issues

### 16. Client Updates
- [ ] Notify frontend team about API changes
- [ ] Provide polling interval recommendation (every 10 seconds)
- [ ] Share generation time estimates (10-15 min)
- [ ] Document new error states to handle
- [ ] Provide sample responses for UI development

## Rollback Plan

If issues arise, follow this rollback procedure:

### Immediate Rollback
1. [ ] Revert git commit: `git revert HEAD`
2. [ ] Push revert: `git push origin main`
3. [ ] Redeploy previous version
4. [ ] Verify mock endpoints working again

### Database Rollback (if needed)
Run this in Supabase SQL Editor:

```sql
-- Drop new tables
DROP TABLE IF EXISTS story_arcs CASCADE;
DROP TABLE IF EXISTS story_bibles CASCADE;
DROP TABLE IF EXISTS api_costs CASCADE;

-- Remove added columns
ALTER TABLE stories DROP COLUMN IF EXISTS bible_id;
ALTER TABLE stories DROP COLUMN IF EXISTS generation_progress;
ALTER TABLE stories DROP COLUMN IF EXISTS error_message;

ALTER TABLE chapters DROP COLUMN IF EXISTS quality_score;
ALTER TABLE chapters DROP COLUMN IF EXISTS quality_review;
ALTER TABLE chapters DROP COLUMN IF EXISTS quality_pass_completed;
ALTER TABLE chapters DROP COLUMN IF EXISTS regeneration_count;
ALTER TABLE chapters DROP COLUMN IF EXISTS metadata;

ALTER TABLE story_premises DROP COLUMN IF EXISTS status;
ALTER TABLE story_premises DROP COLUMN IF EXISTS preferences_used;
```

### Post-Rollback
- [ ] Notify users of temporary service disruption
- [ ] Investigate root cause of issues
- [ ] Fix issues in development
- [ ] Re-test thoroughly before next deployment

## Success Criteria

Deployment is successful when:

✅ All API endpoints return 200 status codes
✅ Premise generation completes in <15 seconds
✅ Story bible generation completes in <90 seconds
✅ Full pre-generation completes in <20 minutes
✅ >85% of chapters pass quality review on first attempt
✅ Average quality score >= 7.5
✅ No rate limit errors (529) from Claude API
✅ All costs logged to api_costs table
✅ No database errors in logs
✅ Frontend can poll generation status successfully
✅ Users can read generated chapters with proper formatting
✅ Error handling works gracefully (failed generations show in UI)

## Cost Management

### First Week Monitoring
- [ ] Track total API costs daily
- [ ] Calculate cost per story
- [ ] Verify costs match estimates ($8-9 per story)
- [ ] Identify any unexpected high-cost operations
- [ ] Adjust rate limits if necessary

### Ongoing
- [ ] Weekly cost review
- [ ] Monthly cost optimization analysis
- [ ] Identify low-quality generations for prompt improvements
- [ ] Monitor regeneration rate (should be <15%)
- [ ] Review user feedback on story quality

## Support Resources

- **Quick Start:** QUICKSTART.md
- **Full Docs:** IMPLEMENTATION_SUMMARY.md
- **Service API:** src/services/README.md
- **Database Setup:** DATABASE_SETUP.md
- **Test Suite:** `node scripts/test-generation.js`
- **Changelog:** CHANGELOG.md

## Emergency Contacts

- **API Issues:** [Your email/Slack]
- **Database Issues:** Supabase support
- **Claude API Issues:** support@anthropic.com
- **Billing Questions:** [Your billing contact]

---

**Deployment Date:** _____________

**Deployed By:** _____________

**Environment:** ☐ Development  ☐ Staging  ☐ Production

**Version:** 2.0.0

**Status:** ☐ Success  ☐ Partial  ☐ Rollback Required

**Notes:**

_____________________________________________

_____________________________________________

_____________________________________________
