/**
 * Peggy Auto-Error Reporter
 *
 * Global Express error middleware that automatically files bug reports
 * when server errors (500s) occur. Peggy becomes the first "user" to
 * report every crash — before any human beta tester notices.
 *
 * Reports land on the dashboard at 'ready' status for Steven to review.
 * Deduplicates by error message + endpoint to avoid flooding.
 */

const { supabaseAdmin } = require('../config/supabase');

// Fixed UUID for Peggy's system user (no auth.users record needed — no FK constraint)
const PEGGY_SYSTEM_USER_ID = '00000000-0000-0000-0000-peggy0000qa';

// In-memory dedup cache: key = "METHOD:PATH:ERROR_MSG" → last reported timestamp
const recentErrors = new Map();
const DEDUP_WINDOW_MS = 15 * 60 * 1000; // 15 minutes — same error on same endpoint is deduped

/**
 * Clean expired entries from the dedup cache (runs lazily)
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
 * Build a dedup key from the error context
 */
function dedupKey(method, path, errorMessage) {
  // Normalize: strip IDs from paths (e.g., /stories/abc-123 → /stories/:id)
  const normalizedPath = path.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ':id'
  );
  // Truncate error message to first 200 chars for grouping
  const shortMsg = (errorMessage || 'unknown').substring(0, 200);
  return `${method}:${normalizedPath}:${shortMsg}`;
}

/**
 * Express error middleware — catches 500s and files Peggy bug reports.
 *
 * IMPORTANT: This must be registered BEFORE the regular errorHandler
 * in server.js, and it must call next(err) to pass through.
 */
function peggyErrorReporter(err, req, res, next) {
  const statusCode = err.statusCode || err.status || 500;

  // Only file reports for actual server errors (500+), not 4xx client errors
  if (statusCode < 500) {
    return next(err);
  }

  // Fire and forget — don't slow down the error response to the user
  filePeggyReport(err, req, statusCode).catch(reportErr => {
    console.error('🐞⚠️ Peggy auto-reporter failed (non-fatal):', reportErr.message);
  });

  // Always pass through to the real error handler
  next(err);
}

/**
 * File a bug report as Peggy
 */
async function filePeggyReport(err, req, statusCode) {
  const method = req.method;
  const path = req.originalUrl || req.path;
  const errorMessage = err.message || 'Unknown error';
  const stack = err.stack || '';

  // Dedup check
  cleanDedup();
  const key = dedupKey(method, path, errorMessage);
  if (recentErrors.has(key)) {
    console.log(`🐞 Peggy: Duplicate error suppressed (${key.substring(0, 80)}...)`);
    return;
  }
  recentErrors.set(key, Date.now());

  // Extract affected user (if authenticated request)
  const affectedUserId = req.userId || null;

  // Build the report
  const peggyAnalysis = buildPeggyAnalysis(err, req, statusCode, affectedUserId);

  const { error: insertError } = await supabaseAdmin
    .from('bug_reports')
    .insert({
      user_id: PEGGY_SYSTEM_USER_ID,
      report_type: 'bug',
      interview_mode: 'automated',
      peggy_summary: peggyAnalysis.summary,
      category: 'server',
      severity_hint: statusCode >= 500 ? 'high' : 'medium',
      user_description: `Automated error capture by Peggy QA`,
      steps_to_reproduce: `${method} ${path}`,
      expected_behavior: 'Endpoint should return a successful response',
      transcript: peggyAnalysis.transcript,
      metadata: {
        source: 'peggy-auto-qa',
        endpoint: `${method} ${path}`,
        status_code: statusCode,
        error_message: errorMessage,
        stack_trace: stack.substring(0, 5000), // Cap at 5KB
        request_body: sanitizeBody(req.body),
        affected_user_id: affectedUserId,
        server_timestamp: new Date().toISOString(),
        node_env: process.env.NODE_ENV || 'unknown'
      },
      status: 'ready'
    });

  if (insertError) {
    console.error(`🐞❌ Peggy failed to file report: ${insertError.message}`);
  } else {
    console.log(`🐞✅ Peggy filed bug report: ${statusCode} on ${method} ${path}`);
  }
}

/**
 * Build a structured analysis that matches what the dashboard expects
 */
function buildPeggyAnalysis(err, req, statusCode, affectedUserId) {
  const method = req.method;
  const path = req.originalUrl || req.path;
  const errorMessage = err.message || 'Unknown error';
  const stack = err.stack || 'No stack trace available';

  // Extract the relevant source file from the stack trace
  const sourceMatch = stack.match(/at .+\((.+:\d+:\d+)\)/);
  const sourceLocation = sourceMatch ? sourceMatch[1] : 'unknown';

  const summary = `Server ${statusCode} on ${method} ${path}: ${errorMessage}`;

  const transcript = [
    `[Peggy Auto-QA Report]`,
    ``,
    `Error: ${errorMessage}`,
    `Endpoint: ${method} ${path}`,
    `Status: ${statusCode}`,
    `Source: ${sourceLocation}`,
    `Time: ${new Date().toISOString()}`,
    affectedUserId ? `Affected User: ${affectedUserId}` : 'Affected User: unauthenticated',
    ``,
    `Stack Trace:`,
    stack.substring(0, 3000),
    ``,
    `Request Body:`,
    JSON.stringify(sanitizeBody(req.body), null, 2)
  ].join('\n');

  return { summary, transcript };
}

/**
 * Sanitize request body — strip sensitive fields
 */
function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return {};
  const sanitized = { ...body };
  // Strip anything that looks sensitive
  const sensitiveKeys = ['password', 'token', 'secret', 'authorization', 'apikey', 'api_key', 'credential'];
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
      sanitized[key] = '[REDACTED]';
    }
  }
  // Truncate large fields (like transcripts or base64 images)
  for (const key of Object.keys(sanitized)) {
    if (typeof sanitized[key] === 'string' && sanitized[key].length > 1000) {
      sanitized[key] = sanitized[key].substring(0, 1000) + '... [truncated]';
    }
  }
  return sanitized;
}

module.exports = { peggyErrorReporter, PEGGY_SYSTEM_USER_ID };
