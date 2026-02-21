/**
 * Peggy Auto-Error Reporter
 *
 * Comprehensive error monitoring that files bug reports automatically.
 * Covers THREE error sources:
 *
 *   1. Express route errors (500s) — via middleware
 *   2. Background process errors — via reportToPeggy() utility
 *      (generation pipeline, health check, cover generation)
 *   3. Railway deploy failures — via webhook endpoint
 *
 * Reports land on the dashboard at 'ready' status for Steven to review.
 * Deduplicates by error source + message to avoid flooding.
 */

const { supabaseAdmin } = require('../config/supabase');

// Fixed UUID for Peggy's system user (no auth.users record needed — no FK constraint)
const PEGGY_SYSTEM_USER_ID = '00000000-0000-0000-0000-peggy0000qa';

// In-memory dedup cache: key → last reported timestamp
const recentErrors = new Map();
const DEDUP_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Clean expired entries from the dedup cache
 */
function cleanDedup() {
  const now = Date.now();
  for (const [key, timestamp] of recentErrors) {
    if (now - timestamp > DEDUP_WINDOW_MS) {
      recentErrors.delete(key);
    }
  }
}

/**
 * Build a dedup key
 */
function buildDedupKey(source, errorMessage) {
  // Normalize: strip UUIDs
  const normalizedSource = source.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ':id'
  );
  const shortMsg = (errorMessage || 'unknown').substring(0, 200);
  return `${normalizedSource}:${shortMsg}`;
}

/**
 * Check if this error was recently reported (dedup)
 */
function isDuplicate(source, errorMessage) {
  cleanDedup();
  const key = buildDedupKey(source, errorMessage);
  if (recentErrors.has(key)) {
    return true;
  }
  recentErrors.set(key, Date.now());
  return false;
}

// ============================================================
// SOURCE 1: Express Middleware (route 500 errors)
// ============================================================

/**
 * Express error middleware — catches 500s and files Peggy bug reports.
 * Must be registered BEFORE the regular errorHandler in server.js.
 */
function peggyErrorReporter(err, req, res, next) {
  const statusCode = err.statusCode || err.status || 500;

  // Only file reports for actual server errors (500+), not 4xx client errors
  if (statusCode < 500) {
    return next(err);
  }

  // Fire and forget — don't slow down the error response
  const source = `${req.method} ${req.originalUrl || req.path}`;
  reportToPeggy({
    source: `route:${source}`,
    category: 'server',
    severity: 'high',
    errorMessage: err.message,
    stackTrace: err.stack,
    affectedUserId: req.userId || null,
    context: {
      endpoint: source,
      status_code: statusCode,
      request_body: sanitizeBody(req.body)
    }
  }).catch(reportErr => {
    console.error('🐞⚠️ Peggy auto-reporter failed (non-fatal):', reportErr.message);
  });

  next(err);
}

// ============================================================
// SOURCE 2: Shared Utility (generation pipeline, health check, etc.)
// ============================================================

/**
 * File a bug report as Peggy from anywhere in the codebase.
 *
 * @param {Object} opts
 * @param {string} opts.source - Where the error came from (e.g., 'generation:generateChapter', 'health-check:recovery')
 * @param {string} opts.category - 'server' | 'generation' | 'deploy' | 'database' | 'health_check'
 * @param {string} opts.severity - 'critical' | 'high' | 'medium' | 'low'
 * @param {string} opts.errorMessage - The error message
 * @param {string} [opts.stackTrace] - Stack trace if available
 * @param {string} [opts.storyId] - Related story ID
 * @param {string} [opts.storyTitle] - Related story title
 * @param {string} [opts.affectedUserId] - User who was affected
 * @param {Object} [opts.context] - Additional context (will be stored in metadata)
 */
