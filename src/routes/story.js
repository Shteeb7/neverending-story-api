const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { anthropic } = require('../config/ai-clients');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');
const { requireAIConsentMiddleware } = require('../middleware/consent');

const router = express.Router();

/**
 * Check if a user owns a story OR has it on their WhisperNet shelf.
 * Returns the story if access is granted, null otherwise.
 */
async function verifyStoryAccess(storyId, userId) {
  const { data: story } = await supabaseAdmin
    .from('stories')
    .select('id, user_id')
    .eq('id', storyId)
    .single();

  if (!story) return null;

  // Owner always has access
  if (story.user_id === userId) return story;

  // Check WhisperNet shelf
  const { data: shelfEntry } = await supabaseAdmin
    .from('whispernet_library')
    .select('id')
    .eq('user_id', userId)
    .eq('story_id', storyId)
    .maybeSingle();

  return shelfEntry ? story : null;
}

/**
 * POST /story/select-premise
 * User selects a premise and triggers pre-generation of first chapters
 * FAST RETURN: Creates story record and returns immediately (1-2s), then generates in background
 */
router.post('/select-premise', authenticateUser, requireAIConsentMiddleware, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { premiseId, customPremise } = req.body;

  if (!premiseId && !customPremise) {
    return res.status(400).json({
      success: false,
      error: 'Either premiseId or customPremise is required'
    });
  }

  // CRITICAL: Ensure user exists in public.users (for FK constraint)
  console.log('🔧 Ensuring user exists in public.users before story creation...');

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
        ignoreDuplicates: false
      });

    if (userUpsertError) {
      console.error('❌ Failed to ensure user exists:', userUpsertError);
    } else {
      console.log('✅ User record ensured in public.users');
    }
  } else {
    console.error('❌ Failed to fetch auth user:', authError);
  }

  // Step 1: Look up the premise to get its title (quick DB query)
  const { data: premiseRecords, error: premiseError } = await supabaseAdmin
    .from('story_premises')
    .select('id, premises')
    .eq('user_id', userId)
    .order('generated_at', { ascending: false });

  if (premiseError || !premiseRecords || premiseRecords.length === 0) {
    return res.status(404).json({ success: false, error: 'Premise not found' });
  }

  let selectedPremise = null;
  let storyPremisesRecordId = null;

  for (const record of premiseRecords) {
    if (Array.isArray(record.premises)) {
      const found = record.premises.find(p => p.id === premiseId);
      if (found) {
        selectedPremise = found;
        storyPremisesRecordId = record.id;
        break;
      }
    }
  }

  if (!selectedPremise) {
    return res.status(404).json({ success: false, error: 'Premise not found' });
  }

  // Step 2: Create story record IMMEDIATELY (prevents race condition)
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .insert({
      user_id: userId,
      premise_id: storyPremisesRecordId,
      title: selectedPremise.title,
      genre: selectedPremise.genre || null,
      premise_tier: selectedPremise.tier || null,        // NEW: Store comfort/stretch/wildcard tier
      status: 'active',
      generation_progress: {
        bible_complete: false,
        arc_complete: false,
        chapters_generated: 0,
        current_step: 'generating_bible',
        last_updated: new Date().toISOString()
      },
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  if (storyError) {
    throw new Error(`Failed to create story record: ${storyError.message}`);
  }

  console.log(`✅ Story record created immediately: ${story.id} - "${selectedPremise.title}"`);

  // Step 2.5: Update discovery tolerance based on selection (non-blocking)
  const { updateDiscoveryTolerance } = require('../services/generation');
  updateDiscoveryTolerance(userId).catch(err =>
    console.error('Discovery tolerance update failed (non-blocking):', err.message)
  );

  // Step 3: Fire entire generation pipeline async (non-blocking)
  const { generateStoryBibleForExistingStory, orchestratePreGeneration } = require('../services/generation');

  generateStoryBibleForExistingStory(story.id, premiseId, userId)
    .then(() => {
      console.log(`📚 Bible generated for story ${story.id}, starting chapter generation...`);
      return orchestratePreGeneration(story.id, userId);
    })
    .catch(error => {
      console.error(`❌ Generation pipeline failed for story ${story.id}:`, error);
      // Update story progress to indicate failure
      supabaseAdmin
        .from('stories')
        .update({
          generation_progress: {
            bible_complete: false,
            arc_complete: false,
            chapters_generated: 0,
            current_step: 'generation_failed',
            last_updated: new Date().toISOString(),
            error: error.message
          }
        })
        .eq('id', story.id)
        .then(() => console.log('Updated story with error status'));
    });

  // Step 4: Return immediately (1-2 seconds total, not 60)
  res.json(story);
}));

