/**
 * Gate 4B - Step 2: Trigger Sequel Generation
 * Run sequentially to avoid 529 overload
 */

require('dotenv').config();
const { supabaseAdmin } = require('./src/config/supabase');
const {
  generateSeriesName,
  extractBookContext,
  generateSequelBible,
  generateArcOutline,
  orchestratePreGeneration
} = require('./src/services/generation');

const stories = [
  {
    name: 'Luna',
    userId: 'e4397f35-2176-4f2a-b98b-e6888ad9d5ae',
    storyId: '1cbcc943-d15e-47c7-9c4b-d1964d609e4d',
    preferences: {
      sequelDesires: 'New places, bigger challenge, more dragon scenes, more world-building',
      satisfactionSignal: 'loved_it'
    }
  },
  {
    name: 'Tyler',
    userId: '36b60171-0450-4100-a6cc-b75a1f6937c2',
    storyId: '0fdb7f93-c136-4f83-8ab2-4d8ebcea91c4',
    preferences: {
      sequelDesires: 'New respawn mechanics, new zones, bigger raids, Marco gets better at gaming, more Zara',
      satisfactionSignal: 'loved_it'
    }
  }
];

async function generateSequel(storyId, userId, userPreferences, storyName) {
  try {
    console.log(`\n📖 [${storyName}] Starting sequel generation...`);

    // Verify story is complete
    const { data: book1Story } = await supabaseAdmin
      .from('stories')
      .select('*')
      .eq('id', storyId)
      .single();

    if (!book1Story) {
      throw new Error('Book 1 story not found');
    }

    // Check chapter count
    const { data: chapters } = await supabaseAdmin
      .from('chapters')
      .select('chapter_number')
      .eq('story_id', storyId);

    const chapterCount = new Set(chapters?.map(c => c.chapter_number)).size;

    if (chapterCount < 12) {
      throw new Error(`Book 1 incomplete: ${chapterCount}/12 chapters`);
    }

    console.log(`✅ [${storyName}] Book 1 verified: 12 chapters complete`);

    // Generate or get series_id
    let seriesId = book1Story.series_id;

    if (!seriesId) {
      console.log(`📚 [${storyName}] Creating series...`);

      const { data: book1Bible } = await supabaseAdmin
        .from('story_bibles')
        .select('title, themes, central_conflict, key_locations, characters')
        .eq('story_id', storyId)
        .maybeSingle();

      const seriesName = await generateSeriesName(book1Story.title, book1Story.genre, book1Bible);
      console.log(`📚 [${storyName}] Series name: "${seriesName}"`);

      const { data: seriesRecord } = await supabaseAdmin
        .from('series')
        .insert({
          name: seriesName,
          user_id: userId
        })
        .select()
        .single();

      seriesId = seriesRecord.id;

      await supabaseAdmin
        .from('stories')
        .update({ series_id: seriesId, book_number: 1 })
        .eq('id', storyId);

      console.log(`✅ [${storyName}] Series created: ${seriesId}`);
    } else {
      console.log(`✅ [${storyName}] Using existing series: ${seriesId}`);
    }

    // Extract Book 1 context
    console.log(`📊 [${storyName}] Extracting Book 1 context...`);
    const { data: storedContext } = await supabaseAdmin
      .from('story_series_context')
      .select('*')
      .eq('series_id', seriesId)
      .eq('book_number', 1)
      .maybeSingle();

    let book1Context;
    if (storedContext) {
      console.log(`✅ [${storyName}] Using stored Book 1 context`);
      book1Context = storedContext;
    } else {
      book1Context = await extractBookContext(storyId, userId);

      const { data: book1Bible } = await supabaseAdmin
        .from('story_bibles')
        .select('id')
        .eq('story_id', storyId)
        .single();

      await supabaseAdmin
        .from('story_series_context')
        .insert({
          series_id: seriesId,
          book_number: 1,
          bible_id: book1Bible.id,
          character_states: book1Context.character_states,
          world_state: book1Context.world_state,
          relationships: book1Context.relationships,
          accomplishments: book1Context.accomplishments,
          key_events: book1Context.key_events,
          reader_preferences: userPreferences || {}
        });

      console.log(`✅ [${storyName}] Book 1 context extracted and stored`);
    }

    // Generate Book 2 bible (with retry for malformed JSON)
    console.log(`📚 [${storyName}] Generating Book 2 bible...`);
    let book2BibleContent;
    let retries = 0;
    const maxRetries = 3;

    while (retries < maxRetries) {
      try {
        book2BibleContent = await generateSequelBible(storyId, userPreferences, userId);
        console.log(`✅ [${storyName}] Book 2 bible: "${book2BibleContent.title}"`);
        break;
      } catch (error) {
        retries++;
        if (retries >= maxRetries) {
          throw new Error(`Book 2 bible generation failed after ${maxRetries} attempts: ${error.message}`);
        }
        console.log(`⚠️ [${storyName}] Bible generation attempt ${retries} failed (${error.message}), retrying...`);
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s between retries
      }
    }

    // Create Book 2 story record
    const { data: book2Story } = await supabaseAdmin
      .from('stories')
      .insert({
        user_id: userId,
        series_id: seriesId,
        book_number: 2,
        parent_story_id: storyId,
        title: book2BibleContent.title,
        genre: book1Story.genre,
        premise_tier: book1Story.premise_tier,
        status: 'generating',
        generation_progress: {
          bible_complete: false,
          arc_complete: false,
          chapters_generated: 0,
          current_step: 'generating_bible'
        }
      })
      .select()
      .single();

    const book2StoryId = book2Story.id;
    console.log(`✅ [${storyName}] Book 2 story created: ${book2StoryId}`);

    // Store Book 2 bible (content field is required, plus individual fields for querying)
    const { error: bibleInsertError } = await supabaseAdmin
      .from('story_bibles')
      .insert({
        story_id: book2StoryId,
        user_id: userId,
        content: book2BibleContent,  // Required NOT NULL field - stores full bible
        title: book2BibleContent.title,
        world_rules: book2BibleContent.world_rules,
        characters: book2BibleContent.characters,
        central_conflict: book2BibleContent.central_conflict,
        stakes: book2BibleContent.stakes,
        themes: book2BibleContent.themes,
        key_locations: book2BibleContent.key_locations,
        timeline: book2BibleContent.timeline
      });

    if (bibleInsertError) {
      throw new Error(`Failed to insert Book 2 bible: ${bibleInsertError.message}`);
    }

    await supabaseAdmin
      .from('stories')
      .update({
        generation_progress: {
          ...book2Story.generation_progress,
          bible_complete: true,
          current_step: 'generating_arc'
        }
      })
      .eq('id', book2StoryId);

    console.log(`✅ [${storyName}] Book 2 bible stored`);

    // Generate Book 2 arc
    console.log(`📖 [${storyName}] Generating Book 2 arc...`);
    await generateArcOutline(book2StoryId, userId);
    console.log(`✅ [${storyName}] Book 2 arc complete`);

    await supabaseAdmin
      .from('stories')
      .update({
        generation_progress: {
          bible_complete: true,
          arc_complete: true,
          chapters_generated: 0,
          current_step: 'generating_chapter_1'
        }
      })
      .eq('id', book2StoryId);

    // Generate chapters 1-3
    console.log(`📖 [${storyName}] Generating chapters 1-3...`);
    await orchestratePreGeneration(book2StoryId, userId);
    console.log(`✅ [${storyName}] Book 2 chapters 1-3 complete`);

    console.log(`\n🎉 [${storyName}] SEQUEL GENERATION COMPLETE`);
    console.log(`   Book 2 ID: ${book2StoryId}`);
    console.log(`   Title: ${book2BibleContent.title}`);
    console.log(`   Series ID: ${seriesId}\n`);

    return book2StoryId;

  } catch (error) {
    console.error(`\n❌ [${storyName}] Sequel generation failed:`, error.message);
    throw error;
  }
}

async function main() {
  console.log('🚀 Gate 4B - Step 2: Trigger Sequel Generation\n');
  console.log('Running sequentially to avoid 529 overload...\n');

  for (const story of stories) {
    await generateSequel(story.storyId, story.userId, story.preferences, story.name);

    // Wait between stories to avoid overload
    if (story !== stories[stories.length - 1]) {
      console.log('⏳ Waiting 30 seconds before next story...');
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  }

  console.log('\n✅ All sequels triggered successfully!');
  process.exit(0);
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
