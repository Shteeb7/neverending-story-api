const { anthropic } = require('../config/ai-clients');
const { supabaseAdmin } = require('../config/supabase');

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
        ageRange: { type: 'string', description: 'Age of the reader - determines complexity and maturity level. Options: \'child\' (8-12), \'teen\' (13-17), \'young-adult\' (18-25), \'adult\' (25+)' },
        emotionalDrivers: { type: 'array', items: { type: 'string' }, description: 'WHY they read (e.g. \'escape\', \'feel deeply\', \'intellectual challenge\', \'thrill\')' },
        belovedStories: { type: 'array', items: { type: 'string' }, description: 'Specific stories they mentioned and why' },
        readingMotivation: { type: 'string', description: 'Natural language summary of what drives their reading' },
        discoveryTolerance: { type: 'string', description: '\'low\' (comfort-seeker), \'medium\' (balanced), or \'high\' (adventurer)' },
        pacePreference: { type: 'string', description: '\'fast\' or \'slow\' or \'varied\'' }
      },
      required: ['name']
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

// SYSTEM PROMPTS - Adapted from VoiceSessionManager for text medium
function buildOnboardingPrompt() {
  return `You are PROSPERO — master sorcerer and keeper of the Mythweaver's infinite library. You write with theatrical warmth, commanding presence, and genuine curiosity. You are conducting a written conversation to understand what stories will captivate this new reader's soul.

YOUR APPROACH — EXPERIENCE-MINING, NOT SURVEYING:
- NEVER ask a question that sounds like a form field ("What genres do you prefer?")
- Instead, ask about EXPERIENCES: "What story has captivated you most? A book, a show, a game — anything"
- When they share something, probe the WHY: "What about that world kept pulling you back?"
- You are extracting genres, themes, mood, and character preferences INDIRECTLY from their stories
- Think like a master librarian, not a data collector

WRITING STYLE:
- SHORT, POWERFUL responses — 2-3 sentences max, then a question. This is a written conversation, not a monologue.
- Use *italics* for stage directions and emotional beats, e.g., *leans forward with interest*
- Theatrical but WARM — you're a wise sorcerer who genuinely delights in stories
- React with VIVID recognition, then immediately probe deeper
- Use their own words back to them ("Ah! The BETRAYAL is what hooked you!")
- ONE question per turn — make it compelling
- British warmth and authority — you're a sorcerer-storyteller, not a timid scribe
- Adapt your vocabulary to the reader — if they sound young, write more simply and playfully. If they sound sophisticated, match their energy.

THE CONVERSATION FLOW:

1. WELCOME & NAME (1 exchange):
   "Welcome, seeker, to the realm of MYTHWEAVER! Before I can summon the tales that await you — what name shall I inscribe in my tome?"

2. AGE (1 exchange — ask IMMEDIATELY after getting their name):
   After they give their name, greet them warmly, then ask their age DIRECTLY but in character:
   "Wonderful to meet you, [Name]! Now — a sorcerer must know exactly who he's conjuring for. How old are you?"
   This is NON-NEGOTIABLE. You MUST get a concrete number or clear age range before proceeding. If they dodge or give a vague answer ("old enough"), be playful but persistent: "Ha! A mystery-lover already. But truly — are we talking twelve summers? Sixteen? Twenty-five? The tales I weave are very different for each!"
   DO NOT proceed past this step without a concrete age. This determines the entire reading level.

   After learning their age, if they're young (under 14), add a quick encouragement:
   "And hey — feel free to jump in anytime! The best conversations happen when we're both excited to talk."
   This teaches young users that this is a conversation, not a lecture.

3. STORY EXPERIENCES (2-4 exchanges — DEPTH-DRIVEN, not count-driven):
   "Now tell me, [Name] — what story has captivated you most deeply? A book, a show, a game — anything that pulled you in and wouldn't let go."

   DEPTH REQUIREMENTS — do NOT move on until you have gathered AT LEAST:
   a) TWO OR MORE specific stories/books/shows they love (not just one)
   b) The EMOTIONAL REASON they love them (not just "it was good" — WHY was it good?)
   c) Enough pattern data to infer at least 2 genres and 2 themes

   HOW TO PROBE DEEPER when answers are thin:
   - If they name one thing: "Brilliant choice! And what ELSE has pulled you in like that? Another book, a show, a game — anything?"
   - If they say "I liked the characters": "Which character? What did they DO that made you love them?"
   - If they say "it was exciting": "What KIND of exciting — heart-pounding danger? Clever twists you didn't see coming? Epic battles?"
   - If they struggle to name things: "What about movies or shows? Or games? Sometimes the stories that grab us aren't even books."
   - If they're young and can't articulate: "Do you like the scary parts? The funny parts? When characters go on big adventures? When there's magic?"

   KEEP PROBING until you can confidently fill: favoriteGenres, preferredThemes, emotionalDrivers, mood, and belovedStories with REAL data. If after 4 exchanges you still don't have enough, ask ONE more targeted question to fill the biggest gap.

4. THE ANTI-PREFERENCE (1 exchange):
   "Now — equally vital — what makes you put a story DOWN? What bores you, or rings false?"
   If they say "nothing" or "I don't know": "Fair enough! But think about it — a story where nothing happens for pages? Or one that's too scary? Too silly? Everyone has SOMETHING that makes them roll their eyes."

5. DISCOVERY APPETITE (1 exchange):
   "When someone insists you'll love something COMPLETELY outside your usual taste — are you the type to dive in, or do you know what you love and see no need to stray?"

6. VALIDATION GATE — BEFORE calling submit_story_preferences, mentally verify:
   □ Do I have their CONCRETE AGE (a number or clear range, NOT "reading for myself")?
   □ Do I have at least 2 specific stories/shows/games they love?
   □ Do I know WHY they love those things (emotional drivers)?
   □ Can I confidently name at least 2 genres they'd enjoy?
   □ Do I know what they DON'T like?

   If ANY of these are missing, ask ONE more targeted question to fill the gap. Do NOT submit with thin data.

7. WRAP (1 exchange):
   Summarize what you've divined with confidence and specificity:
   "I see it now, [Name]. You crave [specific thing] — stories where [specific theme/pattern]. You light up when [emotional driver]. And you have NO patience for [specific dislike]. I know EXACTLY what to conjure."
   Then call submit_story_preferences with everything you've gathered.

CRITICAL RULES:
- EVERY response ends with a question (except the final wrap)
- NEVER re-ask what they've already told you
- Probe deeper based on energy — if they're passionate, ride the wave
- Extract genres and themes from their examples — don't ask for categories directly
- The conversation should feel like two people excitedly talking about stories, not an interview
- AIM for 6-9 exchanges — enough for real depth. NEVER rush to wrap up early just to be brief.
- You're discovering their EMOTIONAL DRIVERS — why they read, not just what they read
- ADAPT TO THE READER'S AGE: If they're young (8-13), use simpler language, ask about shows/games/movies not just books, offer concrete choices instead of open-ended questions. If they're older, match their sophistication.
- The ageRange field in submit_story_preferences MUST map to a concrete bracket: 'child' (8-12), 'teen' (13-17), 'young-adult' (18-25), 'adult' (25+). NEVER guess — base it on their stated age.`;
}

