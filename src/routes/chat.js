const express = require('express');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');
const { requireAIConsentMiddleware } = require('../middleware/consent');
const { createChatSession, sendMessage, getChatSession } = require('../services/chat');
const prospero = require('../config/prospero');
const peggy = require('../config/peggy');
const { supabaseAdmin } = require('../config/supabase');

const router = express.Router();

/**
 * POST /chat/start
 * Start a new text chat session with Prospero
 *
 * Body:
 *   - interviewType: 'onboarding' | 'returning_user' | 'premise_rejection' | 'book_completion' | 'checkpoint' | 'bug_report' | 'suggestion'
 *   - context: (optional) context object for returning_user or book_completion
 *
 * Returns:
 *   - sessionId: UUID of the created session
 *   - openingMessage: Prospero's opening message
 */
router.post('/start', authenticateUser, requireAIConsentMiddleware, asyncHandler(async (req, res) => {
  const { interviewType, context } = req.body;
  const userId = req.userId;

  if (!interviewType) {
    return res.status(400).json({
      success: false,
      error: 'Missing interviewType'
    });
  }

  if (!['onboarding', 'returning_user', 'premise_rejection', 'book_completion', 'checkpoint', 'bug_report', 'suggestion'].includes(interviewType)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid interviewType. Must be onboarding, returning_user, premise_rejection, book_completion, checkpoint, bug_report, or suggestion'
    });
  }

  // Enrich context with reader age for onboarding interviews
  const enrichedContext = context || {};
  if (interviewType === 'onboarding') {
    const { data: prefs } = await supabaseAdmin
      .from('user_preferences')
      .select('birth_year, birth_month, is_minor')
      .eq('user_id', userId)
      .maybeSingle();

    if (prefs?.birth_year) {
      const now = new Date();
      let age = now.getFullYear() - prefs.birth_year;
      if (prefs.birth_month && now.getMonth() + 1 < prefs.birth_month) age--;
      enrichedContext.readerAge = age;
      enrichedContext.isMinor = prefs.is_minor || false;
    }
  }

  // Enrich context for checkpoint interviews
  if (interviewType === 'checkpoint' && context?.storyId) {
    const storyId = context.storyId;
    const checkpointNumber = context.checkpoint || 'chapter_2';

    // Fetch story bible (character names)
    const { data: bible } = await supabaseAdmin
      .from('story_bibles')
      .select('characters')
      .eq('story_id', storyId)
      .maybeSingle();

    if (bible?.characters) {
      // Characters may be an array or an object with protagonist/antagonist/supporting keys
      let characterList;
      if (Array.isArray(bible.characters)) {
        characterList = bible.characters;
      } else if (typeof bible.characters === 'object') {
        characterList = [];
        if (bible.characters.protagonist) characterList.push(bible.characters.protagonist);
        if (bible.characters.antagonist) characterList.push(bible.characters.antagonist);
        if (Array.isArray(bible.characters.supporting)) {
          characterList.push(...bible.characters.supporting);
        }
      }
      if (characterList && characterList.length > 0) {
        enrichedContext.characterNames = characterList.map(c => c.name).filter(Boolean).slice(0, 5);
        enrichedContext.protagonistName = characterList[0]?.name || null;
      }
    }

    // Fetch chapter titles read so far
    const maxChapter = checkpointNumber === 'chapter_2' ? 2 : (checkpointNumber === 'chapter_5' ? 5 : 8);
    const { data: chapters } = await supabaseAdmin
      .from('chapters')
      .select('chapter_number, title')
      .eq('story_id', storyId)
      .lte('chapter_number', maxChapter)
      .order('chapter_number', { ascending: true });

    enrichedContext.chapterTitles = (chapters || []).map(c => `Ch${c.chapter_number}: ${c.title}`);

    // Fetch reading behavior data from chapter_reading_stats
    const { data: readingStats } = await supabaseAdmin
      .from('chapter_reading_stats')
      .select('chapter_number, total_reading_time_seconds, session_count')
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .lte('chapter_number', maxChapter)
      .order('chapter_number', { ascending: true });

    if (readingStats && readingStats.length > 0) {
      // Identify lingered chapters (top 2 by time, > 5 min)
      const lingered = readingStats
        .filter(s => s.total_reading_time_seconds > 300)
        .sort((a, b) => b.total_reading_time_seconds - a.total_reading_time_seconds)
        .slice(0, 2)
        .map(s => ({ chapter: s.chapter_number, minutes: Math.round(s.total_reading_time_seconds / 60) }));

      // Identify skimmed chapters (< 3 min)
      const skimmed = readingStats
        .filter(s => s.total_reading_time_seconds > 0 && s.total_reading_time_seconds < 180)
        .map(s => s.chapter_number);

      // Identify reread chapters (session_count > 1)
      const reread = readingStats
        .filter(s => s.session_count > 1)
        .map(s => ({ chapter: s.chapter_number, sessions: s.session_count }));

      enrichedContext.readingBehavior = { lingered, skimmed, reread };
    }

    // Fetch prior checkpoint feedback (if any)
    const { data: priorFeedback } = await supabaseAdmin
      .from('story_feedback')
      .select('checkpoint, checkpoint_corrections, pacing_feedback, tone_feedback, character_feedback')
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .in('checkpoint', ['chapter_2', 'chapter_5', 'chapter_8'])
      .order('created_at', { ascending: true });

    if (priorFeedback && priorFeedback.length > 0) {
      enrichedContext.priorCheckpointFeedback = priorFeedback;
    }

    // Fetch reader age
    const { data: prefs } = await supabaseAdmin
      .from('user_preferences')
      .select('birth_year, birth_month')
      .eq('user_id', userId)
      .maybeSingle();

    if (prefs?.birth_year) {
      const now = new Date();
      let age = now.getFullYear() - prefs.birth_year;
      if (prefs.birth_month && now.getMonth() + 1 < prefs.birth_month) age--;
      enrichedContext.readerAge = age;
    }
  }

  const result = await createChatSession(userId, interviewType, enrichedContext);

  res.json({
    success: true,
    sessionId: result.sessionId,
    openingMessage: result.openingMessage
  });
}));

