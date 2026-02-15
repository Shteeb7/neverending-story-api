const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /feedback
 * Submit simple feedback (e.g., library exit reasons)
 * Called by FeedbackModalView when a reader leaves a story
 */
router.post('/', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { storyId, feedback } = req.body;

  if (!storyId || !feedback) {
    return res.status(400).json({
      success: false,
      error: 'storyId and feedback are required'
    });
  }

  console.log(`📊 Library feedback: story=${storyId}, reason="${feedback}"`);

  // Store in story_feedback table with checkpoint='library_exit'
  const { data, error } = await supabaseAdmin
    .from('story_feedback')
    .upsert({
      user_id: userId,
      story_id: storyId,
      checkpoint: 'library_exit',
      response: feedback,
      follow_up_action: null,
      voice_transcript: null,
      voice_session_id: null
    }, {
      onConflict: 'user_id,story_id,checkpoint'
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to store feedback: ${error.message}`);
  }

  res.json({
    success: true,
    feedback: data
  });
}));

/**
 * POST /feedback/checkpoint
 * Submit reader feedback at chapter checkpoints (2, 5, 8) with dimension-based feedback
 *
 * Accepts both new format (dimension fields) and old format (response field) for backward compatibility
 */
router.post('/checkpoint', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const {
    storyId,
    checkpoint,
    // New dimension fields (Adaptive Reading Engine)
    pacing,
    tone,
    character,
    protagonistName,
    // Old fields (backward compatibility)
    response,
    followUpAction,
    voiceTranscript,
    voiceSessionId
  } = req.body;

  if (!storyId || !checkpoint) {
    return res.status(400).json({
      success: false,
      error: 'storyId and checkpoint are required'
    });
  }

  // For backward compatibility: accept either dimension fields OR old response field
  const hasDimensions = pacing || tone || character;
  const hasOldFormat = response;

  if (!hasDimensions && !hasOldFormat) {
    return res.status(400).json({
      success: false,
      error: 'Either dimension fields (pacing, tone, character) or response field is required'
    });
  }

  // Map old checkpoint names to new names for backward compatibility
  const checkpointMap = {
    'chapter_3': 'chapter_2',   // old name → new name
    'chapter_6': 'chapter_5',
    'chapter_9': 'chapter_8'
  };
  const normalizedCheckpoint = checkpointMap[checkpoint] || checkpoint;

  console.log(`📊 Feedback: story=${storyId}, checkpoint=${checkpoint}${checkpoint !== normalizedCheckpoint ? ` (normalized to ${normalizedCheckpoint})` : ''}, ${hasDimensions ? `dimensions={pacing:${pacing}, tone:${tone}, character:${character}}` : `response=${response}`}`);

  // Store feedback with dimensions (use normalized checkpoint)
  const feedbackData = {
    user_id: userId,
    story_id: storyId,
    checkpoint: normalizedCheckpoint,  // Use normalized checkpoint name
    response: response || null, // Keep for backward compatibility
    follow_up_action: followUpAction || null,
    voice_transcript: voiceTranscript || null,
    voice_session_id: voiceSessionId || null,
    // New dimension fields
    pacing_feedback: pacing || null,
    tone_feedback: tone || null,
    character_feedback: character || null,
    protagonist_name: protagonistName || null
  };

  const { data, error } = await supabaseAdmin
    .from('story_feedback')
    .upsert(feedbackData, {
      onConflict: 'user_id,story_id,checkpoint'
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to store feedback: ${error.message}`);
  }

  // New trigger logic: chapter_2 → 4-6, chapter_5 → 7-9, chapter_8 → 10-12
  // Always generate (no satisfaction gate)
  let startChapter = null;
  let endChapter = null;

  // Use normalized checkpoint for trigger logic
  if (normalizedCheckpoint === 'chapter_2') {
    startChapter = 4;
    endChapter = 6;
  } else if (normalizedCheckpoint === 'chapter_5') {
    startChapter = 7;
    endChapter = 9;
  } else if (normalizedCheckpoint === 'chapter_8') {
    startChapter = 10;
    endChapter = 12;
  }

  let shouldGenerate = startChapter !== null && endChapter !== null;

  // Check if the next batch of chapters already exists (legacy beta stories)
  if (shouldGenerate) {
    const { count } = await supabaseAdmin
      .from('chapters')
      .select('*', { count: 'exact', head: true })
      .eq('story_id', storyId)
      .gte('chapter_number', startChapter)
      .lte('chapter_number', endChapter);

    if (count >= 3) {
      // Chapters already exist, skip generation
      console.log(`📖 Chapters ${startChapter}-${endChapter} already exist for story ${storyId}, skipping generation`);

      // Fetch story to get current progress
      const { data: story } = await supabaseAdmin
        .from('stories')
        .select('title, generation_progress')
        .eq('id', storyId)
        .single();

      const storyTitle = story?.title || 'Unknown';

      // Update generation_progress to the next awaiting step without regenerating
      const nextStep = {
        4: 'awaiting_chapter_5_feedback',
        7: 'awaiting_chapter_8_feedback',
        10: 'chapter_12_complete'
      };

      await supabaseAdmin
        .from('stories')
        .update({
          generation_progress: {
            ...story.generation_progress,
            chapters_generated: endChapter,
            current_step: nextStep[startChapter]
          }
        })
        .eq('id', storyId);

      console.log(`📖 [${storyTitle}] Updated progress to ${nextStep[startChapter]}`);

      // Return success so the reader continues normally
      return res.json({
        success: true,
        message: 'Chapters already available',
        courseCorrections: null
      });
    }
  }

  if (shouldGenerate) {
    console.log(`🚀 Triggering batch generation: chapters ${startChapter}-${endChapter}`);
    const { buildCourseCorrections, generateBatch } = require('../services/generation');

    (async () => {
      try {
        // Fetch all previous checkpoint feedback for this story to build accumulated corrections
        const { data: previousFeedback } = await supabaseAdmin
          .from('story_feedback')
          .select('checkpoint, pacing_feedback, tone_feedback, character_feedback, protagonist_name, created_at')
          .eq('user_id', userId)
          .eq('story_id', storyId)
          .in('checkpoint', ['chapter_2', 'chapter_5', 'chapter_8', 'chapter_3', 'chapter_6', 'chapter_9']) // Include old checkpoint names
          .order('created_at', { ascending: true });

        const feedbackHistory = previousFeedback || [];

        // Build course corrections from accumulated feedback
        const courseCorrections = buildCourseCorrections(feedbackHistory);

        console.log(`📝 Course corrections built from ${feedbackHistory.length} checkpoint(s)`);

        // Generate batch with course corrections
        await generateBatch(storyId, startChapter, endChapter, userId, courseCorrections);

        console.log(`✅ Batch generation complete: chapters ${startChapter}-${endChapter}`);
      } catch (error) {
        console.error(`❌ Failed to generate batch: ${error.message}`);
      }
    })();
  }

  // Build human-readable course correction summary for response
  let courseCorrectionsResponse = null;
  if (hasDimensions) {
    courseCorrectionsResponse = {};
    if (pacing && pacing !== 'hooked') {
      courseCorrectionsResponse.pacing = pacing === 'slow'
        ? 'Increasing pace — entering scenes later, more hooks'
        : 'Adding breathing room — more sensory detail, emotional reflection';
    }
    if (tone && tone !== 'right') {
      courseCorrectionsResponse.tone = tone === 'serious'
        ? 'Adding humor and levity through character interactions'
        : 'Deepening emotional stakes and tension';
    }
    if (character && character !== 'love') {
      courseCorrectionsResponse.character = character === 'warming'
        ? 'Adding more interior thought and vulnerability'
        : 'Increasing protagonist agency and competence';
    }
  }

  res.json({
    success: true,
    feedback: data,
    generatingChapters: shouldGenerate ? Array.from({ length: endChapter - startChapter + 1 }, (_, i) => startChapter + i) : [],
    courseCorrections: courseCorrectionsResponse
  });
}));