/**
 * GET /story/generation-status/:storyId
 * Check the pre-generation progress
 */
router.get('/generation-status/:storyId', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;

  // Allow owner OR WhisperNet shelf reader
  const story = await verifyStoryAccess(storyId, userId);
  if (!story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  // Fetch full story data
  const { data: fullStory } = await supabaseAdmin
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .single();

  // Count distinct chapter numbers (not rows) to handle any duplicates
  const { data: countData } = await supabaseAdmin
    .from('chapters')
    .select('chapter_number')
    .eq('story_id', storyId);
  const chapterCount = new Set(countData?.map(c => c.chapter_number)).size;

  res.json({
    success: true,
    storyId: fullStory.id,
    title: fullStory.title,
    status: fullStory.status,
    progress: fullStory.generation_progress || {},
    chaptersAvailable: chapterCount || 0,
    error: fullStory.error_message || null
  });
}));

/**
 * GET /story/:storyId/chapters
 * Retrieve available chapters for a story
 */
router.get('/:storyId/chapters', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;

  // Verify story belongs to user OR is on their WhisperNet shelf
  const story = await verifyStoryAccess(storyId, userId);
  if (!story) {
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

  // Deduplicate by chapter_number (keep first occurrence) - defense in depth
  const uniqueChapters = [];
  const seenChapterNumbers = new Set();
  for (const chapter of chapters) {
    if (!seenChapterNumbers.has(chapter.chapter_number)) {
      seenChapterNumbers.add(chapter.chapter_number);
      uniqueChapters.push(chapter);
    }
  }

  // Fetch synopsis from story_bibles (central_conflict description)
  let synopsis = null;
  const { data: bible } = await supabaseAdmin
    .from('story_bibles')
    .select('central_conflict')
    .eq('story_id', storyId)
    .maybeSingle();

  if (bible?.central_conflict?.description) {
    synopsis = bible.central_conflict.description;
  }

  res.json({
    success: true,
    storyId,
    chapters: uniqueChapters || [],
    synopsis
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
      error: 'Story is still being conjured. Please wait.'
    });
  }

  // Get current chapter count
  // Count distinct chapter numbers (not rows) to handle any duplicates
  const { data: countData } = await supabaseAdmin
    .from('chapters')
    .select('chapter_number')
    .eq('story_id', storyId);
  const chapterCount = new Set(countData?.map(c => c.chapter_number)).size;

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
    message: `Conjured ${count} chapter(s)`,
    chapters: generatedChapters
  });
}));

/**
 * POST /story/:storyId/progress
 * Update user's reading position in a story
 * Expects: chapterNumber (int), scrollPosition (double), paragraphIndex (int, optional)
 */
router.post('/:storyId/progress', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;
  const { chapterNumber, scrollPosition, paragraphIndex } = req.body;

  const upsertData = {
      user_id: userId,
      story_id: storyId,
      chapter_number: chapterNumber,
      scroll_position: scrollPosition,
      updated_at: new Date().toISOString()
  };

  // Include paragraph_index if provided (backward compatible)
  if (paragraphIndex != null) {
    upsertData.paragraph_index = paragraphIndex;
  }

  const { data, error} = await supabaseAdmin
    .from('reading_progress')
    .upsert(upsertData, {
      onConflict: 'user_id,story_id'
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

  // Verify access (owner or WhisperNet shelf)
  const accessCheck = await verifyStoryAccess(storyId, userId);
  if (!accessCheck) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  // Get full story details
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('*')
    .eq('id', storyId)
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
  // Count distinct chapter numbers (not rows) to handle any duplicates
  const { data: countData } = await supabaseAdmin
    .from('chapters')
    .select('chapter_number')
    .eq('story_id', storyId);
  const chapterCount = new Set(countData?.map(c => c.chapter_number)).size;

  res.json({
    success: true,
    story,
    progress: progress || null,
    chaptersAvailable: chapterCount || 0
  });
}));

