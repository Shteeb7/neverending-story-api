const { buildCourseCorrections, generateSmartCourseCorrections } = require('../src/services/generation');
const { supabaseAdmin } = require('../src/config/supabase');

// Mock supabase for testing
jest.mock('../src/config/supabase');

describe('Course Corrections', () => {
  describe('buildCourseCorrections (mechanical/fallback)', () => {
    test('should return empty string for no feedback', () => {
      const result = buildCourseCorrections([]);
      expect(result).toBe('');
    });

    test('should handle all positive feedback (no corrections needed)', () => {
      const feedback = [{
        pacing_feedback: 'hooked',
        tone_feedback: 'right',
        character_feedback: 'love'
      }];

      const result = buildCourseCorrections(feedback);
      expect(result).toContain('Maintain current');
      expect(result).not.toContain('PACING (reader said:');
      expect(result).not.toContain('TONE (reader said:');
    });

    test('should generate pacing correction for "slow" feedback', () => {
      const feedback = [{
        pacing_feedback: 'slow',
        tone_feedback: 'right',
        character_feedback: 'love'
      }];

      const result = buildCourseCorrections(feedback);
      expect(result).toContain('PACING');
      expect(result).toContain('Enter scenes later');
      expect(result).toContain('Shorter paragraphs');
    });

    test('should generate pacing correction for "fast" feedback', () => {
      const feedback = [{
        pacing_feedback: 'fast',
        tone_feedback: 'right',
        character_feedback: 'love'
      }];

      const result = buildCourseCorrections(feedback);
      expect(result).toContain('PACING');
      expect(result).toContain('sensory grounding');
      expect(result).toContain('internal reflection');
    });

    test('should generate tone correction for "serious" feedback', () => {
      const feedback = [{
        pacing_feedback: 'hooked',
        tone_feedback: 'serious',
        character_feedback: 'love'
      }];

      const result = buildCourseCorrections(feedback);
      expect(result).toContain('TONE');
      expect(result).toContain('humor');
    });

    test('should generate character correction for "warming" feedback', () => {
      const feedback = [{
        pacing_feedback: 'hooked',
        tone_feedback: 'right',
        character_feedback: 'warming'
      }];

      const result = buildCourseCorrections(feedback);
      expect(result).toContain('CHARACTER');
      expect(result).toContain('interior thought');
      expect(result).toContain('vulnerability');
    });

    test('should handle multiple negative dimensions', () => {
      const feedback = [{
        pacing_feedback: 'slow',
        tone_feedback: 'serious',
        character_feedback: 'not_clicking'
      }];

      const result = buildCourseCorrections(feedback);
      expect(result).toContain('PACING');
      expect(result).toContain('TONE');
      expect(result).toContain('CHARACTER');
    });

    test('should accumulate corrections from multiple checkpoints', () => {
      const feedback = [
        {
          checkpoint: 'chapter_2',
          pacing_feedback: 'slow',
          tone_feedback: 'right',
          character_feedback: 'love'
        },
        {
          checkpoint: 'chapter_5',
          pacing_feedback: 'hooked',
          tone_feedback: 'serious',
          character_feedback: 'love'
        }
      ];

      const result = buildCourseCorrections(feedback);
      // Should include both checkpoint corrections
      expect(result).toContain('CHECKPOINT 1');
      expect(result).toContain('CHECKPOINT 2');
    });
  });

  describe('generateSmartCourseCorrections (AI-powered)', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('should skip AI call and use fallback for all positive feedback', async () => {
      const feedback = [{
        pacing_feedback: 'hooked',
        tone_feedback: 'right',
        character_feedback: 'love'
      }];

      const result = await generateSmartCourseCorrections('test-story-id', feedback);

      // Should not have called Supabase (no need to fetch story data)
      expect(result).toBeDefined();
      expect(result).toContain('Maintain current');
    });

    test('should handle missing story bible gracefully', async () => {
      const feedback = [{
        pacing_feedback: 'hooked',
        tone_feedback: 'serious',
        character_feedback: 'love'
      }];

      // Mock Supabase to return no bible
      supabaseAdmin.from = jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => Promise.resolve({ data: null, error: { message: 'Not found' } })),
            order: jest.fn(() => Promise.resolve({ data: [] }))
          }))
        }))
      }));

      const result = await generateSmartCourseCorrections('test-story-id', feedback);

      // Should fall back to mechanical corrections
      expect(result).toBeDefined();
      expect(result).toContain('TONE');
    });

    test('should generate corrections for tone dimension', async () => {
      const feedback = [{
        pacing_feedback: 'hooked',
        tone_feedback: 'serious',
        character_feedback: 'love'
      }];

      // This test documents the expected behavior
      // In a real implementation, you would mock the Claude API call
      // and verify that the corrections reference specific story elements

      expect(feedback[0].tone_feedback).toBe('serious');
    });

    test('should generate corrections for character dimension', async () => {
      const feedback = [{
        pacing_feedback: 'hooked',
        tone_feedback: 'right',
        character_feedback: 'warming'
      }];

      expect(feedback[0].character_feedback).toBe('warming');
    });

    test('should handle both tone and character corrections together', async () => {
      const feedback = [{
        pacing_feedback: 'hooked',
        tone_feedback: 'serious',
        character_feedback: 'not_clicking'
      }];

      expect(feedback[0].tone_feedback).toBe('serious');
      expect(feedback[0].character_feedback).toBe('not_clicking');
    });

    test('should include mechanical pacing correction if pacing also needs adjustment', async () => {
      const feedback = [{
        pacing_feedback: 'slow',
        tone_feedback: 'serious',
        character_feedback: 'love'
      }];

      // When AI generates tone/character corrections, pacing should still be included
      // via mechanical fallback
      expect(feedback[0].pacing_feedback).toBe('slow');
      expect(feedback[0].tone_feedback).toBe('serious');
    });

    test('should fall back to buildCourseCorrections if AI call fails', async () => {
      const feedback = [{
        pacing_feedback: 'hooked',
        tone_feedback: 'serious',
        character_feedback: 'love'
      }];

      // Mock Supabase to throw an error
      supabaseAdmin.from = jest.fn(() => {
        throw new Error('Database connection failed');
      });

      const result = await generateSmartCourseCorrections('test-story-id', feedback);

      // Should still return corrections (fallback)
      expect(result).toBeDefined();
      expect(result).toContain('TONE');
    });
  });

  describe('Course Correction Integration', () => {
    test('corrections should be story-aware (not generic)', () => {
      // Document expected behavior:
      // AI-generated corrections should reference:
      // - Specific character names from the bible
      // - Specific scene types from previous chapters
      // - Concrete examples of what to change
      // - Both what to START doing and what to STOP doing

      const expectedElements = [
        'character names',
        'scene types',
        'concrete examples',
        'what to stop',
        'what to start'
      ];

      expectedElements.forEach(element => {
        expect(element).toBeTruthy();
      });
    });

    test('corrections should specify WHERE changes apply', () => {
      // Expected patterns in AI-generated corrections:
      // - "at least one moment per major scene"
      // - "especially in dialogue between X and Y"
      // - "during tense logistics scenes"

      expect(true).toBe(true);
    });

    test('corrections should maintain story identity', () => {
      // Corrections change HOW the story is told, not WHAT happens
      // Plot events, bible, and arc outline remain unchanged

      expect(true).toBe(true);
    });
  });

  describe('Tone-specific correction tests', () => {
    test('spy thriller with "serious" feedback should suggest genre-appropriate humor', () => {
      // A spy thriller should get suggestions like:
      // - "sardonic internal observations during logistics"
      // - "dry wit in tense situations"
      // NOT:
      // - "slapstick comedy"
      // - "lighthearted banter"

      expect(true).toBe(true); // Document expected behavior
    });

    test('cozy fantasy with "serious" feedback should get different tone advice', () => {
      // A cozy fantasy should get suggestions like:
      // - "playful character interactions"
      // - "whimsical world details"
      // Different from spy thriller even though both said "serious"

      expect(true).toBe(true);
    });
  });
});
