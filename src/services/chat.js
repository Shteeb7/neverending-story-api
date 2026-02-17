const { anthropic } = require('../config/ai-clients');
const { supabaseAdmin } = require('../config/supabase');
const { assemblePrompt, getGreeting } = require('../config/prospero');

// CHAT TOOLS - Anthropic format for function calling
const CHAT_TOOLS = {
  onboarding: [{
    name: 'submit_story_preferences',
    description: 'Submit the gathered reader preferences to generate story premises. Call this when you have enough information about the reader.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Reader name' },
        favoriteGenres: { type: 'array', items: { type: 'string' }, description: 'List of favorite genres like \'LitRPG\', \'Fantasy\', \'Sci-Fi\', \'Mystery\', \'Horror\', \'Adventure\'' },
        preferredThemes: { type: 'array', items: { type: 'string' }, description: 'Preferred themes like \'Magic\', \'Technology\', \'Dragons\', \'Mystery\', \'Friendship\', \'Coming of Age\'' },
        dislikedElements: { type: 'array', items: { type: 'string' }, description: 'Story elements, genres, or character types they DON\'T like or want to avoid' },
        characterTypes: { type: 'string', description: 'Type of protagonist they prefer like \'Hero\', \'Underdog\', \'Anti-hero\', \'Reluctant Hero\', \'Chosen One\'' },
        mood: { type: 'string', description: 'Desired mood like \'Epic\', \'Dark\', \'Lighthearted\', \'Suspenseful\', \'Hopeful\', \'Whimsical\'' },
        ageRange: { type: 'string', description: 'Age of the reader - determines complexity and maturity level. Options: \'child\' (8-12), \'teen\' (13-17), \'young-adult\' (18-25), \'adult\' (25+). Keep for backward compatibility but readingLevel is now preferred.' },
        emotionalDrivers: { type: 'array', items: { type: 'string' }, description: 'WHY they read (e.g. \'escape\', \'feel deeply\', \'intellectual challenge\', \'thrill\')' },
        belovedStories: { type: 'array', items: { type: 'string' }, description: 'Books, series, movies, or shows the reader mentioned loving. These determine reading level.' },
        readingLevel: { type: 'string', enum: ['early_reader', 'middle_grade', 'upper_middle_grade', 'young_adult', 'new_adult', 'adult'], description: 'Derived from their favorite books/media AND their age. Use the anchor books table to calibrate: Magic Tree House/Wimpy Kid = early_reader, Percy Jackson/Harry Potter = middle_grade, Hunger Games/Eragon = upper_middle_grade, Six of Crows/Throne of Glass = young_adult, ACOTAR/Fourth Wing = new_adult, Sanderson/adult fantasy = adult' },
        readingMotivation: { type: 'string', description: 'Natural language summary of what drives their reading' },
        discoveryTolerance: { type: 'string', description: '\'low\' (comfort-seeker), \'medium\' (balanced), or \'high\' (adventurer)' },
        pacePreference: { type: 'string', description: '\'fast\' or \'slow\' or \'varied\'' }
      },
      required: ['name', 'readingLevel']
    }
  }],
  returning_user: [{
    name: 'submit_new_story_request',
    description: 'Submit the returning user story request. Call when you understand what they want next.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['comfort', 'stretch', 'wildcard', 'specific'], description: '\'comfort\' (more of what they love), \'stretch\' (something adjacent), \'wildcard\' (surprise me), or \'specific\' (they have a specific idea)' },
        moodShift: { type: 'string', description: 'What they\'re in the mood for now' },
        explicitRequest: { type: 'string', description: 'If they had a specific idea, capture it here' },
        newInterests: { type: 'array', items: { type: 'string' }, description: 'Any new stories/genres they\'ve mentioned since last time' }
      },
      required: ['direction']
    }
  }],
  book_completion: [{
    name: 'submit_completion_feedback',
    description: 'Submit the book completion feedback. Call when the reader has shared their experience.',
    input_schema: {
      type: 'object',
      properties: {
        highlights: { type: 'array', items: { type: 'string' }, description: 'Moments/scenes they loved' },
        lowlights: { type: 'array', items: { type: 'string' }, description: 'Things that felt off or slow' },
        characterConnections: { type: 'string', description: 'Who they bonded with and why' },
        sequelDesires: { type: 'string', description: 'What they want in the next book' },
        satisfactionSignal: { type: 'string', description: 'Overall feeling (enthusiastic/satisfied/mixed/disappointed)' },
        preferenceUpdates: { type: 'string', description: 'Any shifts in taste revealed by the conversation' }
      },
      required: ['satisfactionSignal']
    }
  }]
};

// These prompt-building functions are now replaced by prospero.js config
// Kept as reference but no longer used in createChatSession

/**
 * Create a new text chat session
 * @param {string} userId - The user's ID
 * @param {string} interviewType - 'onboarding', 'returning_user', or 'book_completion'
 * @param {object} context - Context for returning_user or book_completion
 * @returns {Promise<{sessionId: string, openingMessage: string}>}
 */