/**
 * GET /:storyId/sequel
 * Get the next book in the series (if exists and has at least 1 chapter)
 */
router.get('/:storyId/sequel', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;

  // Get current story with series_id and created_at
  const { data: currentStory, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('id, series_id, created_at')
    .eq('id', storyId)
    .eq('user_id', userId)
    .single();

  if (storyError || !currentStory) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  // If not in a series, no sequel exists
  if (!currentStory.series_id) {
    return res.json({
      success: true,
      sequel: null
    });
  }

  // Find next book in series (created after current book, same series_id)
  const { data: sequelStories, error: sequelError } = await supabaseAdmin
    .from('stories')
    .select('*')
    .eq('series_id', currentStory.series_id)
    .eq('user_id', userId)
    .gt('created_at', currentStory.created_at)
    .order('created_at', { ascending: true })
    .limit(1);

  if (sequelError) {
    throw new Error(`Failed to fetch sequel: ${sequelError.message}`);
  }

  // No sequel found
  if (!sequelStories || sequelStories.length === 0) {
    return res.json({
      success: true,
      sequel: null
    });
  }

  const sequel = sequelStories[0];

  // Check if sequel has at least 1 chapter (is readable)
  const { data: chapters, error: chaptersError } = await supabaseAdmin
    .from('chapters')
    .select('id')
    .eq('story_id', sequel.id)
    .limit(1);

  if (chaptersError) {
    throw new Error(`Failed to check sequel chapters: ${chaptersError.message}`);
  }

  // If sequel has no chapters, it's not readable yet
  if (!chapters || chapters.length === 0) {
    return res.json({
      success: true,
      sequel: null
    });
  }

  // Sequel exists and is readable
  res.json({
    success: true,
    sequel
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
  // Count distinct chapter numbers (not rows) to handle any duplicates
  const { data: countData } = await supabaseAdmin
    .from('chapters')
    .select('chapter_number')
    .eq('story_id', storyId);
  const chapterCount = new Set(countData?.map(c => c.chapter_number)).size;

  if (chapterCount < 12) {
    return res.status(400).json({
      success: false,
      error: 'Book 1 must be complete (12 chapters) before conjuring a sequel'
    });
  }

  // Generate series_id and name if this is the first sequel
  let seriesId = book1Story.series_id;

  if (!seriesId) {
    // Create series record with AI-generated name
    const { generateSeriesName } = require('../services/generation');

    // Fetch Book 1 bible for series naming context
    const { data: book1Bible } = await supabaseAdmin
      .from('story_bibles')
      .select('title, themes, central_conflict, key_locations, characters')
      .eq('story_id', storyId)
      .maybeSingle();

    const seriesName = await generateSeriesName(book1Story.title, book1Story.genre, book1Bible);

    const { data: seriesRecord, error: seriesError } = await supabaseAdmin
      .from('series')
      .insert({
        name: seriesName,
        user_id: userId
      })
      .select()
      .single();

    if (seriesError) {
      throw new Error(`Failed to create series: ${seriesError.message}`);
    }

    seriesId = seriesRecord.id;

    // Update Book 1 with series_id
    await supabaseAdmin
      .from('stories')
      .update({ series_id: seriesId, book_number: 1 })
      .eq('id', storyId);

    console.log(`📚 Created series "${seriesName}" (${seriesId})`);
  }

  // Determine next book number — query actual max in series (defensive against stale/null book_number)
  const { extractBookContext, generateSequelBible, generateArcOutline, orchestratePreGeneration } = require('../services/generation');

  const { data: maxBookInSeries } = await supabaseAdmin
    .from('stories')
    .select('book_number')
    .eq('series_id', seriesId)
    .order('book_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextBookNumber = (maxBookInSeries?.book_number || 1) + 1;
  const currentBookNumber = book1Story.book_number || (nextBookNumber - 1);
  console.log(`📚 Creating Book ${nextBookNumber} sequel (predecessor is Book ${currentBookNumber}, max in series: ${maxBookInSeries?.book_number || 'none'})`);

  // Extract context from the predecessor book if not already stored
  const { data: storedPredecessorCtx } = await supabaseAdmin
    .from('story_series_context')
    .select('*')
    .eq('series_id', seriesId)
    .eq('book_number', currentBookNumber)
    .maybeSingle();

  if (storedPredecessorCtx) {
    console.log(`✅ Using stored Book ${currentBookNumber} context`);
  } else {
    console.log(`📊 Extracting Book ${currentBookNumber} context...`);
    const context = await extractBookContext(storyId, userId);

    // Get bible_id for the predecessor book
    const { data: predecessorBible } = await supabaseAdmin
      .from('story_bibles')
      .select('id')
      .eq('story_id', storyId)
      .maybeSingle();

    // Store context for future use
    await supabaseAdmin
      .from('story_series_context')
      .insert({
        series_id: seriesId,
        book_number: currentBookNumber,
        bible_id: predecessorBible?.id || null,
        character_states: context.character_states,
        world_state: context.world_state,
        relationships: context.relationships,
        accomplishments: context.accomplishments,
        key_events: context.key_events,
        reader_preferences: userPreferences || {}
      });

    console.log(`✅ Stored Book ${currentBookNumber} context for series continuity`);
  }

  console.log(`📚 Generating Book ${nextBookNumber} bible...`);
  const sequelBibleContent = await generateSequelBible(storyId, userPreferences, userId);

  // Create sequel story record (inherit genre and tier from predecessor)
  const { data: book2Story, error: book2Error } = await supabaseAdmin
    .from('stories')
    .insert({
      user_id: userId,
      series_id: seriesId,
      book_number: nextBookNumber,
      parent_story_id: storyId,
      title: sequelBibleContent.title,
      genre: book1Story.genre || null,              // Inherit genre from predecessor
      premise_tier: book1Story.premise_tier || null, // Inherit tier from predecessor (sequels continue the original choice)
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
    throw new Error(`Failed to create Book ${nextBookNumber} story: ${book2Error.message}`);
  }

  console.log(`✅ Created Book ${nextBookNumber} story: ${book2Story.id}`);

  // Store sequel bible
  const { data: book2Bible, error: bibleError } = await supabaseAdmin
    .from('story_bibles')
    .insert({
      user_id: userId,
      story_id: book2Story.id,
      content: sequelBibleContent,
      title: sequelBibleContent.title,
      world_rules: sequelBibleContent.world_rules,
      characters: sequelBibleContent.characters,
      central_conflict: sequelBibleContent.central_conflict,
      stakes: sequelBibleContent.stakes,
      themes: sequelBibleContent.themes,
      key_locations: sequelBibleContent.key_locations,
      timeline: sequelBibleContent.timeline
    })
    .select()
    .single();

  if (bibleError) {
    throw new Error(`Failed to store Book ${nextBookNumber} bible: ${bibleError.message}`);
  }

  console.log(`📐 Generating Book ${nextBookNumber} arc...`);
  await generateArcOutline(book2Story.id, userId);

  console.log(`📝 Starting Book ${nextBookNumber} chapter generation (1-3 initial batch)...`);

  // Start pre-generation in background (3 chapters)
  orchestratePreGeneration(book2Story.id, userId).catch(error => {
    console.error(`Book ${nextBookNumber} pre-generation failed:`, error);
  });

  res.json({
    success: true,
    sequel: book2Story,
    bookNumber: nextBookNumber,
    seriesId,
    message: `Book ${nextBookNumber} is being conjured. Check back soon for the first chapters!`
  });
}));

/**
 * POST /story/investigate-passage
 * Prospero's Editor: Reader highlights a passage and asks Prospero to investigate.
 * Returns Prospero's in-character response + correction if genuine issue found.
 */
router.post('/investigate-passage', authenticateUser, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { storyId, chapterId, chapterNumber, highlightedText, highlightStart, highlightEnd, readerDescription } = req.body;

  if (!storyId || !chapterId || !highlightedText || !readerDescription) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: storyId, chapterId, highlightedText, readerDescription'
    });
  }

  if (typeof highlightStart !== 'number' || typeof highlightEnd !== 'number') {
    return res.status(400).json({
      success: false,
      error: 'highlightStart and highlightEnd must be numbers'
    });
  }

  // Determine if user is the story author
  const { data: story } = await supabaseAdmin
    .from('stories')
    .select('user_id')
    .eq('id', storyId)
    .single();

  if (!story) {
    return res.status(404).json({ success: false, error: 'Story not found' });
  }

  const isAuthor = story.user_id === userId;
  const authorId = story.user_id;

  const { investigatePassage } = require('../services/prospero-editor');
  const result = await investigatePassage({
    storyId,
    chapterId,
    chapterNumber: chapterNumber || 0,
    highlightedText,
    highlightStart,
    highlightEnd,
    readerDescription,
    userId,
    authorId,
    isAuthor
  });

  res.json({
    success: true,
    prosperoResponse: result.prosperoResponse,
    wasCorrection: result.wasCorrection,
    correctedText: result.correctedText,
    isGenuineIssue: result.isGenuineIssue,
    interactionType: result.interactionType,
    correctionId: result.correctionId,
    investigationTimeMs: result.investigationTimeMs
  });
}));

