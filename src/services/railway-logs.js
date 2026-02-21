/**
 * RAILWAY LOG PULLER — Fetch deployment logs via Railway GraphQL API
 *
 * Pulls runtime/build logs for the current deployment when errors are detected.
 * Used by Peggy error reports and error_events to attach application logs
 * for root-cause analysis.
 *
 * Requires env var: RAILWAY_API_TOKEN (generated from Railway account settings)
 *
 * Usage:
 *   const { pullRecentLogs, pullDeploymentLogs } = require('./railway-logs');
 *   const logs = await pullRecentLogs({ minutes: 10, limit: 200 });
 *   // Returns array of { timestamp, message, severity }
 */

const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';

/**
 * Execute a GraphQL query against Railway's API.
 * @param {string} query - GraphQL query string
 * @param {object} variables - Query variables
 * @returns {Promise<object>} GraphQL response data
 */
async function railwayGraphQL(query, variables = {}) {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) {
    throw new Error('RAILWAY_API_TOKEN not configured — cannot pull Railway logs');
  }

  const response = await fetch(RAILWAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`Railway API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(`Railway API error: ${result.errors[0].message}`);
  }

  return result.data;
}

/**
 * Get the currently active deployment ID for our service.
 * Uses RAILWAY_SERVICE_ID env var (auto-set by Railway runtime).
 * @returns {Promise<string|null>} Deployment ID or null
 */
async function getCurrentDeploymentId() {
  const serviceId = process.env.RAILWAY_SERVICE_ID;
  if (!serviceId) {
    // Not running on Railway (local dev)
    return null;
  }

  const query = `
    query deployments($serviceId: String!, $limit: Int) {
      deployments(
        input: {
          serviceId: $serviceId
        }
        first: $limit
      ) {
        edges {
          node {
            id
            status
            createdAt
          }
        }
      }
    }
  `;

  const data = await railwayGraphQL(query, { serviceId, limit: 1 });
  const deployment = data?.deployments?.edges?.[0]?.node;
  return deployment?.id || null;
}

/**
 * Pull runtime logs for a specific deployment.
 * @param {string} deploymentId - Railway deployment ID
 * @param {object} options - { limit, startDate, endDate, filter }
 * @returns {Promise<Array<{timestamp: string, message: string, severity: string}>>}
 */
async function pullDeploymentLogs(deploymentId, options = {}) {
  const { limit = 200, startDate, endDate, filter } = options;

  const query = `
    query deploymentLogs($deploymentId: String!, $limit: Int, $startDate: DateTime, $endDate: DateTime, $filter: String) {
      deploymentLogs(
        deploymentId: $deploymentId
        limit: $limit
        startDate: $startDate
        endDate: $endDate
        filter: $filter
      ) {
        timestamp
        message
        severity
      }
    }
  `;

  const variables = { deploymentId, limit };
  if (startDate) variables.startDate = startDate;
  if (endDate) variables.endDate = endDate;
  if (filter) variables.filter = filter;

  const data = await railwayGraphQL(query, variables);
  return data?.deploymentLogs || [];
}

/**
 * Pull build logs for a specific deployment.
 * @param {string} deploymentId - Railway deployment ID
 * @param {object} options - { limit }
 * @returns {Promise<Array<{timestamp: string, message: string, severity: string}>>}
 */
async function pullBuildLogs(deploymentId, options = {}) {
  const { limit = 200 } = options;

  const query = `
    query buildLogs($deploymentId: String!, $limit: Int) {
      buildLogs(deploymentId: $deploymentId, limit: $limit) {
        timestamp
        message
        severity
      }
    }
  `;

  const data = await railwayGraphQL(query, { deploymentId, limit });
  return data?.buildLogs || [];
}

/**
 * Pull recent runtime logs (last N minutes) for the current deployment.
 * This is the primary convenience method for error diagnostics.
 *
 * @param {object} options
 * @param {number} options.minutes - How far back to pull (default: 10)
 * @param {number} options.limit - Max log lines (default: 200)
 * @param {string} options.filter - Optional filter string
 * @returns {Promise<{logs: Array, deploymentId: string|null, error: string|null}>}
 */
async function pullRecentLogs(options = {}) {
  const { minutes = 10, limit = 200, filter } = options;

  try {
    const deploymentId = await getCurrentDeploymentId();
    if (!deploymentId) {
      return { logs: [], deploymentId: null, error: 'No deployment ID (not on Railway or API token missing)' };
    }

    const startDate = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const logs = await pullDeploymentLogs(deploymentId, { limit, startDate, filter });

    return { logs, deploymentId, error: null };

  } catch (err) {
    return { logs: [], deploymentId: null, error: err.message };
  }
}

/**
 * Format logs into a compact string for storage in error_logs fields.
 * @param {Array} logs - Array of { timestamp, message, severity }
 * @returns {string} Formatted log string
 */
function formatLogsForStorage(logs) {
  if (!logs?.length) return '';
  return logs
    .map(l => {
      const ts = l.timestamp ? new Date(l.timestamp).toISOString().slice(11, 23) : '??:??:??';
      const sev = l.severity === 'error' ? '❌' : l.severity === 'warn' ? '⚠️' : '';
      return `[${ts}]${sev ? ' ' + sev : ''} ${l.message}`;
    })
    .join('\n');
}

/**
 * Check if Railway API is configured and reachable.
 * @returns {Promise<{available: boolean, reason: string}>}
 */
async function checkRailwayApiAvailability() {
  if (!process.env.RAILWAY_API_TOKEN) {
    return { available: false, reason: 'RAILWAY_API_TOKEN not set' };
  }
  if (!process.env.RAILWAY_SERVICE_ID) {
    return { available: false, reason: 'RAILWAY_SERVICE_ID not set (not running on Railway)' };
  }

  try {
    const deploymentId = await getCurrentDeploymentId();
    return {
      available: !!deploymentId,
      reason: deploymentId ? `Connected (deployment: ${deploymentId.slice(0, 8)}...)` : 'No active deployment found'
    };
  } catch (err) {
    return { available: false, reason: `API error: ${err.message}` };
  }
}

module.exports = {
  pullRecentLogs,
  pullDeploymentLogs,
  pullBuildLogs,
  getCurrentDeploymentId,
  formatLogsForStorage,
  checkRailwayApiAvailability
};
