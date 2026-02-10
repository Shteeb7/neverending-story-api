# Neverending Story API Server

Backend API server for the Neverending Story iOS app - an AI-powered book generation platform that creates personalized children's stories using Claude Opus 4.6 and OpenAI Realtime API.

**Version:** 2.0.0 - Production Ready ✨

## Features

### Core AI Generation Engine 🚀
- **Premise Generation**: AI creates 3 unique story concepts from user preferences (~10s, $0.05)
- **Story Bible**: Comprehensive world-building with characters, conflict, stakes (~60s, $0.75)
- **Arc Outlining**: 12-chapter story structure with pacing and tension (~40s, $0.50)
- **Chapter Writing**: 2500-3500 word chapters with quality review (~120s, $0.90)
- **Pre-Generation**: Automatic generation of bible + arc + 8 chapters (~15min, $8.45)
- **Quality Assurance**: 2-pass system with 6-criteria review and auto-regeneration

### Platform Features
- **Authentication**: Google and Apple OAuth integration via Supabase
- **Voice Onboarding**: Real-time voice conversations to understand user preferences
- **Reading Progress**: Track user reading position and progress
- **Feedback System**: Voice and quick-tap feedback collection
- **Library Management**: Full CRUD operations for user story libraries
- **Cost Tracking**: Monitor AI API usage and costs per user/story
- **Error Recovery**: Graceful failure handling with progress preservation

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Database**: PostgreSQL (Supabase)
- **AI Services**:
  - Anthropic Claude API (story generation)
  - OpenAI Realtime API (voice conversations)
- **Deployment**: Railway

## Prerequisites

- Node.js 18 or higher
- Supabase account with PostgreSQL database
- Anthropic API key (Claude)
- OpenAI API key
- Railway account (for deployment)

## Quick Start

**Get up and running in 5 minutes!** See [QUICKSTART.md](QUICKSTART.md) for detailed setup.

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env and add your API keys
```

Required variables:
- `ANTHROPIC_API_KEY` - Get from https://console.anthropic.com
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_KEY` - Supabase service role key
- `OPENAI_API_KEY` - OpenAI API key

### 3. Run Database Migration
Open Supabase SQL Editor and run `database/migrations/002_generation_engine.sql`

See [DATABASE_SETUP.md](DATABASE_SETUP.md) for detailed instructions.

### 4. Test the Implementation
```bash
node scripts/test-generation.js
```

### 5. Start Development Server
```bash
npm run dev
```

Server starts on `http://localhost:3000`

## Documentation

- **[QUICKSTART.md](QUICKSTART.md)** - 5-minute setup guide
- **[IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md)** - Complete implementation overview
- **[DATABASE_SETUP.md](DATABASE_SETUP.md)** - Database setup and RLS policies
- **[DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md)** - Production deployment guide
- **[CHANGELOG.md](CHANGELOG.md)** - Version history and changes
- **[src/services/README.md](src/services/README.md)** - Generation service API docs

## API Endpoints

### Authentication
- `POST /auth/google` - Google SSO authentication
- `POST /auth/apple` - Apple SSO authentication
- `GET /auth/session` - Validate session token

### Onboarding
- `POST /onboarding/start` - Initialize voice conversation
- `POST /onboarding/process-transcript` - Process conversation data
- `POST /onboarding/generate-premises` - Generate 3 story premises
- `GET /onboarding/premises/:userId` - Retrieve generated premises

### Story Generation
- `POST /story/select-premise` - Select premise and trigger pre-generation
- `GET /story/generation-status/:storyId` - Check generation progress
- `GET /story/:storyId/chapters` - Retrieve available chapters
- `POST /story/:storyId/generate-next` - Generate next chapter(s)

### Reading Progress
- `POST /story/:storyId/progress` - Update reading position
- `GET /story/:storyId/current-state` - Get current reading state

### Feedback
- `POST /feedback/quick-tap` - Record abandonment feedback
- `POST /feedback/voice-session` - Start feedback conversation
- `POST /feedback/process-conversation` - Process and store conversation

### Library
- `GET /library/:userId` - Get all user stories
- `PUT /story/:storyId/archive` - Archive story
- `DELETE /story/:storyId` - Delete story

### Admin/Monitoring
- `GET /admin/costs/:userId` - Get cost breakdown
- `GET /admin/generation-metrics` - Track generation performance
- `GET /admin/health` - Health check

## Deployment to Railway

### Option 1: Deploy from GitHub

