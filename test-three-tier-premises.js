/**
 * Test script for three-tier premise generation (Comfort/Stretch/Wildcard)
 * Tests the new generatePremises() implementation
 */

const { generatePremises } = require('./src/services/generation');
const { supabaseAdmin } = require('./src/config/supabase');

const STEVEN_USER_ID = 'a3f8818e-2ffe-4d61-bfbe-7f96d1d78a7b';

async function testThreeTierPremises() {
  console.log('🧪 Testing Three-Tier Premise Generation Framework');
  console.log('═══════════════════════════════════════════════════\n');

  try {
    // Step 1: Fetch Steven's current preferences
    console.log('📊 Step 1: Fetching user preferences...');
    const { data: userPrefs, error: prefsError } = await supabaseAdmin
      .from('user_preferences')
      .select('*')
      .eq('user_id', STEVEN_USER_ID)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (prefsError || !userPrefs) {
      console.log('❌ No preferences found for user');
      console.log('   Error:', prefsError?.message);
      process.exit(1);
    }

    console.log('✅ Preferences loaded:');
    console.log(`   Name: ${userPrefs.preferences?.name || 'Unknown'}`);
    console.log(`   Genres: ${userPrefs.preferences?.genres?.join(', ') || 'None'}`);
    console.log(`   Themes: ${userPrefs.preferences?.themes?.join(', ') || 'None'}`);
    console.log(`   Mood: ${userPrefs.preferences?.mood || 'varied'}`);
    console.log(`   Discovery Tolerance: ${userPrefs.discovery_tolerance || 0.5}`);
    console.log(`   Emotional Drivers: ${userPrefs.preferences?.emotionalDrivers?.join(', ') || 'Not set'}`);
    console.log('');

    // Step 2: Fetch reading history
    console.log('📚 Step 2: Fetching reading history...');
    const { data: stories, error: storiesError } = await supabaseAdmin
      .from('stories')
      .select('title, genre, premise_tier')
      .eq('user_id', STEVEN_USER_ID)
      .order('created_at', { ascending: false })
      .limit(20);

    if (storiesError) {
      console.log('⚠️ Could not fetch stories:', storiesError.message);
    } else {
      console.log(`✅ Found ${stories?.length || 0} previous stories`);
      if (stories && stories.length > 0) {
        stories.slice(0, 5).forEach(s => {
          console.log(`   - "${s.title}" (${s.genre || 'no genre'}, tier: ${s.premise_tier || 'not set'})`);
        });
        if (stories.length > 5) {
          console.log(`   ... and ${stories.length - 5} more`);
        }
      }
    }
    console.log('');

    // Step 3: Generate new premises
    console.log('🎨 Step 3: Generating three-tier premises...');
    console.log('   This may take 15-30 seconds...\n');

    const result = await generatePremises(STEVEN_USER_ID, userPrefs.preferences);

    console.log('✅ PREMISES GENERATED!');
    console.log('═══════════════════════════════════════════════════\n');

    // Step 4: Analyze each premise
    result.premises.forEach((premise, i) => {
      console.log(`\n${i + 1}. 🎯 ${premise.tier?.toUpperCase() || 'UNKNOWN TIER'}: "${premise.title}"`);
      console.log(`   Genre: ${premise.genre}`);
      console.log(`   Themes: ${premise.themes?.join(', ') || 'none'}`);
      console.log('   ─────────────────────────────────────────────');
      console.log(`   Description: ${premise.description}`);
      console.log('   ─────────────────────────────────────────────');
      console.log(`   Hook: ${premise.hook}`);
      console.log('');
    });

    console.log('═══════════════════════════════════════════════════');
    console.log('✅ VALIDATION CHECKS:');
    console.log('═══════════════════════════════════════════════════\n');

    // Validation checks
    const tiers = result.premises.map(p => p.tier);
    const genres = result.premises.map(p => p.genre);
    const titles = result.premises.map(p => p.title);

    // Check 1: All three tiers present
    const hasTiers = ['comfort', 'stretch', 'wildcard'].every(t => tiers.includes(t));
    console.log(`${hasTiers ? '✅' : '❌'} All three tiers present: ${tiers.join(', ')}`);

    // Check 2: All premises have unique titles
    const uniqueTitles = new Set(titles).size === 3;
    console.log(`${uniqueTitles ? '✅' : '❌'} All titles are unique`);

    // Check 3: Genres are distinct
    const genreSet = new Set(genres.map(g => g?.toLowerCase()));
    console.log(`${genreSet.size > 1 ? '✅' : '⚠️'} Genre diversity: ${genreSet.size}/3 distinct genres`);

    // Check 4: No repetition from history
    const repeatedTitles = titles.filter(t => previousTitles.includes(t));
    const noRepetition = repeatedTitles.length === 0;
    console.log(`${noRepetition ? '✅' : '❌'} No title repetition from history`);
    if (!noRepetition) {
      console.log(`   Repeated: ${repeatedTitles.join(', ')}`);
    }

    // Check 5: Tier alignment check (manual review prompt)
    console.log('\n📝 MANUAL REVIEW REQUIRED:');
    console.log('   Review the premises above and verify:');
    console.log('   - COMFORT feels like a direct preference match');
    console.log('   - STRETCH combines profile elements unexpectedly');
    console.log('   - WILDCARD surprises based on emotional drivers\n');

    console.log('═══════════════════════════════════════════════════');
    console.log('📊 PREMISE SET STORED IN DATABASE');
    console.log(`   Premises ID: ${result.premisesId}`);
    console.log('═══════════════════════════════════════════════════\n');

    console.log('✨ Test complete!\n');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the test
testThreeTierPremises();