/**
 * POST /story/pushback
 * Reader disagrees with Prospero's initial assessment. One round only.
 */
router.post('/pushback', authenticateUser, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { correctionId, pushbackText } = req.body;

  if (!correctionId || !pushbackText) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: correctionId, pushbackText'
    });
  }

  const { handlePushback } = require('../services/prospero-editor');
  const result = await handlePushback({ correctionId, pushbackText, userId });

  res.json({
    success: true,
    prosperoResponse: result.prosperoResponse,
    wasCorrection: result.wasCorrection,
    correctedText: result.correctedText,
    reconsidered: result.reconsidered,
    isGenuineIssue: result.isGenuineIssue,
    interactionType: result.interactionType,
    investigationTimeMs: result.investigationTimeMs
  });
}));

/**
 * GET /story/:storyId/contribution-stats
 * Get the reader's contribution stats for a specific story.
 */
router.get('/:storyId/contribution-stats', authenticateUser, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { storyId } = req.params;

  const { data: stats } = await supabaseAdmin
    .from('reader_contribution_stats')
    .select('*')
    .eq('user_id', userId)
    .eq('story_id', storyId)
    .maybeSingle();

  res.json({
    success: true,
    stats: stats || { total_flags: 0, successful_catches: 0, explanations_received: 0, categories_caught: {} }
  });
}));