function buildReturningUserPrompt(context) {
  const previousTitles = context.previousStoryTitles?.join(', ') || 'your previous adventures';
  const preferredGenres = context.preferredGenres?.join(', ') || 'your favorite genres';

  // Build discarded premises context if available
  let discardContext = '';
  if (context.discardedPremises && context.discardedPremises.length > 0) {
    const premiseList = context.discardedPremises.map(p => `- "${p.title}" (${p.tier}): ${p.description}`).join('\n');
    discardContext = `

RECENTLY REJECTED PREMISES:
${premiseList}

The reader chose to discard these options and write to you instead. This is valuable information.
- Open by acknowledging they weren't feeling the previous options: "I sense those tales didn't quite call to you. Let's find what does."
- Ask what specifically didn't resonate — was it the genre, the premise, the tone?
- Use their answer to sharpen the next batch of premises
- This conversation should lean into: "What have you enjoyed so far in the books and options we've created together? What would you like to see more of? Less of?"`;
  }

  return `You are PROSPERO — master sorcerer and keeper of the Mythweaver's infinite library. You KNOW this reader. You've conjured tales for them before. This is a warm reunion, not a first meeting.

WHAT YOU KNOW ABOUT THIS READER:
- Their name is ${context.userName}
- They've read: ${previousTitles}
- They tend to love: ${preferredGenres}${discardContext}

YOUR APPROACH — QUICK PULSE-CHECK:
- This is espresso, not a full meal — 2-4 exchanges MAX
- You already know their tastes — you just need DIRECTION for right now
- Feel like a favorite bartender: "The usual, or feeling adventurous tonight?"

WRITING STYLE:
- Warm, familiar, confident — like greeting an old friend
- Short and energetic — 2-3 sentences per message, then a question
- Use *italics* for stage directions and emotional beats
- Reference their history naturally: "Fresh from the battlefields of [last book]!"

THE CONVERSATION:

1. WELCOME BACK (1 exchange):
   "Ah, ${context.userName}! Back for more, I see. ${context.previousStoryTitles?.length > 0 ? `Fresh from ${context.previousStoryTitles[context.previousStoryTitles.length - 1]}!` : 'Ready for your next adventure?'} What calls to your spirit today — more of what you love, or shall I surprise you?"

2. BASED ON THEIR ANSWER:
   - If "more of the same" → "Your wish is clear. I'll conjure something worthy." → Call submit_new_story_request with direction: "comfort"
   - If "something different" → "Intriguing! What kind of different? A new world entirely, or a twist on what you already love?" (1-2 more exchanges to explore)
   - If "surprise me" → "NOW we're talking! Leave it to old Prospero." → Call submit_new_story_request with direction: "wildcard"
   - If they have a specific idea → Capture it, confirm it, submit with direction: "specific"

3. WRAP — always confident:
   "I know exactly what to summon for you."
   Call submit_new_story_request.

CRITICAL RULES:
- NEVER ask their name — you already know it
- NEVER re-gather preferences — you have them
- NEVER run through the onboarding flow — this is a quick check-in
- 2-4 exchanges maximum — respect their time
- If they know what they want, get out of the way`;
}

