require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Import middleware
const { errorHandler, notFoundHandler } = require('./middleware/error-handler');

// Import routes
const authRoutes = require('./routes/auth');
const onboardingRoutes = require('./routes/onboarding');
const storyRoutes = require('./routes/story');
const feedbackRoutes = require('./routes/feedback');
const analyticsRoutes = require('./routes/analytics');
const libraryRoutes = require('./routes/library');
const adminRoutes = require('./routes/admin');
const testRoutes = require('./routes/test');
const chatRoutes = require('./routes/chat');
const settingsRoutes = require('./routes/settings');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// =========================
// Middleware Configuration
// =========================

// CORS configuration
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request/Response logging middleware (always enabled for debugging)
app.use((req, res, next) => {
  const start = Date.now();
  const requestTime = new Date().toISOString();

  console.log(`[${requestTime}] ${req.method} ${req.path}`);

  // Log request body for POST/PUT
  if ((req.method === 'POST' || req.method === 'PUT') && req.body) {
    console.log(`   Body: ${JSON.stringify(req.body).substring(0, 200)}`);
  }

  // Capture response
  const originalSend = res.send;
  res.send = function(data) {
    const duration = Date.now() - start;
    console.log(`[${requestTime}] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);

    // Log response body if error
    if (res.statusCode >= 400) {
      console.log(`   Error Response: ${typeof data === 'string' ? data.substring(0, 200) : JSON.stringify(data).substring(0, 200)}`);
    }

    originalSend.call(this, data);
  };

  next();
});

// =========================
// Health Check Route
// =========================

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Neverending Story API Server',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// =========================
// API Routes
// =========================

app.use('/auth', authRoutes);
app.use('/onboarding', onboardingRoutes);
app.use('/story', storyRoutes);
app.use('/feedback', feedbackRoutes);
app.use('/analytics', analyticsRoutes);
app.use('/library', libraryRoutes);
app.use('/admin', adminRoutes);
app.use('/test', testRoutes);
app.use('/chat', chatRoutes);
app.use('/settings', settingsRoutes);

// =========================
// Error Handling
// =========================

// 404 handler - must be after all other routes
app.use(notFoundHandler);

// Global error handler - must be last
app.use(errorHandler);

// =========================
// Server Startup
// =========================

// Validate required environment variables
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY'
];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:');
  missingEnvVars.forEach(envVar => console.error(`   - ${envVar}`));
  console.error('\nPlease check your .env file and ensure all required variables are set.');
  process.exit(1);
}

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('\n=================================');
  console.log('🚀 Neverending Story API Server');
  console.log('=================================');
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Base URL: http://0.0.0.0:${PORT}`);
  console.log('=================================\n');
  console.log('📋 Available Routes:');
  console.log('   GET  / - API info');
  console.log('   GET  /health - Health check');
  console.log('   POST /auth/google - Google OAuth');
  console.log('   POST /auth/apple - Apple OAuth');
  console.log('   GET  /auth/session - Validate session');
  console.log('   POST /onboarding/start - Start onboarding');
  console.log('   POST /story/select-premise - Create story');
  console.log('   GET  /library/:userId - Get user library');
  console.log('   ... and more');
  console.log('=================================');
  console.log(`🤖 AI Models: Claude=${process.env.CLAUDE_GENERATION_MODEL || 'claude-opus-4-6'}, OpenAI Realtime=${process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-mini-realtime-preview-2024-12-17'}`);
  console.log('=================================\n');
});

// Set server timeout to 5 minutes for AI generation endpoints
server.timeout = 300000; // 5 minutes
server.keepAliveTimeout = 310000; // Slightly longer than timeout
console.log('⏱️  Server timeout set to 5 minutes for AI operations');

// Self-healing: Resume stalled story generations
const { resumeStalledGenerations } = require('./services/generation');

// Run on startup (catches stories interrupted by server restart)
console.log('\n🔧 Running startup health check for stalled generations...');
resumeStalledGenerations().catch(error => {
  console.error('❌ Startup health check failed:', error);
});

// Run every 5 minutes thereafter
const FIVE_MINUTES = 5 * 60 * 1000;
setInterval(() => {
  console.log('\n🔧 Running scheduled health check for stalled generations...');
  resumeStalledGenerations().catch(error => {
    console.error('❌ Scheduled health check failed:', error);
  });
}, FIVE_MINUTES);

console.log('🔄 Self-healing enabled: checks every 5 minutes for stalled generations');
console.log('=================================\n');

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received, shutting down gracefully...');
  process.exit(0);
});

module.exports = app;
