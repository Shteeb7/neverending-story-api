const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { anthropic } = require('../config/ai-clients');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /story/select-premise
 * User selects a premise and triggers pre-generation of first chapters
 */
router.post('/select-premise', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { premiseId, customPremise } = req.body;

  if (!premiseId && !customPremise) {
    return res.status(400).json({
      success: false,
      error: 'Either premiseId or customPremise is required'
    });
  }

  // CRITICAL: Ensure user exists in public.users (for FK constraint)
  // This handles users who signed in before the auth route fix was deployed
  console.log('🔧 Ensuring user exists in public.users before story creation...');

  // Get user email from auth.users
  const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId);

  if (!authError && authUser) {
    const { error: userUpsertError } = await supabaseAdmin
      .from('users')
      .upsert({
        id: userId,
        email: authUser.user.email,
        created_at: new Date().toISOString()
      }, {
        onConflict: 'id',
        ignoreDuplicates: false  // Update if exists
      });

    if (userUpsertError) {
      console.error('❌ Failed to ensure user exists:', userUpsertError);
      // Don't fail - try to continue anyway
    } else {
      console.log('✅ User record ensured in public.users');
    }
  } else {
    console.error('❌ Failed to fetch auth user:', authError);
  }

  // Generate story bible which creates the story record
  const { generateStoryBible, orchestratePreGeneration } = require('../services/generation');
  const { storyId } = await generateStoryBible(premiseId, userId);

  // Fetch the complete story record to return to iOS
  const { data: story, error: storyFetchError } = await supabaseAdmin
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .single();

  if (storyFetchError || !story) {
    throw new Error('Failed to fetch created story');
  }

  // Start orchestration asynchronously (non-blocking)
  orchestratePreGeneration(storyId, userId).catch(error => {
    console.error('Pre-generation failed:', error);
  });

  // Return the full story object that iOS expects
  res.json(story);
}));

/**
 * GET /story/generation-status/:storyId
 * Check the pre-generation progress
 */
router.get('/generation-status/:storyId', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;

  const { data: story, error } = await supabaseAdmin
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .eq('user_id', userId)
    .single();

  if (error || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  const { count: chapterCount } = await supabaseAdmin
    .from('chapters')
    .select('*', { count: 'exact', head: true })
    .eq('story_id', storyId);

  res.json({
    success: true,
    storyId: story.id,
    title: story.title,
    status: story.status,
    progress: story.generation_progress || {},
    chaptersAvailable: chapterCount || 0,
    error: story.error_message || null
  });
}));

/**
 * GET /story/:storyId/chapters
 * Retrieve available chapters for a story
 */
router.get('/:storyId/chapters', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;

  // Verify story belongs to user
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('id')
    .eq('id', storyId)
    .eq('user_id', userId)
    .single();

  if (storyError || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  // Fetch all chapters
  const { data: chapters, error: chaptersError } = await supabaseAdmin
    .from('chapters')
    .select('*')
    .eq('story_id', storyId)
    .order('chapter_number', { ascending: true });

  if (chaptersError) {
    throw new Error(`Failed to fetch chapters: ${chaptersError.message}`);
  }

  res.json({
    success: true,
    storyId,
    chapters: chapters || []
  });
}));

/**
 * POST /story/:storyId/generate-next
 * Generate next chapter(s) in the story
 */
router.post('/:storyId/generate-next', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;
  const { count = 1 } = req.body; // Number of chapters to generate

  // Verify story belongs to user
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .eq('user_id', userId)
    .single();

  if (storyError || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  if (story.status === 'generating') {
    return res.status(400).json({
      success: false,
      error: 'Story is still in initial generation. Please wait.'
    });
  }

  // Get current chapter count
  const { count: chapterCount } = await supabaseAdmin
    .from('chapters')
    .select('*', { count: 'exact', head: true })
    .eq('story_id', storyId);

  const nextChapterNumber = (chapterCount || 0) + 1;

  const { generateChapter } = require('../services/generation');
  const generatedChapters = [];

  for (let i = 0; i < count; i++) {
    const chapter = await generateChapter(storyId, nextChapterNumber + i, userId);
    generatedChapters.push({
      id: chapter.id,
      chapter_number: chapter.chapter_number,
      title: chapter.title,
      word_count: chapter.word_count
    });
  }

  res.json({
    success: true,
    message: `Generated ${count} chapter(s)`,
    chapters: generatedChapters
  });
}));

/**
 * POST /story/:storyId/progress
 * Update user's reading position in a story
 */