/**
 * GET /story/has-used-editor
 * Check if user has ever used Prospero's Editor (for feature discovery).
 */
router.get('/has-used-editor', authenticateUser, asyncHandler(async (req, res) => {
  const { hasUsedProsperosEditor } = require('../services/prospero-editor');
  const hasUsed = await hasUsedProsperosEditor(req.user.id);
  res.json({ success: true, hasUsed });
}));

/**
 * POST /story/:storyId/archive
 * "Release to the Mists" — archives a book from user's library
 * Transfers ownership to dead-books account, preserves all data
 */
router.post('/:storyId/archive', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { storyId } = req.params;
  const DEAD_BOOKS_USER_ID = '00000000-0000-0000-0000-dead00b00c5a';

  // Verify user owns this story
  const { data: story, error: fetchError } = await supabaseAdmin
    .from('stories')
    .select('id, title, user_id, status')
    .eq('id', storyId)
    .eq('user_id', userId)
    .maybeSingle();

  if (fetchError || !story) {
    return res.status(404).json({ success: false, error: 'Story not found or not owned by user' });
  }

  if (story.status === 'archived') {
    return res.status(400).json({ success: false, error: 'Story is already archived' });
  }

  console.log(`📖 [${story.title}] Archiving — user ${userId} releasing to the Mists`);

  // Transfer to dead-books account with full provenance
  const { error: archiveError } = await supabaseAdmin
    .from('stories')
    .update({
      user_id: DEAD_BOOKS_USER_ID,
      status: 'archived',
      title: `${story.title} [RELEASED]`,
      archived_at: new Date().toISOString(),
      archived_from_user_id: userId,
      archive_reason: 'user_released'
    })
    .eq('id', storyId);

  if (archiveError) {
    console.error(`❌ [${story.title}] Archive failed:`, archiveError);
    return res.status(500).json({ success: false, error: 'Failed to archive story' });
  }

  console.log(`✅ [${story.title}] Released to the Mists successfully`);

  res.json({ success: true, message: 'Story released' });
}));

