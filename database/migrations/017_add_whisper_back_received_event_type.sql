/**
 * Migration 017: Add whisper_back_received to whisper_events.event_type constraint
 *
 * The notification system needs to handle whisper_back_received events.
 */

-- Drop the old CHECK constraint
ALTER TABLE whisper_events
DROP CONSTRAINT IF EXISTS whisper_events_event_type_check;

-- Add new CHECK constraint with whisper_back_received included
ALTER TABLE whisper_events
ADD CONSTRAINT whisper_events_event_type_check
CHECK (event_type IN (
  'book_published',
  'book_gifted',
  'book_claimed',
  'resonance_left',
  'whisper_back_received',
  'badge_earned',
  'reading_started'
));
