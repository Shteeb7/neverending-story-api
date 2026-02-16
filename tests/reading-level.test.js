const { supabaseAdmin } = require('../src/config/supabase');

/**
 * Copy of computeReadingLevel from onboarding.js for testing
 */
function computeReadingLevel(birthMonth, birthYear, preferences) {
  // 1. Start with age-based baseline
  const now = new Date();
  let age;
  if (birthMonth && birthYear) {
    // Conservative calculation: if birth month hasn't fully passed, subtract a year
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    age = currentYear - birthYear;
    if (currentMonth <= birthMonth) {
      age -= 1;
    }
  }

  // Age-based baseline
  let baseline;
  if (!age || age >= 25) baseline = 'adult';
  else if (age >= 18) baseline = 'new_adult';
  else if (age >= 14) baseline = 'young_adult';
  else if (age >= 12) baseline = 'upper_middle_grade';
  else if (age >= 10) baseline = 'middle_grade';
  else baseline = 'early_reader';

  // 2. If Prospero derived a readingLevel from the conversation, use it —
  //    but never go MORE than one level above the age baseline.
  //    (A 10-year-old who loves Hunger Games gets upper_middle_grade, not young_adult)
  if (preferences.readingLevel) {
    const levels = ['early_reader', 'middle_grade', 'upper_middle_grade', 'young_adult', 'new_adult', 'adult'];
    const baselineIndex = levels.indexOf(baseline);
    const prosperoIndex = levels.indexOf(preferences.readingLevel);

    // Allow Prospero's assessment to go lower (easier prose) without limit,
    // but only one level higher than age baseline
    if (prosperoIndex <= baselineIndex + 1) {
      return preferences.readingLevel;
    }
    return levels[Math.min(baselineIndex + 1, levels.length - 1)];
  }

  return baseline;
}

describe('Reading Level Calculation', () => {
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  describe('Age-based baseline (no Prospero suggestion)', () => {
    test('10-year-old with no preferences gets middle_grade', () => {
      const birthYear = currentYear - 10;
      const birthMonth = 1; // Past month (January) - ensures they're already 10
      const level = computeReadingLevel(birthMonth, birthYear, {});
      expect(level).toBe('middle_grade');
    });

    test('12-year-old with no preferences gets upper_middle_grade', () => {
      const birthYear = currentYear - 12;
      const birthMonth = 1; // Past month
      const level = computeReadingLevel(birthMonth, birthYear, {});
      expect(level).toBe('upper_middle_grade');
    });

    test('14-year-old with no preferences gets young_adult', () => {
      const birthYear = currentYear - 14;
      const birthMonth = 1;
      const level = computeReadingLevel(birthMonth, birthYear, {});
      expect(level).toBe('young_adult');
    });

    test('18-year-old with no preferences gets new_adult', () => {
      const birthYear = currentYear - 18;
      const birthMonth = 1;
      const level = computeReadingLevel(birthMonth, birthYear, {});
      expect(level).toBe('new_adult');
    });

    test('25-year-old with no preferences gets adult', () => {
      const birthYear = currentYear - 25;
      const birthMonth = 1;
      const level = computeReadingLevel(birthMonth, birthYear, {});
      expect(level).toBe('adult');
    });

    test('8-year-old with no preferences gets early_reader', () => {
      const birthYear = currentYear - 8;
      const birthMonth = 1;
      const level = computeReadingLevel(birthMonth, birthYear, {});
      expect(level).toBe('early_reader');
    });
  });

  describe('Prospero assessment with age cap', () => {
    test('10-year-old who loves Hunger Games gets upper_middle_grade (not young_adult)', () => {
      const birthYear = currentYear - 10;
      const birthMonth = 1;
      const level = computeReadingLevel(birthMonth, birthYear, {
        readingLevel: 'young_adult' // Prospero suggested YA
      });
      // Age baseline is middle_grade, can go +1 to upper_middle_grade, but not +2 to young_adult
      expect(level).toBe('upper_middle_grade');
    });

    test('10-year-old who loves Percy Jackson gets middle_grade', () => {
      const birthYear = currentYear - 10;
      const birthMonth = 1;
      const level = computeReadingLevel(birthMonth, birthYear, {
        readingLevel: 'middle_grade' // Prospero suggested middle_grade
      });
      expect(level).toBe('middle_grade');
    });

    test('10-year-old who loves Wimpy Kid can get early_reader (downward movement allowed)', () => {
      const birthYear = currentYear - 10;
      const birthMonth = 1;
      const level = computeReadingLevel(birthMonth, birthYear, {
        readingLevel: 'early_reader' // Prospero suggested early reader
      });
      // Downward movement is allowed without limit
      expect(level).toBe('early_reader');
    });

    test('14-year-old who loves Six of Crows gets young_adult', () => {
      const birthYear = currentYear - 14;
      const birthMonth = 1;
      const level = computeReadingLevel(birthMonth, birthYear, {
        readingLevel: 'young_adult'
      });
      // Age baseline is young_adult, Prospero matched it
      expect(level).toBe('young_adult');
    });

    test('12-year-old who loves early Harry Potter gets upper_middle_grade', () => {
      const birthYear = currentYear - 12;
      const birthMonth = 1;
      const level = computeReadingLevel(birthMonth, birthYear, {
        readingLevel: 'upper_middle_grade'
      });
      // Age baseline is upper_middle_grade, Prospero matched it
      expect(level).toBe('upper_middle_grade');
    });

    test('25-year-old can get adult regardless of Prospero suggestion', () => {
      const birthYear = currentYear - 25;
      const birthMonth = 1;
      const level = computeReadingLevel(birthMonth, birthYear, {
        readingLevel: 'adult'
      });
      expect(level).toBe('adult');
    });

    test('17-year-old turning 18 soon gets young_adult', () => {
      const birthYear = currentYear - 18;
      const birthMonth = currentMonth === 12 ? 1 : currentMonth + 1; // Birthday hasn't happened yet
      const level = computeReadingLevel(birthMonth, birthYear, {});
      expect(level).toBe('young_adult'); // Conservative: still 17
    });
  });

  describe('Edge cases', () => {
    test('Missing DOB defaults to adult', () => {
      const level = computeReadingLevel(null, null, {});
      expect(level).toBe('adult');
    });

    test('Missing DOB with Prospero suggestion uses suggestion', () => {
      const level = computeReadingLevel(null, null, {
        readingLevel: 'middle_grade'
      });
      expect(level).toBe('middle_grade');
    });

    test('Prospero can suggest one level above baseline', () => {
      const birthYear = currentYear - 10; // middle_grade baseline
      const birthMonth = 1;
      const level = computeReadingLevel(birthMonth, birthYear, {
        readingLevel: 'upper_middle_grade' // +1 level
      });
      expect(level).toBe('upper_middle_grade');
    });

    test('Prospero cannot suggest two levels above baseline', () => {
      const birthYear = currentYear - 10; // middle_grade baseline
      const birthMonth = 1;
      const level = computeReadingLevel(birthMonth, birthYear, {
        readingLevel: 'young_adult' // +2 levels
      });
      expect(level).toBe('upper_middle_grade'); // Capped at +1
    });
  });
});
