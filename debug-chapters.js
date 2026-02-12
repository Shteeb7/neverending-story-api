require('dotenv').config();
const { supabaseAdmin } = require('./src/config/supabase');

async function debugChapters() {
  console.log('🔍 Checking for chapters in database...\n');

  // Get all stories
  const { data: stories, error: storiesError } = await supabaseAdmin
    .from('stories')
    .select('id, user_id, title, status, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  if (storiesError) {
    console.error('❌ Error fetching stories:', storiesError);
    return;
  }

  console.log(`Found ${stories.length} recent stories:\n`);

  for (const story of stories) {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📖 "${story.title}" (${story.status})`);
    console.log(`   Story ID: ${story.id}`);
    console.log(`   User ID: ${story.user_id}`);
    console.log(`   Created: ${story.created_at}`);

    // Check for arc
    const { data: arcs, error: arcsError } = await supabaseAdmin
      .from('story_arcs')
      .select('id, created_at')
      .eq('story_id', story.id);

    if (arcsError) {
      console.error('   ❌ Arc error:', arcsError.message);
    } else if (arcs.length === 0) {
      console.log('   ⚠️  NO ARC - chapters cannot exist without arc_id FK!');
    } else {
      console.log(`   ✅ Arc exists: ${arcs[0].id}`);
    }

    // Check for chapters
    const { data: chapters, error: chaptersError } = await supabaseAdmin
      .from('chapters')
      .select('chapter_number, title, arc_id, created_at')
      .eq('story_id', story.id)
      .order('chapter_number', { ascending: true });

    if (chaptersError) {
      console.error('   ❌ Chapters error:', chaptersError.message);
    } else if (chapters.length === 0) {
      console.log('   ⚠️  NO CHAPTERS in database');
    } else {
      console.log(`   📚 ${chapters.length} chapters:`);
      chapters.forEach(ch => {
        console.log(`      Ch${ch.chapter_number}: "${ch.title}" (arc: ${ch.arc_id?.substring(0, 8)}...)`);
      });
    }
    console.log('');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

debugChapters()
  .then(() => {
    console.log('✅ Done');
    process.exit(0);
  })
  .catch(err => {
    console.error('💥 Fatal error:', err);
    process.exit(1);
  });