/**
 * GET /feedback/status/:storyId/:checkpoint
 */
router.get('/status/:storyId/:checkpoint', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { storyId, checkpoint } = req.params;

  const { data } = await supabaseAdmin
    .from('story_feedback')
    .select('*')
    .eq('user_id', userId)
    .eq('story_id', storyId)
    .eq('checkpoint', checkpoint)
    .maybeSingle();

  res.json({
    success: true,
    hasFeedback: !!data,
    feedback: data || null
  });
}));

/**
 * POST /feedback/completion-interview
 */
router.post('/completion-interview', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { storyId, transcript, sessionId, preferences } = req.body;

  const { data: story } = await supabaseAdmin
    .from('stories')
    .select('series_id, book_number')
    .eq('id', storyId)
    .single();

  // Enrich preferences with new completion feedback fields
  const enrichedPreferences = preferences ? {
    ...preferences,
    // Extract richer feedback data
    highlights: preferences.highlights || [],
    lowlights: preferences.lowlights || [],
    characterConnections: preferences.characterConnections || '',
    sequelDesires: preferences.sequelDesires || '',
    satisfactionSignal: preferences.satisfactionSignal || 'satisfied',
    preferenceUpdates: preferences.preferenceUpdates || ''
  } : null;

  console.log('📊 Book completion feedback received:');
  console.log(`   Satisfaction: ${enrichedPreferences?.satisfactionSignal}`);
  console.log(`   Highlights: ${enrichedPreferences?.highlights?.length || 0} items`);
  console.log(`   Sequel desires captured: ${!!enrichedPreferences?.sequelDesires}`);

  const { data, error } = await supabaseAdmin
    .from('book_completion_interviews')
    .upsert({
      user_id: userId,
      story_id: storyId,
      series_id: story?.series_id,
      book_number: story?.book_number || 1,
      transcript,
      session_id: sessionId || null,
      preferences_extracted: enrichedPreferences
    }, {
      onConflict: 'user_id,story_id'
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to store interview: ${error.message}`);
  }

  // Non-blocking: trigger preference analysis and discovery tolerance update in background
  const { analyzeUserPreferences, updateDiscoveryTolerance } = require('../services/generation');
  (async () => {
    try {
      const result = await analyzeUserPreferences(userId);
      console.log(`📊 Preference analysis: ${result.ready ? 'Updated' : result.reason}`);
    } catch (err) {
      console.error('Preference analysis failed (non-blocking):', err.message);
    }
  })();

  updateDiscoveryTolerance(userId).catch(err =>
    console.error('Discovery tolerance update failed (non-blocking):', err.message)
  );

  res.json({
    success: true,
    interview: data
  });
}));

/**
 * POST /feedback/analyze-preferences
 * Trigger preference analysis for a user (called after completing a story)
 */
router.post('/analyze-preferences', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { analyzeUserPreferences } = require('../services/generation');

  const result = await analyzeUserPreferences(userId);

  res.json({
    success: true,
    ...result
  });
}));

/**
 * GET /feedback/writing-preferences
 * Get the user's learned writing preferences
 */
router.get('/writing-preferences', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { getUserWritingPreferences } = require('../services/generation');

  const preferences = await getUserWritingPreferences(userId);

  res.json({
    success: true,
    hasPreferences: !!preferences,
    preferences: preferences || null
  });
}));

/**
 * GET /feedback/completion-context/:storyId
 * Fetch rich context for book completion interview (Prospero needs reference points)
 * Returns: story details, bible summary, reading analytics, checkpoint feedback
 */
router.get('/completion-context/:storyId', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { storyId } = req.params;

  // Fetch story details
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('title, genre, premise_tier')
    .eq('id', storyId)
    .eq('user_id', userId)
    .single();

  if (storyError || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  // Fetch bible summary (protagonist, central conflict, themes, key locations)
  const { data: bible } = await supabaseAdmin
    .from('story_bibles')
    .select('characters, central_conflict, themes, key_locations')
    .eq('story_id', storyId)
    .single();

  let bibleData = {
    protagonistName: null,
    supportingCast: [],
    centralConflict: '',
    themes: [],
    keyLocations: []
  };

  if (bible) {
    // Extract protagonist (first character in bible.characters array)
    const characters = bible.characters || [];
    if (characters.length > 0) {
      bibleData.protagonistName = characters[0].name;
      bibleData.supportingCast = characters.slice(1, 4).map(c => c.name); // Top 3 supporting
    }

    bibleData.centralConflict = typeof bible.central_conflict === 'string'
      ? bible.central_conflict
      : bible.central_conflict?.description || '';
    bibleData.themes = bible.themes || [];
    bibleData.keyLocations = (bible.key_locations || []).map(loc =>
      typeof loc === 'string' ? loc : loc.name
    );
  }

  // Fetch reading analytics
  const { data: readingStats } = await supabaseAdmin
    .from('chapter_reading_stats')
    .select('chapter_number, total_reading_time_seconds, session_count, completed')
    .eq('story_id', storyId)
    .eq('user_id', userId)
    .order('chapter_number', { ascending: true });

  let readingBehavior = {
    totalReadingMinutes: 0,
    lingeredChapters: [],   // Top 3 by time
    skimmedChapters: [],    // Under 2 min
    rereadChapters: []      // session_count > 1
  };

  if (readingStats && readingStats.length > 0) {
    const totalSeconds = readingStats.reduce((sum, s) => sum + (s.total_reading_time_seconds || 0), 0);
    readingBehavior.totalReadingMinutes = Math.round(totalSeconds / 60);

    // Lingered chapters (top 3 by time)
    const lingered = readingStats
      .filter(s => s.total_reading_time_seconds > 0)
      .sort((a, b) => b.total_reading_time_seconds - a.total_reading_time_seconds)
      .slice(0, 3)
      .map(s => ({
        chapter: s.chapter_number,
        minutes: Math.round(s.total_reading_time_seconds / 60)
      }));
    readingBehavior.lingeredChapters = lingered;

    // Skimmed chapters (under 2 min)
    const skimmed = readingStats
      .filter(s => s.total_reading_time_seconds > 0 && s.total_reading_time_seconds < 120)
      .map(s => s.chapter_number);
    readingBehavior.skimmedChapters = skimmed;

    // Re-read chapters
    const reread = readingStats
      .filter(s => s.session_count > 1)
      .map(s => ({
        chapter: s.chapter_number,
        sessions: s.session_count
      }));
    readingBehavior.rereadChapters = reread;
  }

  // Fetch checkpoint feedback (chapters 3, 6, 9)
  const { data: feedbackRows } = await supabaseAdmin
    .from('story_feedback')
    .select('checkpoint, response, follow_up_action')
    .eq('story_id', storyId)
    .eq('user_id', userId)
    .in('checkpoint', ['chapter_3', 'chapter_6', 'chapter_9'])
    .order('checkpoint', { ascending: true });

  const checkpointFeedback = (feedbackRows || []).map(f => ({
    checkpoint: f.checkpoint,
    response: f.response,
    action: f.follow_up_action
  }));

  res.json({
    success: true,
    story: {
      title: story.title,
      genre: story.genre,
      premiseTier: story.premise_tier
    },
    bible: bibleData,
    readingBehavior,
    checkpointFeedback
  });
}));

module.exports = router;
