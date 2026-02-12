require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

async function checkStoryData(userId) {
  console.log('🔍 Checking story data for user:', userId);

  // Get all stories for user
  const { data: stories, error: storiesError } = await supabase
    .from('stories')
    .select('*')
    .eq('user_id', userId);

  if (storiesError) {
    console.error('❌ Error fetching stories:', storiesError);
    return;
  }

  console.log(`\n📚 Found ${stories.length} stories:\n`);

  for (const story of stories) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📖 Story: "${story.title}"`);
    console.log(`   ID: ${story.id}`);
    console.log(`   Status: ${story.status}`);
    console.log(`   Created: ${story.created_at}`);

    // Check for arc
    const { data: arcs, error: arcsError } = await supabase
      .from('story_arcs')
      .select('*')
      .eq('story_id', story.id);

    if (arcsError) {
      console.error('   ❌ Error fetching arcs:', arcsError);
    } else {
      console.log(`   📐 Arcs: ${arcs.length}`);
      if (arcs.length > 0) {
        console.log(`      Arc ID: ${arcs[0].id}`);
      }
    }

    // Check for chapters
    const { data: chapters, error: chaptersError } = await supabase
      .from('chapters')
      .select('chapter_number, title, word_count')
      .eq('story_id', story.id)
      .order('chapter_number', { ascending: true });

    if (chaptersError) {
      console.error('   ❌ Error fetching chapters:', chaptersError);
    } else {
      console.log(`   📚 Chapters: ${chapters.length}`);
      if (chapters.length > 0) {
        console.log('   Chapter list:');
        chapters.forEach(ch => {
          console.log(`      ${ch.chapter_number}. "${ch.title}" (${ch.word_count} words)`);
        });
      } else {
        console.log('   ⚠️  NO CHAPTERS FOUND IN DATABASE');
      }
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// Get user ID from command line or use default
const userId = process.argv[2];

if (!userId) {
  console.error('❌ Please provide a user ID as argument');
  console.error('Usage: node check-story-data.js <userId>');
  process.exit(1);
}

checkStoryData(userId)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
