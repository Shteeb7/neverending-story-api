/**
 * Simplified test for three-tier premise generation
 * Only loads what's needed to avoid missing env vars
 */

const { createClient } = require('@supabase/supabase-js');
const { Anthropic } = require('@anthropic-ai/sdk');

const STEVEN_USER_ID = 'a3f8818e-2ffe-4d61-bfbe-7f96d1d78a7b';

// Initialize only what we need
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

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

    // Step 3: Check latest premise set
    console.log('🔍 Step 3: Checking latest premise set...');
    const { data: latestPremises, error: premisesError } = await supabaseAdmin
      .from('story_premises')
      .select('*')
      .eq('user_id', STEVEN_USER_ID)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (premisesError) {
      console.log('⚠️ Could not fetch premises:', premisesError.message);
    } else if (latestPremises && latestPremises.premises) {
      console.log('✅ Latest premise set found:');
      console.log(`   Generated: ${latestPremises.generated_at}`);
      console.log('');

      latestPremises.premises.forEach((premise, i) => {
        console.log(`${i + 1}. 🎯 ${premise.tier?.toUpperCase() || 'UNKNOWN TIER'}: "${premise.title}"`);
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

      // Validation
      const tiers = latestPremises.premises.map(p => p.tier);
      const hasTiers = ['comfort', 'stretch', 'wildcard'].every(t => tiers.includes(t));
      console.log(`${hasTiers ? '✅' : '❌'} All three tiers present: ${tiers.join(', ')}`);

      const titles = latestPremises.premises.map(p => p.title);
      const uniqueTitles = new Set(titles).size === 3;
      console.log(`${uniqueTitles ? '✅' : '❌'} All titles are unique`);

      const genres = latestPremises.premises.map(p => p.genre);
      const genreSet = new Set(genres.map(g => g?.toLowerCase()));
      console.log(`${genreSet.size > 1 ? '✅' : '⚠️'} Genre diversity: ${genreSet.size}/3 distinct genres`);

      const previousTitles = (stories || []).map(s => s.title).filter(Boolean);
      const repeatedTitles = titles.filter(t => previousTitles.includes(t));
      const noRepetition = repeatedTitles.length === 0;
      console.log(`${noRepetition ? '✅' : '❌'} No title repetition from history`);
    } else {
      console.log('⚠️ No premises found yet. Generate some first via:');
      console.log('   POST /onboarding/generate-premises');
    }

    console.log('\n✨ Test complete!\n');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the test
testThreeTierPremises();
