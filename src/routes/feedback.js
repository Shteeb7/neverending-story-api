const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

/**
 * Shared function: Trigger batch generation based on checkpoint
 * @param {string} storyId - Story ID
 * @param {string} userId - User ID
 * @param {string} normalizedCheckpoint - Normalized checkpoint name (chapter_2, chapter_5, or chapter_8)
 * @returns {Promise<{ shouldGenerate: boolean, startChapter: number|null, endChapter: number|null }>}
 */
async function triggerCheckpointGeneration(storyId, userId, normalizedCheckpoint) {
  // Determine which batch to generate
  let startChapter = null;
  let endChapter = null;

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

      return { shouldGenerate: false, startChapter, endChapter };
    }
  }

  if (shouldGenerate) {
    console.log(`🚀 Triggering batch generation: chapters ${startChapter}-${endChapter}`);
    const { buildCourseCorrections, generateBatch } = require('../services/generation');

    // Update generation_progress BEFORE starting batch (so health check can detect failures)
    const { data: storyForProgress } = await supabaseAdmin
      .from('stories')
      .select('generation_progress')
      .eq('id', storyId)
      .single();

    const currentProgress = storyForProgress?.generation_progress || {};
    await supabaseAdmin
      .from('stories')
      .update({
        generation_progress: {
          ...currentProgress,
          current_step: `generating_chapter_${startChapter}`,
          batch_start: startChapter,
          batch_end: endChapter,
          health_check_retries: 0,  // Reset retries for new batch — old retries were for a different step
          last_error: null,
          recovery_started: null,
          last_updated: new Date().toISOString()
        }
      })
      .eq('id', storyId);

    console.log(`📖 Updated progress to generating_chapter_${startChapter} before batch start`);

    (async () => {
      try {
        // Fetch all previous checkpoint feedback for this story to build accumulated corrections
        const { data: previousFeedback } = await supabaseAdmin
          .from('story_feedback')
          .select('checkpoint, pacing_feedback, tone_feedback, character_feedback, protagonist_name, checkpoint_corrections, created_at')
          .eq('user_id', userId)
          .eq('story_id', storyId)
          .in('checkpoint', ['chapter_2', 'chapter_5', 'chapter_8', 'chapter_3', 'chapter_6', 'chapter_9']) // Include old checkpoint names
          .order('created_at', { ascending: true });

        const feedbackHistory = previousFeedback || [];

        // Fetch the arc to get chapter outlines for the upcoming batch
        const { data: arc } = await supabaseAdmin
          .from('story_arcs')
          .select('chapters')
          .eq('story_id', storyId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        // Get the outlines for the chapters we're about to generate
        const batchOutlines = arc?.chapters?.filter(ch =>
          ch.chapter_number >= startChapter && ch.chapter_number <= endChapter
        ) || [];

        // Generate editor brief with revised outlines (returns null if no corrections needed)
        const { generateEditorBrief } = require('../services/generation');
        let editorBrief = null;
        try {
          editorBrief = await generateEditorBrief(storyId, feedbackHistory, batchOutlines);
          console.log(`📝 Editor brief: ${editorBrief ? 'generated with revised outlines' : 'not needed (all positive feedback)'}`);
        } catch (err) {
          console.warn(`⚠️ Editor brief generation failed, proceeding without corrections: ${err.message}`);
        }

        // Generate batch with editor brief (or null for no corrections)
        await generateBatch(storyId, startChapter, endChapter, userId, editorBrief);

        // Update progress to awaiting next checkpoint after batch completes
        const nextAwaitingStep = {
          6: 'awaiting_chapter_5_feedback',
          9: 'awaiting_chapter_8_feedback',
          12: 'chapter_12_complete'
        };

        await supabaseAdmin
          .from('stories')
          .update({
            generation_progress: {
              ...currentProgress,
              chapters_generated: endChapter,
              current_step: nextAwaitingStep[endChapter] || `chapter_${endChapter}_complete`,
              batch_start: null,
              batch_end: null,
              last_updated: new Date().toISOString()
            }
          })
          .eq('id', storyId);

        console.log(`✅ Batch generation complete: chapters ${startChapter}-${endChapter}`);
      } catch (error) {
        console.error(`❌ Failed to generate batch: ${error.message}`);
        // Mark the failure in generation_progress so health check can find it
        try {
          await supabaseAdmin
            .from('stories')
            .update({
              generation_progress: {
                ...currentProgress,
                current_step: `generating_chapter_${startChapter}`,
                batch_start: startChapter,
                batch_end: endChapter,
                last_error: error.message,
                last_updated: new Date().toISOString()
              }
            })
            .eq('id', storyId);
        } catch (progressError) {
          console.error(`❌ Failed to update progress after batch error: ${progressError.message}`);
        }
      }
    })();
  }

  return { shouldGenerate, startChapter, endChapter };
}

