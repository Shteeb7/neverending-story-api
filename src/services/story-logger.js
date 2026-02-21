/**
 * STORY LOGGER — Per-story ring buffer for capturing generation logs
 *
 * Maintains an in-memory log buffer per story so that when errors occur,
 * we can dump the recent log trail into generation_progress.error_logs.
 *
 * Usage:
 *   const { storyLog } = require('./story-logger');
 *   storyLog(storyId, storyTitle, '📖 Starting chapter generation...');
 *   // On error:
 *   const logs = getStoryLogs(storyId);
 *   // Store logs in generation_progress.error_logs
 *
 * Buffer auto-purges stories that haven't logged in 30 minutes.
 */

const MAX_LINES_PER_STORY = 75;
const PURGE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

// Map<storyId, { lines: string[], lastActivity: number }>
const buffers = new Map();

/**
 * Log a message for a specific story.
 * Writes to both console.log AND the story's ring buffer.
 *
 * @param {string} storyId - The story UUID
 * @param {string} storyTitle - The story title (for console prefix)
 * @param {string} message - The log message (already formatted with emoji)
 */
function storyLog(storyId, storyTitle, message) {
  // Always write to console (Railway captures this)
  console.log(message);

  if (!storyId) return;

  // Get or create buffer
  if (!buffers.has(storyId)) {
    buffers.set(storyId, { lines: [], lastActivity: Date.now() });
  }

  const buffer = buffers.get(storyId);
  const timestamp = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  buffer.lines.push(`[${timestamp}] ${message}`);
  buffer.lastActivity = Date.now();

  // Enforce ring buffer limit
  if (buffer.lines.length > MAX_LINES_PER_STORY) {
    buffer.lines = buffer.lines.slice(-MAX_LINES_PER_STORY);
  }
}

/**
 * Get all buffered logs for a story.
 * Returns the log lines as a single string (newline-separated).
 *
 * @param {string} storyId - The story UUID
 * @returns {string} The buffered log lines, or empty string if none
 */
function getStoryLogs(storyId) {
  if (!storyId || !buffers.has(storyId)) return '';
  return buffers.get(storyId).lines.join('\n');
}

/**
 * Get buffered logs as an array.
 *
 * @param {string} storyId - The story UUID
 * @returns {string[]} Array of log lines
 */
function getStoryLogArray(storyId) {
  if (!storyId || !buffers.has(storyId)) return [];
  return [...buffers.get(storyId).lines];
}

/**
 * Clear the buffer for a story (call after successful generation completes).
 *
 * @param {string} storyId - The story UUID
 */
function clearStoryLogs(storyId) {
  buffers.delete(storyId);
}

/**
 * Get buffer stats for monitoring.
 *
 * @returns {{ activeStories: number, totalLines: number }}
 */
function getBufferStats() {
  let totalLines = 0;
  for (const [, buffer] of buffers) {
    totalLines += buffer.lines.length;
  }
  return { activeStories: buffers.size, totalLines };
}

// Auto-purge stale buffers every 10 minutes
// Use .unref() so this timer doesn't prevent Node/Jest from exiting
const purgeTimer = setInterval(() => {
  const now = Date.now();
  let purged = 0;
  for (const [storyId, buffer] of buffers) {
    if (now - buffer.lastActivity > STALE_THRESHOLD_MS) {
      buffers.delete(storyId);
      purged++;
    }
  }
  if (purged > 0) {
    console.log(`🧹 Story logger: purged ${purged} stale buffers (${buffers.size} remaining)`);
  }
}, PURGE_INTERVAL_MS);
purgeTimer.unref();

module.exports = {
  storyLog,
  getStoryLogs,
  getStoryLogArray,
  clearStoryLogs,
  getBufferStats
};
