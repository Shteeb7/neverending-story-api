const express = require('express');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');
const { requireAIConsentMiddleware } = require('../middleware/consent');
const { createChatSession, sendMessage, getChatSession } = require('../services/chat');
const prospero = require('../config/prospero');
const peggy = require('../config/peggy');

const router = express.Router();

/**
 * POST /chat/start
 * Start a new text chat session with Prospero
 *
 * Body:
 *   - interviewType: 'onboarding' | 'returning_user' | 'book_completion'
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

  if (!['onboarding', 'returning_user', 'book_completion'].includes(interviewType)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid interviewType. Must be onboarding, returning_user, or book_completion'
    });
  }

  const result = await createChatSession(userId, interviewType, context || {});

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

      const validInterviewTypes = ['onboarding', 'returning_user', 'premise_rejection', 'book_completion'];
      if (!validInterviewTypes.includes(interviewType)) {
        return res.status(400).json({
          success: false,
          error: `Invalid interviewType. Must be one of: ${validInterviewTypes.join(', ')}`
        });
      }

      prompt = prospero.assemblePrompt(interviewType, medium, context || {});
      greeting = prospero.getGreeting(interviewType, context || {});
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