// Export moved to bottom of file (after module.exports = router)

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
    response: response || (hasDimensions ? 'dimension_feedback' : null), // Default for new format
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

  // Log preference event for audit trail
  const { logPreferenceEvent } = require('../services/generation');
  await logPreferenceEvent(userId, 'checkpoint_feedback', hasDimensions ? 'dimension_cards' : 'text', {
    checkpoint: normalizedCheckpoint,
    pacing: pacing || null,
    tone: tone || null,
    character: character || null,
    response: response || null
  }, storyId);

  // Use shared generation trigger function
  const { shouldGenerate, startChapter, endChapter } = await triggerCheckpointGeneration(storyId, userId, normalizedCheckpoint);

  // If chapters already existed, return early
  if (!shouldGenerate && startChapter && endChapter) {
    return res.json({
      success: true,
      message: 'Chapters already available',
      courseCorrections: null
    });
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
 * POST /feedback/voice-checkpoint
 * Submit checkpoint feedback gathered via voice interview with Prospero.
 * Accepts the structured tool call output (pacing_note, tone_note, etc.)
 * and triggers next chapter batch generation — same as the text chat path.
 */
router.post('/voice-checkpoint', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { storyId, checkpoint, transcript, preferences } = req.body;

  if (!storyId || !checkpoint) {
    return res.status(400).json({
      success: false,
      error: 'storyId and checkpoint are required'
    });
  }

  // Normalize checkpoint name (backward compatibility)
  const checkpointMap = {
    'chapter_3': 'chapter_2',
    'chapter_6': 'chapter_5',
    'chapter_9': 'chapter_8'
  };
  const normalizedCheckpoint = checkpointMap[checkpoint] || checkpoint;

  console.log(`🎤 Voice checkpoint feedback: story=${storyId}, checkpoint=${normalizedCheckpoint}`);
  console.log(`   Engagement: ${preferences?.overall_engagement || 'unknown'}`);

  // Store in story_feedback with checkpoint_corrections = structured Prospero feedback
  const { data, error } = await supabaseAdmin
    .from('story_feedback')
    .upsert({
      user_id: userId,
      story_id: storyId,
      checkpoint: normalizedCheckpoint,
      response: 'voice_checkpoint_interview',
      checkpoint_corrections: preferences || null,
      voice_transcript: transcript || null,
      voice_session_id: null
    }, {
      onConflict: 'user_id,story_id,checkpoint'
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to store voice checkpoint feedback: ${error.message}`);
  }

  console.log(`✅ Voice checkpoint feedback stored for ${normalizedCheckpoint}`);

  // Log preference event for audit trail
  const { logPreferenceEvent } = require('../services/generation');
  await logPreferenceEvent(userId, 'checkpoint_feedback', 'voice', {
    checkpoint: normalizedCheckpoint,
    engagement: preferences?.overall_engagement || null,
    pacing_note: preferences?.pacing_note || null,
    tone_note: preferences?.tone_note || null,
    character_notes: preferences?.character_notes || null,
    style_note: preferences?.style_note || null
  }, storyId);

  // Trigger next batch generation (same logic as text checkpoint path)
  const { shouldGenerate, startChapter, endChapter } = await triggerCheckpointGeneration(storyId, userId, normalizedCheckpoint);

  res.json({
    success: true,
    feedback: data,
    generatingChapters: shouldGenerate ? Array.from({ length: endChapter - startChapter + 1 }, (_, i) => startChapter + i) : [],
    alreadyGenerated: !shouldGenerate && startChapter && endChapter
  });
}));

/**
 * POST /feedback/skip-checkpoint
 * Reader chose to skip the check-in with Prospero.
 * Records a minimal feedback row (so we know they skipped) and triggers next chapter batch generation.
 */
router.post('/skip-checkpoint', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { storyId, checkpoint } = req.body;

  if (!storyId || !checkpoint) {
    return res.status(400).json({
      success: false,
      error: 'storyId and checkpoint are required'
    });
  }

  // Normalize checkpoint name (backward compatibility)
  const checkpointMap = {
    'chapter_3': 'chapter_2',
    'chapter_6': 'chapter_5',
    'chapter_9': 'chapter_8'
  };
  const normalizedCheckpoint = checkpointMap[checkpoint] || checkpoint;

  console.log(`⏭️ Checkpoint skipped: story=${storyId}, checkpoint=${normalizedCheckpoint}`);

  // Store a minimal feedback row so we know they skipped (and don't re-prompt)
  const { error } = await supabaseAdmin
    .from('story_feedback')
    .upsert({
      user_id: userId,
      story_id: storyId,
      checkpoint: normalizedCheckpoint,
      response: 'skipped',
      checkpoint_corrections: null,
      voice_transcript: null
    }, {
      onConflict: 'user_id,story_id,checkpoint'
    });

  if (error) {
    throw new Error(`Failed to store skip-checkpoint record: ${error.message}`);
  }

  // Log preference event for audit trail
  const { logPreferenceEvent } = require('../services/generation');
  await logPreferenceEvent(userId, 'skip_checkpoint', 'system', {
    checkpoint: normalizedCheckpoint
  }, storyId);

  // Trigger next batch generation with no course corrections
  const { shouldGenerate, startChapter, endChapter } = await triggerCheckpointGeneration(storyId, userId, normalizedCheckpoint);

  res.json({
    success: true,
    skipped: true,
    generatingChapters: shouldGenerate ? Array.from({ length: endChapter - startChapter + 1 }, (_, i) => startChapter + i) : [],
    alreadyGenerated: !shouldGenerate && startChapter && endChapter
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

  // Log preference event for audit trail
  const { logPreferenceEvent, analyzeUserPreferences, updateDiscoveryTolerance } = require('../services/generation');
  await logPreferenceEvent(userId, 'book_completion', 'voice', {
    satisfactionSignal: enrichedPreferences?.satisfactionSignal || null,
    highlights: enrichedPreferences?.highlights || [],
    lowlights: enrichedPreferences?.lowlights || [],
    sequelDesires: enrichedPreferences?.sequelDesires || null,
    preferenceUpdates: enrichedPreferences?.preferenceUpdates || null
  }, storyId);

  // Non-blocking: trigger preference analysis and discovery tolerance update in background
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

  // Fetch checkpoint feedback (chapters 2, 5, 8)
  const { data: feedbackRows } = await supabaseAdmin
    .from('story_feedback')
    .select('checkpoint, response, follow_up_action, checkpoint_corrections')
    .eq('story_id', storyId)
    .eq('user_id', userId)
    .in('checkpoint', ['chapter_2', 'chapter_5', 'chapter_8'])
    .order('checkpoint', { ascending: true });

  const checkpointFeedback = (feedbackRows || []).map(f => ({
    checkpoint: f.checkpoint,
    response: f.response,
    action: f.follow_up_action,
    corrections: f.checkpoint_corrections || null
  }));

  // Fetch reader age from user_preferences
  const { data: userPrefs } = await supabaseAdmin
    .from('user_preferences')
    .select('reader_age')
    .eq('user_id', userId)
    .maybeSingle();

  res.json({
    success: true,
    story: {
      title: story.title,
      genre: story.genre,
      premiseTier: story.premise_tier
    },
    bible: bibleData,
    readingBehavior,
    checkpointFeedback,
    readerAge: userPrefs?.reader_age || null
  });
}));

module.exports = router;
module.exports.triggerCheckpointGeneration = triggerCheckpointGeneration;
