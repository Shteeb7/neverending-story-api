/**
 * Admin configuration and utilities
 * Shared across all routes that require admin-only access
 */

// Admin email list (expandable for future admins)
const ADMIN_EMAILS = [
  'steven.labrum@gmail.com'
];

/**
 * Check if a user is an admin based on their email
 * @param {Object} user - User object from authentication middleware
 * @returns {boolean} - True if user is an admin
 */
function isAdmin(user) {
  return user && user.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
}

module.exports = {
  ADMIN_EMAILS,
  isAdmin
};