async function createChatSession(userId, interviewType, context = {}) {
  console.log(`📝 Creating text chat session for user ${userId}, type: ${interviewType}`);

  // Build system prompt using prospero.js config
  const systemPrompt = assemblePrompt(interviewType, 'text', context);
  const greeting = getGreeting(interviewType, context);

  // Determine tools based on interview type
  let tools;
  switch (interviewType) {
    case 'onboarding':
      tools = CHAT_TOOLS.onboarding;
      break;
    case 'returning_user':
      tools = CHAT_TOOLS.returning_user;
      break;
    case 'book_completion':
      tools = CHAT_TOOLS.book_completion;
      break;
    default:
      throw new Error(`Unknown interview type: ${interviewType}`);
  }

  console.log(`✅ System prompt assembled for ${interviewType} (text medium)`);
  console.log(`✅ Greeting from template: "${greeting.substring(0, 100)}..."`);

  // Store the conversation in messages array - use greeting directly
  const messages = [
    { role: 'assistant', content: greeting }
  ];

  // Create session in database
  const { data: session, error } = await supabaseAdmin
    .from('text_chat_sessions')
    .insert({
      user_id: userId,
      interview_type: interviewType,
      story_id: context.storyId || null,
      messages: messages,
      system_prompt: systemPrompt,
      context: context,
      status: 'active'
    })
    .select()
    .single();

  if (error) {
    console.error('❌ Failed to create chat session:', error);
    throw error;
  }

  console.log(`✅ Chat session created: ${session.id}`);
  return {
    sessionId: session.id,
    openingMessage: greeting
  };
}

/**
 * Send a message in an existing chat session
 * @param {string} sessionId - The session ID
 * @param {string} userMessage - The user's message
 * @returns {Promise<{message: string, toolCall: object|null, sessionComplete: boolean}>}
 */
async function sendMessage(sessionId, userMessage) {
  console.log(`💬 Sending message to session ${sessionId}: "${userMessage.substring(0, 50)}..."`);

  // Fetch session
  const { data: session, error: fetchError } = await supabaseAdmin
    .from('text_chat_sessions')
    .select('*')
    .eq('id', sessionId)
    .single();

  if (fetchError || !session) {
    console.error('❌ Session not found:', fetchError);
    throw new Error('Session not found');
  }

  // Append user message to conversation
  const messages = [...session.messages, { role: 'user', content: userMessage }];

  // Determine tools based on interview type
  const tools = CHAT_TOOLS[session.interview_type] || [];

  // Call Claude
  console.log('🤖 Calling Claude Messages API...');
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 64000,
    system: session.system_prompt,
    messages: messages,
    tools: tools
  });

  console.log(`✅ Claude responded with ${response.content.length} content blocks`);

  // Handle response
  let assistantMessage = '';
  let toolCall = null;
  let sessionComplete = false;

  // Check for text blocks
  const textBlocks = response.content.filter(block => block.type === 'text');
  if (textBlocks.length > 0) {
    assistantMessage = textBlocks.map(block => block.text).join('\n');
  }

  // Check for tool use
  const toolUseBlock = response.content.find(block => block.type === 'tool_use');
  if (toolUseBlock) {
    console.log(`🔧 Tool called: ${toolUseBlock.name}`);
    toolCall = {
      name: toolUseBlock.name,
      arguments: toolUseBlock.input
    };
    sessionComplete = true;

    // Generate a farewell message
    console.log('👋 Generating farewell message...');
    const farewellMessages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: '[Tool submitted — give a brief, warm farewell that signals the end of our conversation]' }
    ];

    const farewellResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 64000,
      system: session.system_prompt,
      messages: farewellMessages
    });

    const farewellText = farewellResponse.content.find(block => block.type === 'text')?.text || '';
    assistantMessage = assistantMessage + (assistantMessage ? '\n\n' : '') + farewellText;
    console.log(`✅ Farewell message: "${farewellText.substring(0, 100)}..."`);
  }

  // Update messages array
  const updatedMessages = [
    ...messages,
    { role: 'assistant', content: assistantMessage }
  ];

  // Update session in database
  const updateData = {
    messages: updatedMessages,
    updated_at: new Date().toISOString()
  };

  if (sessionComplete) {
    updateData.status = 'completed';
    updateData.preferences_extracted = toolCall.arguments;
  }

  const { error: updateError } = await supabaseAdmin
    .from('text_chat_sessions')
    .update(updateData)
    .eq('id', sessionId);

  if (updateError) {
    console.error('❌ Failed to update session:', updateError);
    throw updateError;
  }

  console.log(`✅ Session updated. Complete: ${sessionComplete}`);

  return {
    message: assistantMessage,
    toolCall: toolCall,
    sessionComplete: sessionComplete
  };
}

/**
 * Get an existing chat session
 * @param {string} sessionId - The session ID
 * @returns {Promise<object>} - The full session object
 */
async function getChatSession(sessionId) {
  console.log(`📖 Fetching chat session: ${sessionId}`);

  const { data: session, error } = await supabaseAdmin
    .from('text_chat_sessions')
    .select('*')
    .eq('id', sessionId)
    .single();

  if (error || !session) {
    console.error('❌ Session not found:', error);
    throw new Error('Session not found');
  }

  console.log(`✅ Session fetched: ${session.interview_type}, status: ${session.status}`);
  return session;
}

module.exports = {
  createChatSession,
  sendMessage,
  getChatSession
};
