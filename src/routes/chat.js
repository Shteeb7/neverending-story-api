const express = require('express');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');
const { createChatSession, sendMessage, getChatSession } = require('../services/chat');

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
router.post('/start', authenticateUser, asyncHandler(async (req, res) => {
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
router.post('/send', authenticateUser, asyncHandler(async (req, res) => {
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

module.exports = router;
