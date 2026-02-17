const peggy = require('../src/config/peggy');

describe('Peggy Configuration', () => {
  describe('Exports', () => {
    test('exports assemblePrompt function', () => {
      expect(typeof peggy.assemblePrompt).toBe('function');
    });

    test('exports getGreeting function', () => {
      expect(typeof peggy.getGreeting).toBe('function');
    });

    test('exports CORE_PERSONALITY constant', () => {
      expect(typeof peggy.CORE_PERSONALITY).toBe('string');
      expect(peggy.CORE_PERSONALITY.length).toBeGreaterThan(0);
    });

    test('exports MEDIUM_ADAPTERS object', () => {
      expect(typeof peggy.MEDIUM_ADAPTERS).toBe('object');
      expect(peggy.MEDIUM_ADAPTERS).toHaveProperty('voice');
      expect(peggy.MEDIUM_ADAPTERS).toHaveProperty('text');
    });

    test('exports REPORT_TEMPLATES object', () => {
      expect(typeof peggy.REPORT_TEMPLATES).toBe('object');
      expect(peggy.REPORT_TEMPLATES).toHaveProperty('bug_report');
      expect(peggy.REPORT_TEMPLATES).toHaveProperty('suggestion');
    });

    test('exports GREETING_TEMPLATES object', () => {
      expect(typeof peggy.GREETING_TEMPLATES).toBe('object');
      expect(peggy.GREETING_TEMPLATES).toHaveProperty('bug_report');
      expect(peggy.GREETING_TEMPLATES).toHaveProperty('suggestion');
    });
  });

  describe('assemblePrompt()', () => {
    test('assembles bug_report prompt for voice', () => {
      const prompt = peggy.assemblePrompt('bug_report', 'voice', {
        user_name: 'TestUser',
        reading_level: 'adult'
      });

      expect(typeof prompt).toBe('string');
      expect(prompt).toContain('PEGGY');
      expect(prompt).toContain('VOICE CONVERSATION');
      expect(prompt).toContain('bug');
    });

    test('assembles bug_report prompt for text', () => {
      const prompt = peggy.assemblePrompt('bug_report', 'text', {
        user_name: 'TestUser',
        reading_level: 'adult'
      });

      expect(typeof prompt).toBe('string');
      expect(prompt).toContain('PEGGY');
      expect(prompt).toContain('WRITTEN CORRESPONDENCE');
      expect(prompt).toContain('bug');
    });

    test('assembles suggestion prompt for voice', () => {
      const prompt = peggy.assemblePrompt('suggestion', 'voice', {
        user_name: 'TestUser',
        reading_level: 'adult'
      });

      expect(typeof prompt).toBe('string');
      expect(prompt).toContain('PEGGY');
      expect(prompt).toContain('suggestion');
    });

    test('assembles suggestion prompt for text', () => {
      const prompt = peggy.assemblePrompt('suggestion', 'text', {
        user_name: 'TestUser',
        reading_level: 'adult'
      });

      expect(typeof prompt).toBe('string');
      expect(prompt).toContain('PEGGY');
      expect(prompt).toContain('suggestion');
    });

    test('adjusts tone for young readers in bug_report', () => {
      const promptYoung = peggy.assemblePrompt('bug_report', 'voice', {
        user_name: 'YoungReader',
        reading_level: 'early_reader'
      });

      expect(promptYoung).toContain('TONE ADJUSTMENT');
      expect(promptYoung).toContain('young');
    });

    test('adjusts tone for young readers in suggestion', () => {
      const promptYoung = peggy.assemblePrompt('suggestion', 'voice', {
        user_name: 'YoungReader',
        reading_level: 'middle_grade'
      });

      expect(promptYoung).toContain('TONE ADJUSTMENT');
      expect(promptYoung).toContain('young');
    });

    test('does not adjust tone for adult readers', () => {
      const promptAdult = peggy.assemblePrompt('bug_report', 'voice', {
        user_name: 'AdultReader',
        reading_level: 'adult'
      });

      expect(promptAdult).not.toContain('TONE ADJUSTMENT');
    });

    test('throws error for invalid report type', () => {
      expect(() => {
        peggy.assemblePrompt('invalid_type', 'voice', {});
      }).toThrow('Unknown report type: invalid_type');
    });

    test('throws error for invalid medium', () => {
      expect(() => {
        peggy.assemblePrompt('bug_report', 'invalid_medium', {});
      }).toThrow('Unknown medium: invalid_medium');
    });

    test('includes submit_bug_report function tool definition', () => {
      const prompt = peggy.assemblePrompt('bug_report', 'voice', {});
      expect(prompt).toContain('submit_bug_report');
      expect(prompt).toContain('summary');
      expect(prompt).toContain('category');
      expect(prompt).toContain('severity_hint');
    });
  });

  describe('getGreeting()', () => {
    test('returns bug_report greeting', () => {
      const greeting = peggy.getGreeting('bug_report', {
        user_name: 'TestUser'
      });

      expect(typeof greeting).toBe('string');
      expect(greeting.length).toBeGreaterThan(0);
      expect(greeting).toContain('hon');
    });

    test('returns suggestion greeting with user name', () => {
      const greeting = peggy.getGreeting('suggestion', {
        user_name: 'TestUser'
      });

      expect(typeof greeting).toBe('string');
      expect(greeting).toContain('TestUser');
    });

    test('returns suggestion greeting without user name', () => {
      const greeting = peggy.getGreeting('suggestion', {});

      expect(typeof greeting).toBe('string');
      expect(greeting).toContain('hon');  // Falls back to "hon"
    });

    test('returns default greeting for unknown report type', () => {
      const greeting = peggy.getGreeting('unknown_type', {});

      expect(typeof greeting).toBe('string');
      expect(greeting).toBe("Alright hon, what can I do for ya?");
    });
  });

  describe('Personality Consistency', () => {
    test('all prompts include Peggy personality traits', () => {
      const bugPrompt = peggy.assemblePrompt('bug_report', 'voice', {});
      const suggestionPrompt = peggy.assemblePrompt('suggestion', 'text', {});

      expect(bugPrompt).toContain('1950s');
      expect(bugPrompt).toContain('Long Island');
      expect(suggestionPrompt).toContain('1950s');
      expect(suggestionPrompt).toContain('Long Island');
    });

    test('prompts include conversation rules', () => {
      const prompt = peggy.assemblePrompt('bug_report', 'voice', {});

      expect(prompt).toContain('SHORT');
      expect(prompt).toContain('ONE question per turn');
    });

    test('voice medium emphasizes brevity', () => {
      const voicePrompt = peggy.assemblePrompt('bug_report', 'voice', {});

      expect(voicePrompt).toContain('VOICE CONVERSATION');
      expect(voicePrompt).toContain('Maximum 1-2 sentences');
    });

    test('text medium allows slightly more detail', () => {
      const textPrompt = peggy.assemblePrompt('bug_report', 'text', {});

      expect(textPrompt).toContain('WRITTEN CORRESPONDENCE');
      expect(textPrompt).toContain('1-2 sentences');
    });
  });

  describe('Context Handling', () => {
    test('includes user context in prompt when provided', () => {
      const context = {
        user_name: 'Alice',
        reading_level: 'young_adult',
        account_age: '6 months',
        num_stories: 5
      };

      const prompt = peggy.assemblePrompt('bug_report', 'voice', context);

      expect(prompt).toContain('Alice');
      expect(prompt).toContain('young_adult');
      expect(prompt).toContain('6 months');
      expect(prompt).toContain('5');
    });

    test('handles missing context gracefully', () => {
      const prompt = peggy.assemblePrompt('bug_report', 'voice', {});

      expect(typeof prompt).toBe('string');
      expect(prompt).toContain('not provided');
      expect(prompt).toContain('unknown');
    });

    test('handles undefined context gracefully', () => {
      const prompt = peggy.assemblePrompt('bug_report', 'voice');

      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });
  });
});
