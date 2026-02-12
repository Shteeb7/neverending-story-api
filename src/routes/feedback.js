const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /feedback/checkpoint
 * Submit reader feedback at chapter checkpoints (3, 6, 9)
 */
router.post('/checkpoint', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { storyId, checkpoint, response, followUpAction, voiceTranscript, voiceSessionId } = req.body;

  if (!storyId || !checkpoint || !response) {
    return res.status(400).json({
      success: false,
      error: 'storyId, checkpoint, and response are required'
    });
  }

  console.log(`📊 Feedback: story=${storyId}, checkpoint=${checkpoint}, response=${response}`);

  // Store feedback
  const { data, error } = await supabaseAdmin
    .from('story_feedback')
    .upsert({
      user_id: userId,
      story_id: storyId,
      checkpoint,
      response,
      follow_up_action: followUpAction || null,
      voice_transcript: voiceTranscript || null,
      voice_session_id: voiceSessionId || null
    }, {
      onConflict: 'user_id,story_id,checkpoint'
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to store feedback: ${error.message}`);
  }

  // Trigger chapter generation if appropriate
  let chaptersToGenerate = [];

  if (checkpoint === 'chapter_3' && (response === 'Great' || response === 'Fantastic' || followUpAction === 'keep_reading')) {
    chaptersToGenerate = [7, 8, 9];
  } else if (checkpoint === 'chapter_6' && (response === 'Great' || response === 'Fantastic' || followUpAction === 'keep_reading')) {
    chaptersToGenerate = [10, 11, 12];
  }

  if (chaptersToGenerate.length > 0) {
    console.log(`🚀 Triggering generation of chapters ${chaptersToGenerate.join(', ')}`);
    const { generateChapter } = require('../services/generation');

    (async () => {
      try {
        for (const chapterNum of chaptersToGenerate) {
          await generateChapter(storyId, chapterNum, userId);
          if (chapterNum !== chaptersToGenerate[chaptersToGenerate.length - 1]) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        console.log(`✅ Generated chapters ${chaptersToGenerate.join(', ')}`);
      } catch (error) {
        console.error(`❌ Failed to generate chapters: ${error.message}`);
      }
    })();
  }

  res.json({
    success: true,
    feedback: data,
    generatingChapters: chaptersToGenerate
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

  const { data, error } = await supabaseAdmin
    .from('book_completion_interviews')
    .upsert({
      user_id: userId,
      story_id: storyId,
      series_id: story?.series_id,
      book_number: story?.book_number || 1,
      transcript,
      session_id: sessionId || null,
      preferences_extracted: preferences || null
    }, {
      onConflict: 'user_id,story_id'
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to store interview: ${error.message}`);
  }

  res.json({
    success: true,
    interview: data
  });
}));

module.exports = router;
