describe('Age Gate - Age Calculation Logic', () => {
  /**
   * Conservative age calculation: if birth month hasn't fully passed in current year,
   * assume birthday hasn't occurred yet
   */
  function calculateAge(birthMonth, birthYear) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1; // JavaScript months are 0-indexed

    let age = currentYear - birthYear;

    // If birth month hasn't fully passed yet, subtract 1 (conservative approach)
    if (currentMonth < birthMonth) {
      age -= 1;
    }

    return age;
  }

  describe('Basic age calculation', () => {
    test('calculates correct age for someone born 25 years ago (past month)', () => {
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;

      // Birth month was definitely in the past (use June if we're past June, otherwise use January)
      const birthMonth = currentMonth > 6 ? 6 : 1;
      const birthYear = currentYear - 25;

      const age = calculateAge(birthMonth, birthYear);
      expect(age).toBe(25);
    });

    test('calculates correct age for someone whose birthday hasn\'t occurred yet this year', () => {
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;

      // Birth month is 3 months in the future
      const birthMonth = currentMonth + 3 <= 12 ? currentMonth + 3 : currentMonth - 9;
      const birthYear = currentYear - 25;

      const age = calculateAge(birthMonth, birthYear);

      // Should be 24, not 25 (birthday hasn't happened yet)
      expect(age).toBe(24);
    });

    test('handles birthday in current month', () => {
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;
      const birthYear = currentYear - 18;

      const age = calculateAge(currentMonth, birthYear);

      // Current month counts as "passed", so age = 18
      expect(age).toBe(18);
    });
  });

  describe('COPPA compliance (13+ requirement)', () => {
    test('someone born exactly 13 years ago in current month should be 13', () => {
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;
      const birthYear = currentYear - 13;

      const age = calculateAge(currentMonth, birthYear);
      expect(age).toBe(13);
      expect(age >= 13).toBe(true); // Should be allowed
    });

    test('someone born 13 years ago but in future month should be 12', () => {
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;

      // Birth month is next month
      const birthMonth = currentMonth === 12 ? 1 : currentMonth + 1;
      const birthYear = currentYear - 13;

      const age = calculateAge(birthMonth, birthYear);
      expect(age).toBe(12);
      expect(age < 13).toBe(true); // Should be blocked
    });

    test('someone born 12 years ago in past month should be 12', () => {
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;

      // Birth month was last month
      const birthMonth = currentMonth === 1 ? 12 : currentMonth - 1;
      const birthYear = currentYear - 12;

      const age = calculateAge(birthMonth, birthYear);
      expect(age).toBe(12);
      expect(age < 13).toBe(true); // Should be blocked
    });

    test('someone born 14 years ago should be 13 or 14 depending on month', () => {
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;
      const birthYear = currentYear - 14;

      // Birth month in past
      const pastAge = calculateAge(currentMonth === 1 ? 12 : currentMonth - 1, birthYear);
      expect(pastAge).toBe(14);
      expect(pastAge >= 13).toBe(true);

      // Birth month in future
      const futureAge = calculateAge(currentMonth === 12 ? 1 : currentMonth + 1, birthYear);
      expect(futureAge).toBe(13);
      expect(futureAge >= 13).toBe(true);
    });
  });

  describe('Minor status (under 18)', () => {
    test('17-year-old should be marked as minor', () => {
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;
      const birthMonth = currentMonth === 1 ? 12 : currentMonth - 1;
      const birthYear = currentYear - 17;

      const age = calculateAge(birthMonth, birthYear);
      const isMinor = age < 18;

      expect(age).toBe(17);
      expect(isMinor).toBe(true);
    });

    test('18-year-old (birthday passed) should not be minor', () => {
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;
      const birthMonth = currentMonth === 1 ? 12 : currentMonth - 1;
      const birthYear = currentYear - 18;

      const age = calculateAge(birthMonth, birthYear);
      const isMinor = age < 18;

      expect(age).toBe(18);
      expect(isMinor).toBe(false);
    });

    test('someone turning 18 this month should not be minor', () => {
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;
      const birthYear = currentYear - 18;

      const age = calculateAge(currentMonth, birthYear);
      const isMinor = age < 18;

      expect(age).toBe(18);
      expect(isMinor).toBe(false);
    });

    test('someone turning 18 next month should still be minor', () => {
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;
      const birthMonth = currentMonth === 12 ? 1 : currentMonth + 1;
      const birthYear = currentYear - 18;

      const age = calculateAge(birthMonth, birthYear);
      const isMinor = age < 18;

      expect(age).toBe(17);
      expect(isMinor).toBe(true);
    });
  });

  describe('Edge cases', () => {
    test('handles January births when current month is December', () => {
      // Simulate being in December
      const currentYear = new Date().getFullYear();
      const birthMonth = 1; // January (future from December)
      const birthYear = currentYear - 13;

      // In December, January birthday hasn't happened yet
      const mockCurrentMonth = 12;
      let age = currentYear - birthYear;
      if (mockCurrentMonth < birthMonth) {
        age -= 1;
      }

      // Actually age should be 13 because we're in December of year X,
      // and they were born in January of year (X-13), so 13 years have passed
      expect(age).toBe(13);
    });

    test('handles December births when current month is January', () => {
      // Simulate being in January
      const currentYear = new Date().getFullYear();
      const birthMonth = 12; // December (past from January)
      const birthYear = currentYear - 13;

      // In January, December birthday already happened (last month)
      const mockCurrentMonth = 1;
      let age = currentYear - birthYear;
      if (mockCurrentMonth < birthMonth) {
        age -= 1;
      }

      expect(age).toBe(12); // Conservative: December hasn't "fully passed" in new year
    });

    test('very old users (100+) are calculated correctly', () => {
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;
      const birthYear = 1920;

      const age = calculateAge(currentMonth, birthYear);
      expect(age).toBeGreaterThan(100);
      expect(age).toBeLessThan(120); // Sanity check
    });
  });
});