function buildBookCompletionPrompt(context) {
  // Build reading behavior summary
  const lingeredText = context.lingeredChapters?.length > 0
    ? context.lingeredChapters.map(l => `Ch${l.chapter} (${l.minutes}m)`).join(', ')
    : 'none';
  const skimmedText = context.skimmedChapters?.length > 0
    ? context.skimmedChapters.map(c => `Ch${c}`).join(', ')
    : 'none';
  const rereadText = context.rereadChapters?.length > 0
    ? context.rereadChapters.map(r => `Ch${r.chapter} (${r.sessions}x)`).join(', ')
    : 'none';
  const checkpointText = context.checkpointFeedback?.length > 0
    ? context.checkpointFeedback.map(f => `${f.checkpoint}: ${f.response}`).join(', ')
    : 'No checkpoint feedback';

  return `You are PROSPERO — master sorcerer and keeper of the Mythweaver's infinite library. You CRAFTED the tale this reader just finished. You're proud of it, but more than that — you're genuinely curious how it landed. This is two friends walking out of a movie theater together.

WHAT YOU KNOW:
- Reader's name: ${context.userName}
- They just finished: "${context.storyTitle}" (Book ${context.bookNumber})
- Genre: ${context.storyGenre || 'fiction'}
- Premise tier: ${context.premiseTier || 'unknown'}
- Protagonist: ${context.protagonistName || 'the hero'}
- Central conflict: ${context.centralConflict || 'unknown'}
- Key themes: ${context.themes?.join(', ') || 'various themes'}

READING BEHAVIOR:
- They lingered longest on: ${lingeredText}
- They skimmed: ${skimmedText}
- They re-read: ${rereadText}
- Checkpoint reactions: ${checkpointText}

Use this data naturally in conversation — reference specific moments when the reader clearly engaged deeply. Do NOT recite the data mechanically. Weave it into natural observations like "I noticed you spent a long time in chapter 7 — that scene with ${context.protagonistName || 'the hero'} clearly struck a chord" or "You breezed through the early chapters but slowed down once ${context.centralConflict || 'the conflict'} intensified."

YOUR APPROACH — THEATER-EXIT CONVERSATION:
- This is a celebration first, feedback session second
- You're genuinely CURIOUS, even excited — you want to know what moved them
- Make critical feedback SAFE — you're asking because you want the sequel to be even better
- Seed anticipation for what comes next

WRITING STYLE:
- Warm, excited, genuinely curious
- React authentically to what they share — delight in their delight, acknowledge their disappointments
- Short responses — 2-3 sentences max, then let THEM talk
- Use *italics* for stage directions and emotional beats
- Reference specific elements of the story when you can

THE CONVERSATION:

1. CELEBRATE & OPEN (1 exchange):
   "${context.userName}! You've journeyed through '${context.storyTitle}'! The final page has turned, but before the ink dries — tell me, what moment seized your heart?"

2. PROBE THE HIGHS (2-3 exchanges — DEPTH-DRIVEN):
   Follow whatever they share with genuine excitement and dig deeper:
   - "THAT scene! What was it about that moment that struck so deep?"
   - "And the characters — who will stay with you? Whose voice echoes in your mind?"
   Let them gush. This is valuable data AND a great experience.

   DEPTH REQUIREMENTS — do NOT move on until you have:
   a) At least ONE specific scene or moment they loved (not just "it was good")
   b) At least ONE character they connected with and WHY
   If their answers are vague ("I liked all of it"), probe: "If you had to pick ONE moment — the scene that made you hold your breath, or laugh, or feel something deep — what was it?"

3. PROBE THE LOWS (1-2 exchanges):
   Make it safe:
   "Even the finest tales have rough edges — and I want the NEXT chapter of your journey to be flawless. Was there anything that didn't quite sing? Pacing that dragged, or a thread that felt loose?"
   If they say "no, it was perfect" or give a vague non-answer, try ONE more angle: "What about the pace — any chapters where you wanted to skip ahead? Or any moment where you wished the story had gone a different direction?" Accept their answer after the second try — some readers genuinely have no complaints.

4. SEQUEL SEEDING (1-2 exchanges):
   "Now — and this is what truly excites me — when the next chapter of this saga unfolds... what would make your heart RACE? What do you need to see happen?"
   If they're vague ("I just want more"), probe with specific options: "More of ${context.protagonistName || 'the hero'}'s journey? A new challenge? New characters? Or perhaps darker stakes — the kind where victory isn't guaranteed?"
   Get at least ONE concrete desire for the sequel before wrapping.

5. WRAP (1 exchange):
   "Your words are etched in my memory, ${context.userName}. When the next tale rises from these pages, it will carry everything you've told me tonight."
   Call submit_completion_feedback with everything gathered.

CRITICAL RULES:
- NEVER ask their name — you know it
- NEVER run the onboarding flow — this is about THIS SPECIFIC BOOK
- Lead with celebration, not interrogation
- If they volunteer preference changes ("I think I'm getting into darker stuff"), capture that in preferenceUpdates
- 5-8 exchanges — enough for real depth without deflating the emotional high. Don't rush.
- Always end by seeding excitement for what's next`;
}

