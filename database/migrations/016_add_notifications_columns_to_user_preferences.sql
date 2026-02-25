/**
 * Migration 016: Add notifications columns to user_preferences
 *
 * Adds timezone and apns_device_token for WhisperNet notification system.
 */

-- Add timezone column (stores IANA timezone identifier like "America/Los_Angeles")
ALTER TABLE user_preferences
ADD COLUMN timezone TEXT DEFAULT 'UTC';

-- Add apns_device_token column for push notifications
ALTER TABLE user_preferences
ADD COLUMN apns_device_token TEXT;

-- Create index on timezone for efficient digest job queries
CREATE INDEX idx_user_preferences_timezone ON user_preferences(timezone);
