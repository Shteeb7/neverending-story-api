require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { generateBookCover } = require('../src/services/cover-generation');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function backfillCovers() {
  console.log('🎨 Starting book cover backfill...\n');

  // Query all stories without covers, joining to story_bibles
  const { data: stories, error } = await supabase
    .from('stories')
    .select(`
      id,
      title,
      user_id,
      story_bibles (
        title,
        themes,
        central_conflict
      )
    `)
    .is('cover_image_url', null)
    .neq('status', 'abandoned');

  if (error) {
    console.error('❌ Failed to query stories:', error);
    process.exit(1);
  }

  if (!stories || stories.length === 0) {
    console.log('✅ No stories need cover backfill!');
    return;
  }

  console.log(`📊 Found ${stories.length} stories without covers\n`);

  let successCount = 0;
  let failureCount = 0;
  const failures = [];

  for (let i = 0; i < stories.length; i++) {
    const story = stories[i];
    const storyNumber = i + 1;

    try {
      // Get user preferences for author name
      const { data: userPrefs } = await supabase
        .from('user_preferences')
        .select('preferences')
        .eq('user_id', story.user_id)
        .single();

      const authorName = userPrefs?.preferences?.name || 'Reader';

      // Get story details from bible (it's an array in Supabase joins)
      const bible = story.story_bibles?.[0];
      const title = bible?.title || story.title || 'Untitled Story';
      const themes = bible?.themes || [];
      const description = bible?.central_conflict?.description || '';

      // Infer genre from themes or use generic 'fiction'
      const genre = themes.length > 0 ? themes.slice(0, 3).join(', ') : 'fiction';

      console.log(`[${storyNumber}/${stories.length}] Generating cover for "${title}" by ${authorName}...`);

      const storyDetails = {
        title,
        genre,
        themes,
        description
      };

      // Generate the cover
      await generateBookCover(story.id, storyDetails, authorName);

      console.log(`✅ Done\n`);
      successCount++;

    } catch (err) {
      console.error(`❌ Failed: ${err.message}\n`);
      failureCount++;
      failures.push({ title: story.title || story.id, error: err.message });
    }

    // Rate limiting: wait 5 seconds between API calls (except after the last one)
    if (i < stories.length - 1) {
      console.log('⏳ Waiting 5 seconds before next request...\n');
      await sleep(5000);
    }
  }

  // Summary
  console.log('\n========================================');
  console.log('📊 BACKFILL COMPLETE');
  console.log('========================================');
  console.log(`✅ Generated ${successCount}/${stories.length} covers`);
  console.log(`❌ Failures: ${failureCount}`);

  if (failures.length > 0) {
    console.log('\n❌ Failed stories:');
    failures.forEach(f => {
      console.log(`  - "${f.title}": ${f.error}`);
    });
  }
}

// Run the backfill
backfillCovers()
  .then(() => {
    console.log('\n✨ Backfill script finished');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n💥 Fatal error:', err);
    process.exit(1);
  });