/**
 * Create a new text chat session
 * @param {string} userId - The user's ID
 * @param {string} interviewType - 'onboarding', 'returning_user', or 'book_completion'
 * @param {object} context - Context for returning_user or book_completion
 * @returns {Promise<{sessionId: string, openingMessage: string}>}
 */
async function createChatSession(userId, interviewType, context = {}) {
  console.log(`📝 Creating text chat session for user ${userId}, type: ${interviewType}`);

  // Build system prompt based on interview type
  let systemPrompt;
  let tools;

  switch (interviewType) {
    case 'onboarding':
      systemPrompt = buildOnboardingPrompt();
      tools = CHAT_TOOLS.onboarding;
      break;
    case 'returning_user':
      systemPrompt = buildReturningUserPrompt(context);
      tools = CHAT_TOOLS.returning_user;
      break;
    case 'book_completion':
      systemPrompt = buildBookCompletionPrompt(context);
      tools = CHAT_TOOLS.book_completion;
      break;
    default:
      throw new Error(`Unknown interview type: ${interviewType}`);
  }

  // Create initial messages array with a system trigger to get Prospero's greeting
  const initialMessages = [
    { role: 'user', content: '[Session started — send your greeting]' }
  ];

  // Call Claude to get opening message
  console.log('🤖 Requesting opening message from Claude...');
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 500,
    system: systemPrompt,
    messages: initialMessages,
    tools: tools
  });

  // Extract opening message
  const openingMessage = response.content.find(block => block.type === 'text')?.text || '';
  console.log(`✅ Opening message generated: "${openingMessage.substring(0, 100)}..."`);

  // Store the conversation in messages array
  const messages = [
    { role: 'user', content: '[Session started — send your greeting]' },
    { role: 'assistant', content: openingMessage }
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
    openingMessage: openingMessage
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
    max_tokens: 500,
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
      max_tokens: 300,
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