1. Push your code to GitHub
2. Go to [Railway](https://railway.app)
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your repository
5. Add environment variables in Railway dashboard
6. Railway will automatically deploy

### Option 2: Deploy using Railway CLI

1. **Install Railway CLI**
   ```bash
   npm install -g @railway/cli
   ```

2. **Login to Railway**
   ```bash
   railway login
   ```

3. **Initialize Railway project**
   ```bash
   railway init
   ```

4. **Add environment variables**
   ```bash
   railway variables set SUPABASE_URL=<your-url>
   railway variables set SUPABASE_ANON_KEY=<your-key>
   railway variables set SUPABASE_SERVICE_KEY=<your-key>
   railway variables set ANTHROPIC_API_KEY=<your-key>
   railway variables set OPENAI_API_KEY=<your-key>
   railway variables set NODE_ENV=production
   ```

5. **Deploy**
   ```bash
   railway up
   ```

6. **Get deployment URL**
   ```bash
   railway domain
   ```

### Environment Variables in Railway

Set these in the Railway dashboard under your project's Variables tab:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_KEY`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `NODE_ENV=production`
- `ALLOWED_ORIGINS` (optional, comma-separated)

Railway will automatically provide `DATABASE_URL` if you add a PostgreSQL database.

## Project Structure

```
neverending-story-api/
├── src/
│   ├── config/
│   │   ├── supabase.js          # Supabase client configuration
│   │   └── ai-clients.js        # Anthropic & OpenAI clients
│   ├── middleware/
│   │   ├── auth.js              # Authentication middleware
│   │   └── error-handler.js     # Global error handling
│   ├── services/
│   │   ├── generation.js        # ⭐ AI generation engine (812 lines)
│   │   └── README.md            # Service API documentation
│   ├── routes/
│   │   ├── auth.js              # Authentication endpoints
│   │   ├── onboarding.js        # Onboarding endpoints (updated)
│   │   ├── story.js             # Story generation endpoints (updated)
│   │   ├── feedback.js          # Feedback endpoints
│   │   ├── library.js           # Library management endpoints
│   │   └── admin.js             # Admin/monitoring endpoints
│   └── server.js                # Main application entry point
├── database/
│   └── migrations/
│       └── 002_generation_engine.sql  # Database schema
├── scripts/
│   ├── test-generation.js       # Test suite
│   └── apply-migration.js       # Migration helper
├── QUICKSTART.md                # 5-minute setup guide
├── IMPLEMENTATION_SUMMARY.md    # Complete implementation docs
├── DATABASE_SETUP.md            # Database setup guide
├── DEPLOYMENT_CHECKLIST.md      # Deployment guide
├── CHANGELOG.md                 # Version history
├── .env.example                 # Environment variables template
├── package.json
└── README.md                    # This file
```

## Database Schema (Supabase)

Run `database/migrations/002_generation_engine.sql` to create these tables:

**Core Tables:**
- `user_preferences` - User reading preferences from onboarding
- `story_premises` - Generated story premises (with status, preferences_used)
- `story_bibles` - World-building, characters, conflict, stakes
- `story_arcs` - 12-chapter outlines with pacing
- `stories` - User stories (with bible_id, generation_progress, error_message)
- `chapters` - Story chapters (with quality_score, quality_review, metadata)
- `api_costs` - Detailed API usage tracking (tokens, cost, operation)

**Supporting Tables:**
- `reading_progress` - User reading positions
- `feedback` - User feedback data
- `feedback_sessions` - Voice feedback sessions

See [DATABASE_SETUP.md](DATABASE_SETUP.md) for complete schema and RLS policies.

## Error Handling

The API uses standardized error responses:

```json
{
  "success": false,
  "error": "Error message description"
}
```

HTTP status codes follow REST conventions:
- 200: Success
- 400: Bad Request
- 401: Unauthorized
- 403: Forbidden
- 404: Not Found
- 500: Internal Server Error

## Authentication

All protected endpoints require a Bearer token in the Authorization header:

```
Authorization: Bearer <supabase-jwt-token>
```

The token is validated using Supabase Auth and the user is attached to `req.user`.

## Development Notes

- All route handlers use `asyncHandler` wrapper for automatic error catching
- Authentication middleware validates JWT tokens via Supabase
- CORS is configured to accept requests from specified origins
- Request/response logging is enabled in development mode
- Graceful shutdown handlers are implemented for SIGTERM/SIGINT

## Testing

Test the deployment with:

```bash
# Health check
curl https://your-app.railway.app/health

# API info
curl https://your-app.railway.app/

# Test authentication (requires valid token)
curl https://your-app.railway.app/auth/session \
  -H "Authorization: Bearer <your-token>"

# Test Claude API integration (verifies API key and story generation)
curl https://your-app.railway.app/test/claude
```

### Claude API Integration Test

The `/test/claude` endpoint verifies that:
- Your Anthropic API key is configured correctly
- The Claude API client is working
- Story generation functionality is operational
- Token usage and cost tracking is accurate

Example response:
```json
{
  "success": true,
  "test": "Claude API Integration",
  "model": "claude-opus-4-6",
  "premise": "A young apprentice discovers their mentor's forbidden spell has trapped their entire village in a time loop that only they can remember.",
  "usage": {
    "inputTokens": 23,
    "outputTokens": 45,
    "totalTokens": 68
  },
  "cost": {
    "inputCost": "$0.000069",
    "outputCost": "$0.000675",
    "totalCost": "$0.000744"
  },
  "responseTime": "1234ms"
}
```

## Support

For issues or questions, please contact the development team.

## License

ISC
