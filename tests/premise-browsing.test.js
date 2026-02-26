const { supabaseAdmin } = require('../src/config/supabase');
const { generatePremises } = require('../src/services/generation');

// Increase timeout for database operations
jest.setTimeout(60000);

describe('Premise Browsing - Show Me More', () => {
  let testUserId;
  const testPreferences = {
    genres: ['Fantasy', 'Sci-Fi'],
    themes: ['Adventure', 'Mystery'],
    mood: 'varied',
    characterTypes: 'varied',
    dislikedElements: [],
    name: 'Test Reader',
    readingLevel: 'young_adult'
  };

  beforeAll(async () => {
    // Create a test user
    const testEmail = `test-premise-browsing-${Date.now()}@test.com`;

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: testEmail,
      password: 'TestPassword123!',
      email_confirm: true
    });

    if (authError) throw authError;
    testUserId = authData.user.id;

    // Insert user preferences
    await supabaseAdmin
      .from('user_preferences')
      .insert({
        user_id: testUserId,
        preferences: testPreferences,
        reading_level: 'young_adult'
      });
  });

  afterAll(async () => {
    // Clean up test user and data
    if (testUserId) {
      // Delete premises
      await supabaseAdmin
        .from('premises')
        .delete()
        .eq('user_id', testUserId);

      // Delete preferences
      await supabaseAdmin
        .from('user_preferences')
        .delete()
        .eq('user_id', testUserId);

      // Delete user
      await supabaseAdmin.auth.admin.deleteUser(testUserId);
    }
  });

  test('generatePremises works without excludePremises (backward compatibility)', async () => {
    const result = await generatePremises(testUserId, testPreferences);

    expect(result).toHaveProperty('premises');
    expect(result).toHaveProperty('premisesId');
    expect(result.premises).toHaveLength(3);

    // Verify all required fields
    result.premises.forEach(premise => {
      expect(premise).toHaveProperty('title');
      expect(premise).toHaveProperty('description');
      expect(premise).toHaveProperty('hook');
      expect(premise).toHaveProperty('genre');
      expect(premise).toHaveProperty('themes');
      expect(premise).toHaveProperty('tier');
      expect(['comfort', 'stretch', 'wildcard']).toContain(premise.tier);
    });
  }, 30000);

  test('generatePremises with excludePremises avoids repeating titles', async () => {
    // First batch
    const firstBatch = await generatePremises(testUserId, testPreferences);
    expect(firstBatch.premises).toHaveLength(3);

    const firstTitles = firstBatch.premises.map(p => p.title);
    console.log('First batch titles:', firstTitles);

    // Second batch with excludePremises
    const excludePremises = firstBatch.premises.map(p => ({
      title: p.title,
      description: p.description,
      tier: p.tier
    }));

    const secondBatch = await generatePremises(testUserId, testPreferences, excludePremises);
    expect(secondBatch.premises).toHaveLength(3);

    const secondTitles = secondBatch.premises.map(p => p.title);
    console.log('Second batch titles:', secondTitles);

    // Verify no title repetition
    secondTitles.forEach(title => {
      expect(firstTitles).not.toContain(title);
    });
  }, 60000);

  test('generatePremises with excludePremises generates different concepts', async () => {
    // Generate first batch
    const firstBatch = await generatePremises(testUserId, testPreferences);

    const excludePremises = firstBatch.premises.map(p => ({
      title: p.title,
      description: p.description,
      tier: p.tier
    }));

    // Generate second batch
    const secondBatch = await generatePremises(testUserId, testPreferences, excludePremises);

    // Extract genre+theme combinations from both batches
    const firstCombos = firstBatch.premises.map(p => `${p.genre}-${p.themes.join('-')}`);
    const secondCombos = secondBatch.premises.map(p => `${p.genre}-${p.themes.join('-')}`);

    console.log('First batch combos:', firstCombos);
    console.log('Second batch combos:', secondCombos);

    // At least 2 out of 3 should have different genre+theme combinations
    let differentCount = 0;
    secondCombos.forEach(combo => {
      if (!firstCombos.includes(combo)) {
        differentCount++;
      }
    });

    expect(differentCount).toBeGreaterThanOrEqual(2);
  }, 120000);

  test('Multiple rounds maintain tier structure', async () => {
    // Round 1
    const round1 = await generatePremises(testUserId, testPreferences);
    const tiers1 = round1.premises.map(p => p.tier).sort();

    // Round 2 with exclusions
    const round2 = await generatePremises(
      testUserId,
      testPreferences,
      round1.premises.map(p => ({ title: p.title, description: p.description, tier: p.tier }))
    );
    const tiers2 = round2.premises.map(p => p.tier).sort();

    // Both rounds should have comfort, stretch, wildcard
    expect(tiers1).toEqual(['comfort', 'stretch', 'wildcard']);
    expect(tiers2).toEqual(['comfort', 'stretch', 'wildcard']);
  }, 120000);
});