router.post('/:storyId/progress', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;
  const { chapterId, position, percentComplete } = req.body;

  const { data, error } = await supabaseAdmin
    .from('reading_progress')
    .upsert({
      user_id: userId,
      story_id: storyId,
      chapter_id: chapterId,
      position,
      percent_complete: percentComplete,
      updated_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update progress: ${error.message}`);
  }

  res.json({
    success: true,
    progress: data
  });
}));

/**
 * GET /story/:storyId/current-state
 * Get current reading state (position, available chapters, etc.)
 */
router.get('/:storyId/current-state', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;

  // Get story details
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .eq('user_id', userId)
    .single();

  if (storyError || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  // Get reading progress
  const { data: progress } = await supabaseAdmin
    .from('reading_progress')
    .select('*')
    .eq('story_id', storyId)
    .eq('user_id', userId)
    .single();

  // Get chapter count
  const { count: chapterCount } = await supabaseAdmin
    .from('chapters')
    .select('*', { count: 'exact', head: true })
    .eq('story_id', storyId);

  res.json({
    success: true,
    story,
    progress: progress || null,
    chaptersAvailable: chapterCount || 0
  });
}));

/**
 * POST /story/:storyId/generate-sequel
 * Generate the next book in a series after completing Book 1
 */
router.post('/:storyId/generate-sequel', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;
  const { userPreferences } = req.body;

  console.log(`📖 Generating sequel for story ${storyId}...`);

  // Verify story belongs to user and is complete
  const { data: book1Story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .eq('user_id', userId)
    .single();

  if (storyError || !book1Story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  // Check if chapters complete
  const { count: chapterCount } = await supabaseAdmin
    .from('chapters')
    .select('*', { count: 'exact', head: true })
    .eq('story_id', storyId);

  if (chapterCount < 12) {
    return res.status(400).json({
      success: false,
      error: 'Book 1 must be complete (12 chapters) before generating sequel'
    });
  }

  // Generate series_id if this is the first sequel
  const seriesId = book1Story.series_id || crypto.randomUUID();

  // Update Book 1 with series_id if not set
  if (!book1Story.series_id) {
    await supabaseAdmin
      .from('stories')
      .update({
        series_id: seriesId,
        book_number: 1
      })
      .eq('id', storyId);
  }

  // Extract Book 1 context if not already done
  const { extractBookContext, generateSequelBible, generateArcOutline, orchestratePreGeneration } = require('../services/generation');

  let book1Context;
  const { data: storedContext } = await supabaseAdmin
    .from('story_series_context')
    .select('*')
    .eq('series_id', seriesId)
    .eq('book_number', 1)
    .single();

  if (storedContext) {
    console.log('✅ Using stored Book 1 context');
    book1Context = storedContext;
  } else {
    console.log('📊 Extracting Book 1 context...');
    const context = await extractBookContext(storyId, userId);

    // Get bible_id for Book 1
    const { data: book1Bible } = await supabaseAdmin
      .from('story_bibles')
      .select('id')
      .eq('story_id', storyId)
      .single();

    // Store context for future use
    await supabaseAdmin
      .from('story_series_context')
      .insert({
        series_id: seriesId,
        book_number: 1,
        bible_id: book1Bible.id,
        character_states: context.character_states,
        world_state: context.world_state,
        relationships: context.relationships,
        accomplishments: context.accomplishments,
        key_events: context.key_events,
        reader_preferences: userPreferences || {}
      });

    book1Context = context;
  }

  console.log('📚 Generating Book 2 bible...');
  const book2BibleContent = await generateSequelBible(storyId, userPreferences, userId);

  // Create Book 2 story record
  const { data: book2Story, error: book2Error } = await supabaseAdmin
    .from('stories')
    .insert({
      user_id: userId,
      series_id: seriesId,
      book_number: 2,
      parent_story_id: storyId,
      title: book2BibleContent.title,
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

  if (book2Error) {
    throw new Error(`Failed to create Book 2 story: ${book2Error.message}`);
  }

  console.log(`✅ Created Book 2 story: ${book2Story.id}`);

  // Store Book 2 bible
  const { data: book2Bible, error: bibleError } = await supabaseAdmin
    .from('story_bibles')
    .insert({
      user_id: userId,
      story_id: book2Story.id,
      content: book2BibleContent,
      title: book2BibleContent.title,
      world_rules: book2BibleContent.world_rules,
      characters: book2BibleContent.characters,
      central_conflict: book2BibleContent.central_conflict,
      stakes: book2BibleContent.stakes,
      themes: book2BibleContent.themes,
      key_locations: book2BibleContent.key_locations,
      timeline: book2BibleContent.timeline
    })
    .select()
    .single();

  if (bibleError) {
    throw new Error(`Failed to store Book 2 bible: ${bibleError.message}`);
  }

  console.log('📐 Generating Book 2 arc...');
  await generateArcOutline(book2Story.id, userId);

  console.log('📝 Starting Book 2 chapter generation (1-6)...');

  // Start pre-generation in background (6 chapters)
  orchestratePreGeneration(book2Story.id, userId).catch(error => {
    console.error('Book 2 pre-generation failed:', error);
  });

  res.json({
    success: true,
    book2: book2Story,
    seriesId,
    message: 'Book 2 is being generated. Check back soon for the first chapters!'
  });
}));

module.exports = router;