async function reportToPeggy(opts) {
  const {
    source,
    category = 'server',
    severity = 'high',
    errorMessage,
    stackTrace = '',
    storyId = null,
    storyTitle = null,
    affectedUserId = null,
    context = {}
  } = opts;

  // Dedup check
  if (isDuplicate(source, errorMessage)) {
    console.log(`🐞 Peggy: Duplicate suppressed (${source}: ${errorMessage.substring(0, 60)}...)`);
    return;
  }

  // Extract source file from stack trace
  const sourceMatch = stackTrace.match(/at .+\((.+:\d+:\d+)\)/);
  const sourceLocation = sourceMatch ? sourceMatch[1] : 'unknown';

  // Build summary
  const titlePrefix = storyTitle ? `[${storyTitle}] ` : '';
  const summary = `${titlePrefix}${source}: ${errorMessage}`.substring(0, 500);

  // Build transcript
  const transcript = [
    `[Peggy Auto-QA Report]`,
    ``,
    `Source: ${source}`,
    `Error: ${errorMessage}`,
    storyTitle ? `Story: ${storyTitle} (${storyId})` : null,
    `Severity: ${severity}`,
    `Code Location: ${sourceLocation}`,
    `Time: ${new Date().toISOString()}`,
    affectedUserId ? `Affected User: ${affectedUserId}` : null,
    ``,
    stackTrace ? `Stack Trace:\n${stackTrace.substring(0, 3000)}` : null,
    Object.keys(context).length > 0 ? `\nContext:\n${JSON.stringify(context, null, 2)}` : null
  ].filter(Boolean).join('\n');

  const { error: insertError } = await supabaseAdmin
    .from('bug_reports')
    .insert({
      user_id: PEGGY_SYSTEM_USER_ID,
      report_type: 'bug',
      interview_mode: 'automated',
      peggy_summary: summary,
      category,
      severity_hint: severity,
      user_description: 'Automated error capture by Peggy QA',
      steps_to_reproduce: storyTitle
        ? `Error in ${source} while processing "${storyTitle}" (${storyId})`
        : `Error in ${source}`,
      expected_behavior: 'Process should complete without errors',
      transcript,
      metadata: {
        source: 'peggy-auto-qa',
        error_source: source,
        error_message: errorMessage,
        stack_trace: stackTrace.substring(0, 5000),
        story_id: storyId,
        story_title: storyTitle,
        affected_user_id: affectedUserId,
        server_timestamp: new Date().toISOString(),
        node_env: process.env.NODE_ENV || 'unknown',
        ...context
      },
      status: 'ready'
    });

  if (insertError) {
    console.error(`🐞❌ Peggy failed to file report: ${insertError.message}`);
  } else {
    console.log(`🐞✅ Peggy filed bug report: ${source} — ${errorMessage.substring(0, 80)}`);
  }
}

// ============================================================
// SOURCE 3: Railway Deploy Webhook
// ============================================================

/**
 * Express route handler for Railway deploy webhooks.
 * Railway sends POST with deployment status changes.
 * Wire this up as: app.post('/webhooks/railway', railwayWebhookHandler)
 */
async function railwayWebhookHandler(req, res) {
  try {
    const payload = req.body;
    const type = payload?.type;

    // Only care about failures and crashes
    if (!['DEPLOY_FAILED', 'DEPLOY_CRASHED'].includes(type) &&
        !type?.includes('failed') && !type?.includes('crashed') &&
        !type?.includes('FAILED') && !type?.includes('CRASHED')) {
      // Acknowledge but don't report success events
      return res.json({ received: true, action: 'ignored' });
    }

    const status = payload?.status || type;
    const deployId = payload?.deployment?.id || payload?.id || 'unknown';
    const service = payload?.service?.name || payload?.meta?.service || 'unknown';
    const environment = payload?.environment?.name || payload?.meta?.environment || 'unknown';
    const errorMsg = payload?.error || payload?.message || `Deploy ${status}`;

    await reportToPeggy({
      source: `railway:${type}`,
      category: 'deploy',
      severity: 'critical',
      errorMessage: `Railway ${status}: ${errorMsg}`,
      context: {
        deploy_id: deployId,
        service,
        environment,
        raw_type: type,
        timestamp: payload?.timestamp || new Date().toISOString()
      }
    });

    res.json({ received: true, action: 'reported' });
  } catch (error) {
    console.error('🐞⚠️ Railway webhook processing failed:', error.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

// ============================================================
// Utilities
// ============================================================

/**
 * Sanitize request body — strip sensitive fields
 */
function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return {};
  const sanitized = { ...body };
  const sensitiveKeys = ['password', 'token', 'secret', 'authorization', 'apikey', 'api_key', 'credential'];
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
      sanitized[key] = '[REDACTED]';
    }
  }
  // Truncate large fields
  for (const key of Object.keys(sanitized)) {
    if (typeof sanitized[key] === 'string' && sanitized[key].length > 1000) {
      sanitized[key] = sanitized[key].substring(0, 1000) + '... [truncated]';
    }
  }
  return sanitized;
}

module.exports = {
  peggyErrorReporter,       // Express middleware for route 500s
  reportToPeggy,            // Shared utility — call from anywhere
  railwayWebhookHandler,    // Express route for Railway webhooks
  PEGGY_SYSTEM_USER_ID
};