/**
 * POST /chat/send
 * Send a message in an existing chat session
 *
 * Body:
 *   - sessionId: UUID of the session
 *   - message: The user's message text
 *
 * Returns:
 *   - message: Prospero's response
 *   - toolCall: { name, arguments } if Prospero called a function, null otherwise
 *   - sessionComplete: boolean, true if the conversation is complete
 */
router.post('/send', authenticateUser, requireAIConsentMiddleware, asyncHandler(async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({
      success: false,
      error: 'Missing sessionId or message'
    });
  }

  const result = await sendMessage(sessionId, message);

  res.json({
    success: true,
    message: result.message,
    toolCall: result.toolCall,
    sessionComplete: result.sessionComplete
  });
}));

/**
 * GET /chat/session/:sessionId
 * Get an existing chat session (for resuming)
 *
 * Returns:
 *   - Full session object with all messages
 */
router.get('/session/:sessionId', authenticateUser, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: 'Missing sessionId'
    });
  }

  const session = await getChatSession(sessionId);

  res.json({
    success: true,
    session: session
  });
}));

/**
 * POST /chat/system-prompt
 * Assemble a system prompt for Prospero or Peggy
 *
 * Body:
 *   - persona: (optional) 'prospero' | 'peggy' — defaults to 'prospero'
 *   - interviewType: (for Prospero) 'onboarding' | 'returning_user' | 'premise_rejection' | 'book_completion'
 *   - reportType: (for Peggy) 'bug_report' | 'suggestion'
 *   - medium: 'voice' | 'text'
 *   - context: (optional) context object with persona-specific data
 *
 * Returns:
 *   - prompt: The complete system prompt
 *   - greeting: The opening greeting
 */
router.post('/system-prompt', authenticateUser, requireAIConsentMiddleware, asyncHandler(async (req, res) => {
  const { persona = 'prospero', interviewType, reportType, medium, context } = req.body;

  if (!medium) {
    return res.status(400).json({
      success: false,
      error: 'Missing medium (voice or text)'
    });
  }

  const validMediums = ['voice', 'text'];
  if (!validMediums.includes(medium)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid medium. Must be voice or text'
    });
  }

  try {
    let prompt, greeting;

    if (persona === 'peggy') {
      // Peggy uses reportType instead of interviewType
      if (!reportType) {
        return res.status(400).json({
          success: false,
          error: 'Missing reportType for Peggy (bug_report or suggestion)'
        });
      }

      const validReportTypes = ['bug_report', 'suggestion'];
      if (!validReportTypes.includes(reportType)) {
        return res.status(400).json({
          success: false,
          error: `Invalid reportType. Must be one of: ${validReportTypes.join(', ')}`
        });
      }

      prompt = peggy.assemblePrompt(reportType, medium, context || {});
      greeting = peggy.getGreeting(reportType, context || {});

    } else {
      // Default to Prospero (backward compatible)
      if (!interviewType) {
        return res.status(400).json({
          success: false,
          error: 'Missing interviewType for Prospero'
        });
      }

      const validInterviewTypes = ['onboarding', 'returning_user', 'premise_rejection', 'book_completion', 'checkpoint'];
      if (!validInterviewTypes.includes(interviewType)) {
        return res.status(400).json({
          success: false,
          error: `Invalid interviewType. Must be one of: ${validInterviewTypes.join(', ')}`
        });
      }

      // Enrich context with reader age for onboarding interviews
      const enrichedContext = context || {};
      if (interviewType === 'onboarding') {
        const userId = req.userId;
        const { data: prefs } = await supabaseAdmin
          .from('user_preferences')
          .select('birth_year, birth_month, is_minor')
          .eq('user_id', userId)
          .maybeSingle();

        if (prefs?.birth_year) {
          const now = new Date();
          let age = now.getFullYear() - prefs.birth_year;
          if (prefs.birth_month && now.getMonth() + 1 < prefs.birth_month) age--;
          enrichedContext.readerAge = age;
          enrichedContext.isMinor = prefs.is_minor || false;
        }
      }

      prompt = prospero.assemblePrompt(interviewType, medium, enrichedContext);
      greeting = prospero.getGreeting(interviewType, enrichedContext);
    }

    res.json({
      success: true,
      prompt,
      greeting
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}));

module.exports = router;