/**
 * GET /stories/:storyId/ledger
 * The Ledger — per-story record showing readers, resonances, and badges
 */
router.get('/:storyId/ledger', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;

  // Verify story exists and is published to WhisperNet
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('id, title, whispernet_published')
    .eq('id', storyId)
    .single();

  if (storyError || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  if (!story.whispernet_published) {
    return res.status(403).json({
      success: false,
      error: 'This story is not published to WhisperNet'
    });
  }

  // Get total reader count from whisper_events
  const { count: totalReaders } = await supabaseAdmin
    .from('whisper_events')
    .select('*', { count: 'exact', head: true })
    .eq('story_id', storyId)
    .eq('event_type', 'book_finished');

  // Get last 10 readers with their resonance words
  const { data: readerEvents } = await supabaseAdmin
    .from('whisper_events')
    .select('actor_id, metadata, created_at')
    .eq('story_id', storyId)
    .eq('event_type', 'book_finished')
    .order('created_at', { ascending: false })
    .limit(10);

  // Get resonances for these readers
  const recentReaders = [];
  if (readerEvents && readerEvents.length > 0) {
    for (const event of readerEvents) {
      // Get resonance for this reader (if exists)
      const { data: resonance } = await supabaseAdmin
        .from('resonances')
        .select('word')
        .eq('story_id', storyId)
        .eq('user_id', event.actor_id)
        .maybeSingle();

      recentReaders.push({
        display_name: event.metadata?.display_name || 'A reader',
        read_at: event.created_at,
        resonance_word: resonance?.word || null
      });
    }
  }

  // Get resonance cloud (all unique words with counts)
  const { data: resonances } = await supabaseAdmin
    .from('resonances')
    .select('word')
    .eq('story_id', storyId);

  const resonanceCloud = [];
  if (resonances && resonances.length > 0) {
    // Count occurrences of each word
    const wordCounts = {};
    resonances.forEach(r => {
      const word = r.word.toLowerCase();
      wordCounts[word] = (wordCounts[word] || 0) + 1;
    });

    // Convert to array and sort by count
    Object.entries(wordCounts).forEach(([word, count]) => {
      resonanceCloud.push({ word, count });
    });
    resonanceCloud.sort((a, b) => b.count - a.count);
  }

  // Get story-level badges
  const { data: badges } = await supabaseAdmin
    .from('earned_badges')
    .select('badge_type, earned_at')
    .eq('story_id', storyId)
    .order('earned_at', { ascending: true });

  const badgeList = badges ? badges.map(b => ({
    type: b.badge_type,
    earned_at: b.earned_at
  })) : [];

  res.json({
    success: true,
    total_readers: totalReaders || 0,
    recent_readers: recentReaders,
    resonance_cloud: resonanceCloud,
    badges: badgeList
  });
}));

module.exports = router;
