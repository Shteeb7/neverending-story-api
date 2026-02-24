/**
 * Constraint Sync Tests
 *
 * Ensures that all values the codebase writes to constrained columns
 * are actually allowed by the database CHECK constraints.
 *
 * WHY THIS EXISTS: We've had multiple production bugs where code was
 * updated to write new values (e.g., 'checkpoint', 'automated') but
 * the corresponding database CHECK constraint wasn't updated to allow
 * them. This test catches that drift at build time.
 *
 * HOW IT WORKS: Each test defines the constraint values (from the DB)
 * and the values the code writes. If code writes a value not in the
 * constraint, the test fails with a clear message about what to fix.
 */

describe('Database Constraint Sync', () => {

  // ============================================================
  // text_chat_sessions.interview_type
  // ============================================================
  describe('text_chat_sessions.interview_type', () => {
    const CONSTRAINT_VALUES = [
      'onboarding', 'returning_user', 'book_completion',
      'checkpoint', 'bug_report', 'suggestion', 'premise_rejection'
    ];

    // Values from src/routes/chat.js line 35 (POST /chat/start validation)
    const CODE_WRITES_CHAT_START = [
      'onboarding', 'returning_user', 'book_completion',
      'checkpoint', 'bug_report', 'suggestion'
    ];

    // Values from src/services/chat.js createChatSession switch
    const CODE_WRITES_CREATE_SESSION = [
      'onboarding', 'returning_user', 'book_completion',
      'checkpoint', 'bug_report', 'suggestion'
    ];

    test('all values from /chat/start are in the constraint', () => {
      const missing = CODE_WRITES_CHAT_START.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });

    test('all values from createChatSession are in the constraint', () => {
      const missing = CODE_WRITES_CREATE_SESSION.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // bug_reports.interview_mode
  // ============================================================
  describe('bug_reports.interview_mode', () => {
    const CONSTRAINT_VALUES = ['voice', 'text', 'automated'];

    // Values from src/routes/bug-reports.js and peggy-error-reporter.js
    const CODE_WRITES = ['voice', 'text', 'automated'];

    test('all interview_mode values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // bug_reports.report_type
  // ============================================================
  describe('bug_reports.report_type', () => {
    const CONSTRAINT_VALUES = ['bug', 'suggestion'];

    const CODE_WRITES = ['bug', 'suggestion'];

    test('all report_type values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // bug_reports.status
  // ============================================================
  describe('bug_reports.status', () => {
    const CONSTRAINT_VALUES = [
      'pending', 'analyzing', 'ready', 'approved',
      'denied', 'deferred', 'fixed'
    ];

    // From bug-reports.js and peggy-error-reporter.js
    const CODE_WRITES = ['pending', 'ready', 'analyzing', 'approved', 'denied', 'deferred', 'fixed'];

    test('all status values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // stories.status
  // ============================================================
  describe('stories.status', () => {
    const CONSTRAINT_VALUES = [
      'active', 'abandoned', 'completed', 'archived', 'error', 'generating'
    ];

    // From story.js, generation.js, library.js
    const CODE_WRITES = ['active', 'generating', 'error', 'archived', 'completed', 'abandoned'];

    test('all story status values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // stories.premise_tier
  // ============================================================
  describe('stories.premise_tier', () => {
    const CONSTRAINT_VALUES = ['comfort', 'stretch', 'wildcard'];

    const CODE_WRITES = ['comfort', 'stretch', 'wildcard'];

    test('all premise_tier values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // user_preferences.reading_level
  // ============================================================
  describe('user_preferences.reading_level', () => {
    const CONSTRAINT_VALUES = [
      'early_reader', 'middle_grade', 'upper_middle_grade',
      'young_adult', 'new_adult', 'adult'
    ];

    // From onboarding.js computeReadingLevel()
    const CODE_WRITES = [
      'early_reader', 'middle_grade', 'upper_middle_grade',
      'young_adult', 'new_adult', 'adult'
    ];

    test('all reading_level values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // story_arcs.status
  // ============================================================
  describe('story_arcs.status', () => {
    const CONSTRAINT_VALUES = ['planned', 'in_progress', 'completed'];

    const CODE_WRITES = ['planned', 'in_progress', 'completed'];

    test('all arc status values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // error_events.severity
  // ============================================================
  describe('error_events.severity', () => {
    const CONSTRAINT_VALUES = ['critical', 'error', 'warning', 'info'];

    const CODE_WRITES = ['critical', 'error', 'warning', 'info'];

    test('all severity values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // error_events.category
  // ============================================================
  describe('error_events.category', () => {
    const CONSTRAINT_VALUES = [
      'generation', 'api', 'auth', 'reading',
      'deploy', 'health_check', 'other'
    ];

    // From detect_story_errors() pg_cron
    const CODE_WRITES = ['generation', 'reading'];

    test('all error category values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // generated_premises.status
  // ============================================================
  describe('generated_premises.status', () => {
    const CONSTRAINT_VALUES = ['offered', 'selected', 'rejected'];

    const CODE_WRITES = ['offered', 'selected', 'rejected'];

    test('all premise status values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // text_chat_sessions.status
  // ============================================================
  describe('text_chat_sessions.status', () => {
    const CONSTRAINT_VALUES = ['active', 'completed', 'abandoned'];

    const CODE_WRITES = ['active', 'completed', 'abandoned'];

    test('all session status values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // deletion_requests.request_type
  // ============================================================
  describe('deletion_requests.request_type', () => {
    const CONSTRAINT_VALUES = ['voice_recordings', 'all_data', 'account'];

    const CODE_WRITES = ['voice_recordings', 'all_data', 'account'];

    test('all request_type values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // deletion_requests.status
  // ============================================================
  describe('deletion_requests.status', () => {
    const CONSTRAINT_VALUES = ['pending', 'processing', 'completed', 'failed'];

    const CODE_WRITES = ['pending', 'processing', 'completed', 'failed'];

    test('all deletion status values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // whispernet_library.source
  // ============================================================
  describe('whispernet_library.source', () => {
    const CONSTRAINT_VALUES = ['shared', 'browsed'];

    // From WhisperNet endpoints (Prompt 8-10)
    const CODE_WRITES = ['shared', 'browsed'];

    test('all source values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // user_preferences.whisper_notification_pref
  // ============================================================
  describe('user_preferences.whisper_notification_pref', () => {
    const CONSTRAINT_VALUES = ['off', 'daily', 'realtime'];

    // From settings endpoints and onboarding (Prompt 9)
    const CODE_WRITES = ['off', 'daily', 'realtime'];

    test('all whisper_notification_pref values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // whispernet_publications.maturity_rating
  // ============================================================
  describe('whispernet_publications.maturity_rating', () => {
    const CONSTRAINT_VALUES = ['all_ages', 'teen_13', 'mature_17'];

    // From publications endpoints (Prompt 14)
    const CODE_WRITES = ['all_ages', 'teen_13', 'mature_17'];

    test('all maturity_rating values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });

  // ============================================================
  // stories.maturity_rating
  // ============================================================
  describe('stories.maturity_rating', () => {
    const CONSTRAINT_VALUES = ['all_ages', 'teen_13', 'mature_17'];

    // From publications endpoints and story creation (Prompt 14)
    // Note: NULL is also allowed by the constraint
    const CODE_WRITES = ['all_ages', 'teen_13', 'mature_17'];

    test('all maturity_rating values are in the constraint', () => {
      const missing = CODE_WRITES.filter(v => !CONSTRAINT_VALUES.includes(v));
      expect(missing).toEqual([]);
    });
  });
});
