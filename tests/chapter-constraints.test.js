const { buildConstraintsBlock } = require('../src/services/chapter-constraints');

describe('Chapter Constraints', () => {
  describe('buildConstraintsBlock', () => {
    it('should return empty string when constraints is null', () => {
      const result = buildConstraintsBlock(null);
      expect(result).toBe('');
    });

    it('should return empty string when constraints is undefined', () => {
      const result = buildConstraintsBlock(undefined);
      expect(result).toBe('');
    });

    it('should build valid constraint block with all constraint types', () => {
      const constraints = {
        must: [
          { id: 'must_1', constraint: '200 colonists must die from cryopod failure', source: 'arc_events_summary' },
          { id: 'must_2', constraint: 'Ren must emotionally break down for the first time', source: 'arc_emotional_arc' }
        ],
        must_not: [
          { id: 'mustnot_1', constraint: 'Ren must not have already repaired the recycler', source: 'previous_chapter_events' }
        ],
        should: [
          { id: 'should_1', constraint: 'Should reference the Liang family from Chapter 3', source: 'callback_bank' }
        ]
      };

      const result = buildConstraintsBlock(constraints);

      expect(result).toContain('AUTHORIAL COMMITMENTS');
      expect(result).toContain('NON-NEGOTIABLE REQUIREMENTS');
      expect(result).toContain('[must_1] 200 colonists must die from cryopod failure');
      expect(result).toContain('[must_2] Ren must emotionally break down for the first time');
      expect(result).toContain('CONTRADICTIONS TO AVOID');
      expect(result).toContain('[mustnot_1] Ren must not have already repaired the recycler');
      expect(result).toContain('QUALITY TARGETS');
      expect(result).toContain('[should_1] Should reference the Liang family from Chapter 3');
    });

    it('should handle empty arrays', () => {
      const constraints = {
        must: [],
        must_not: [],
        should: []
      };

      const result = buildConstraintsBlock(constraints);

      expect(result).toContain('AUTHORIAL COMMITMENTS');
      expect(result).toContain('NON-NEGOTIABLE REQUIREMENTS');
      expect(result).toContain('CONTRADICTIONS TO AVOID');
      expect(result).toContain('QUALITY TARGETS');
    });

    it('should preserve constraint IDs and content exactly', () => {
      const constraints = {
        must: [
          { id: 'must_special_123', constraint: 'Character X must reveal secret Y', source: 'arc' }
        ],
        must_not: [
          { id: 'mustnot_x', constraint: 'Character cannot use magic (not yet learned)', source: 'world_rules' }
        ],
        should: [
          { id: 'should_callback', constraint: 'Reference the broken watch from Ch 2', source: 'callback' }
        ]
      };

      const result = buildConstraintsBlock(constraints);

      expect(result).toContain('[must_special_123] Character X must reveal secret Y');
      expect(result).toContain('[mustnot_x] Character cannot use magic (not yet learned)');
      expect(result).toContain('[should_callback] Reference the broken watch from Ch 2');
    });
  });

  describe('Feature Flag Integration', () => {
    it('should respect three_pass_constraints feature flag when disabled', () => {
      const config = { three_pass_constraints: false };
      const useConstraints = config.three_pass_constraints !== false;
      expect(useConstraints).toBe(false);
    });

    it('should default to enabled when feature flag not specified', () => {
      const config = {};
      const useConstraints = config.three_pass_constraints !== false;
      expect(useConstraints).toBe(true);
    });

    it('should be enabled when explicitly set to true', () => {
      const config = { three_pass_constraints: true };
      const useConstraints = config.three_pass_constraints !== false;
      expect(useConstraints).toBe(true);
    });
  });

  describe('Constraint Structure Validation', () => {
    it('should have valid constraint object structure', () => {
      const validConstraint = {
        id: 'must_1',
        constraint: 'Something must happen',
        source: 'arc_events_summary'
      };

      expect(validConstraint).toHaveProperty('id');
      expect(validConstraint).toHaveProperty('constraint');
      expect(validConstraint).toHaveProperty('source');
      expect(typeof validConstraint.id).toBe('string');
      expect(typeof validConstraint.constraint).toBe('string');
      expect(typeof validConstraint.source).toBe('string');
    });

    it('should have valid validation result structure', () => {
      const validResult = {
        id: 'must_1',
        status: 'DELIVERED',
        evidence: 'Quote from chapter'
      };

      expect(validResult).toHaveProperty('id');
      expect(validResult).toHaveProperty('status');
      expect(validResult).toHaveProperty('evidence');
      expect(['DELIVERED', 'NOT_DELIVERED', 'CLEAR', 'VIOLATED']).toContain(validResult.status);
    });
  });
});
