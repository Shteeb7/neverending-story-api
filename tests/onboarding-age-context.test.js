const { supabaseAdmin } = require('../src/config/supabase');
const prospero = require('../src/config/prospero');

describe('Onboarding Age Context', () => {
  let testUserId;
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  beforeAll(async () => {
    // Create a test user with birth_year set
    const testEmail = `test-age-context-${Date.now()}@test.com`;

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: testEmail,
      password: 'TestPassword123!',
      email_confirm: true
    });

    if (authError) throw authError;
    testUserId = authData.user.id;

    // Insert user preferences with birth year
    const birthYear = currentYear - 15; // 15-year-old
    const birthMonth = currentMonth + 1; // Next month (so they're still 14 until next month)

    await supabaseAdmin
      .from('user_preferences')
      .insert({
        user_id: testUserId,
        birth_year: birthYear,
        birth_month: birthMonth,
        is_minor: true
      });
  });

  afterAll(async () => {
    // Clean up test user
    if (testUserId) {
      await supabaseAdmin
        .from('user_preferences')
        .delete()
        .eq('user_id', testUserId);

      await supabaseAdmin.auth.admin.deleteUser(testUserId);
    }
  });

  test('Age context is enriched and included in onboarding prompt', async () => {
    // Fetch user preferences (simulating what chat.js does)
    const { data: prefs } = await supabaseAdmin
      .from('user_preferences')
      .select('birth_year, birth_month, is_minor')
      .eq('user_id', testUserId)
      .maybeSingle();

    expect(prefs).not.toBeNull();
    expect(prefs.birth_year).toBeDefined();

    // Calculate age (same logic as in chat.js)
    const now = new Date();
    let age = now.getFullYear() - prefs.birth_year;
    if (prefs.birth_month && now.getMonth() + 1 < prefs.birth_month) age--;

    // Build enriched context
    const enrichedContext = {
      readerAge: age,
      isMinor: prefs.is_minor || false
    };

    // Assemble the prompt with the enriched context
    const prompt = prospero.assemblePrompt('onboarding', 'text', enrichedContext);

    // Verify the age context is present in the prompt
    expect(prompt).toContain(`Age: ${age} years old`);
    expect(prompt).toContain('Minor: YES — all content must be age-appropriate');
    expect(prompt).toContain('Calibrate your delivery:');
    expect(prompt).toContain('Ages 13-15: Slightly more sophisticated but still warm');
  });

  test('Onboarding prompt handles missing age gracefully', () => {
    // Context without age data
    const emptyContext = {};

    // Assemble the prompt with empty context
    const prompt = prospero.assemblePrompt('onboarding', 'text', emptyContext);

    // Should still work, but show "unknown" age
    expect(prompt).toContain('Age: unknown years old');
    expect(prompt).toContain('Minor: No');
    expect(prompt).toContain('If age is unknown: Infer from the book titles they mention');
  });

  test('Age calculation accounts for birth month', async () => {
    // Fetch preferences
    const { data: prefs } = await supabaseAdmin
      .from('user_preferences')
      .select('birth_year, birth_month')
      .eq('user_id', testUserId)
      .maybeSingle();

    const now = new Date();
    let age = now.getFullYear() - prefs.birth_year;

    // If birth month hasn't passed yet this year, they're still the previous age
    if (prefs.birth_month && now.getMonth() + 1 < prefs.birth_month) {
      age--;
    }

    // Since we set birth_month to next month, age should be reduced by 1
    const expectedAge = currentYear - prefs.birth_year - 1;
    expect(age).toBe(expectedAge);
  });
});
