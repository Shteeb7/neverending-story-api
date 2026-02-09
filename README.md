# Neverending Story API Server

Backend API server for the Neverending Story iOS app - an AI-powered book generation platform that orchestrates story creation using Claude API and OpenAI Realtime API.

## Features

- **Authentication**: Google and Apple OAuth integration via Supabase
- **Voice Onboarding**: Real-time voice conversations to understand user preferences
- **Story Generation**: AI-powered story and chapter generation using Claude
- **Reading Progress**: Track user reading position and progress
- **Feedback System**: Voice and quick-tap feedback collection
- **Library Management**: Full CRUD operations for user story libraries
- **Cost Tracking**: Monitor AI API usage and costs

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

## Local Development Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd neverending-story-api
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**

   Copy `.env.example` to `.env` and fill in your credentials:
   ```bash
   cp .env.example .env
   ```

   Required environment variables:
   - `SUPABASE_URL`: Your Supabase project URL
   - `SUPABASE_ANON_KEY`: Supabase anonymous key
   - `SUPABASE_SERVICE_KEY`: Supabase service role key
   - `ANTHROPIC_API_KEY`: Claude API key
   - `OPENAI_API_KEY`: OpenAI API key
   - `DATABASE_URL`: PostgreSQL connection string (auto-populated by Railway)

4. **Start the development server**
   ```bash
   npm run dev
   ```

   The server will start on `http://localhost:3000`

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
│   │   ├── supabase.js       # Supabase client configuration
│   │   └── ai-clients.js     # Anthropic & OpenAI clients
│   ├── middleware/
│   │   ├── auth.js           # Authentication middleware
│   │   └── error-handler.js  # Global error handling
│   ├── routes/
│   │   ├── auth.js           # Authentication endpoints
│   │   ├── onboarding.js     # Onboarding endpoints
│   │   ├── story.js          # Story generation endpoints
│   │   ├── feedback.js       # Feedback endpoints
│   │   ├── library.js        # Library management endpoints
│   │   └── admin.js          # Admin/monitoring endpoints
│   └── server.js             # Main application entry point
├── .env.example              # Environment variables template
├── .gitignore
├── package.json
├── railway.json              # Railway deployment config
└── README.md
```

## Database Schema (Supabase)

You'll need to create these tables in your Supabase database:

- `user_preferences` - User reading preferences from onboarding
- `story_premises` - Generated story premises
- `stories` - User stories
- `chapters` - Story chapters
- `reading_progress` - User reading positions
- `feedback` - User feedback data
- `feedback_sessions` - Voice feedback sessions
- `api_costs` - API usage cost tracking
- `generation_metrics` - Performance metrics

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
```

## Support

For issues or questions, please contact the development team.

## License

ISC
