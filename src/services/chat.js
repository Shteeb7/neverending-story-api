const { anthropic } = require('../config/ai-clients');
const { supabaseAdmin } = require('../config/supabase');
const { assemblePrompt, getGreeting } = require('../config/prospero');
const peggy = require('../config/peggy');

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
        pacePreference: { type: 'string', description: '\'fast\' or \'slow\' or \'varied\'' },
        explicitRequest: { type: 'string', description: 'If the reader described a SPECIFIC story concept they want (not just general preferences), capture their full idea here verbatim. All three premises should be variations on this concept.' },
        storyDirection: { type: 'string', enum: ['comfort', 'stretch', 'wildcard', 'specific'], description: 'Set to \'specific\' if the reader described a concrete story idea. Otherwise omit.' }
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
  }],
  premise_rejection: [{
    name: 'submit_refined_request',
    description: 'Submit the refined story request after understanding what went wrong with the rejected premises. Call when you have a clearer picture of what the reader wants.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['comfort', 'stretch', 'wildcard', 'specific'], description: "'comfort' (more of what they love), 'stretch' (something adjacent), 'wildcard' (surprise me), or 'specific' (they have a specific idea in mind)" },
        moodShift: { type: 'string', description: "What they're in the mood for now — captures their current emotional state or reading context" },
        explicitRequest: { type: 'string', description: "If they described a SPECIFIC story concept, capture their FULL idea here verbatim — the richer the better. Include genre, setting, tone, character types, anything they specified. This field drives the next set of premises. Also use this for situational context like 'reading with my daughter' or 'beach vacation read'." },
        newInterests: { type: 'array', items: { type: 'string' }, description: 'Any new genres, themes, books, shows, or games they mentioned that signal a shift from their original preferences' },
        rejectionInsight: { type: 'string', description: "What specifically was wrong with the rejected premises — captures the diagnostic signal (e.g., 'too dark', 'wanted more humor', 'premises felt generic')" }
      },
      required: ['direction']
    }
  }],
  checkpoint: [{
    name: 'submit_checkpoint_feedback',
    description: 'Submit checkpoint feedback gathered from the reader. Call when the conversation is complete.',
    input_schema: {
      type: 'object',
      properties: {
        pacing_note: { type: 'string', description: 'Natural language summary of pacing feedback (e.g., "Reader feels hooked and engaged" or "Reader wants more action, less setup")' },
        tone_note: { type: 'string', description: 'Natural language summary of tone feedback (e.g., "Tone feels just right" or "Reader wants more humor")' },
        character_notes: { type: 'array', items: { type: 'string' }, description: 'Array of character observations (e.g., ["Loves the protagonist\'s wit", "Wants more vulnerability from supporting cast"])' },
        style_note: { type: 'string', description: 'Any prose or style observations (e.g., "Reader loves the vivid descriptions" or "Wants shorter paragraphs")' },
        overall_engagement: { type: 'string', enum: ['deeply_hooked', 'engaged', 'interested', 'lukewarm'], description: 'Overall engagement level' },
        raw_reader_quotes: { type: 'array', items: { type: 'string' }, description: 'Direct quotes from the reader that capture their raw reaction' }
      },
      required: ['overall_engagement']
    }
  }]
};

// Peggy tools for bug reports and suggestions
CHAT_TOOLS.bug_report = [
  {
    name: 'submit_bug_report',
    description: 'Submit the gathered bug report details. Call this when you have all the information about the bug.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-sentence description of the bug' },
        category: { type: 'string', enum: ['navigation', 'generation', 'reading', 'interview', 'visual', 'performance', 'feature_request', 'story_content', 'other'], description: 'Bug category' },
        severity_hint: { type: 'string', enum: ['critical', 'annoying', 'cosmetic', 'idea'], description: 'Severity level' },
        user_description: { type: 'string', description: 'Full description in user\'s words' },
        steps_to_reproduce: { type: 'string', description: 'Steps to reproduce the bug, if described' },
        expected_behavior: { type: 'string', description: 'What the user expected to happen' },
        sign_off_message: { type: 'string', description: 'Peggy\'s closing line' }
      },
      required: ['summary', 'category', 'severity_hint', 'user_description']
    }
  },
  {
    name: 'resolve_without_report',
    description: 'Use this when you\'ve successfully helped the user with their question using your app knowledge, and no bug report needs to be filed. Only call this when the user confirms your answer helped.',
    input_schema: {
      type: 'object',
      properties: {
        resolution_type: {
          type: 'string',
          enum: ['deflected', 'known_issue_acknowledged', 'redirected_to_prospero'],
          description: 'How the conversation was resolved'
        },
        matched_topic: {
          type: 'string',
          description: 'The feature or FAQ topic that matched (e.g., \'Release to the Mists\', \'Page mode reader settings\')'
        },
        user_satisfied: {
          type: 'boolean',
          description: 'Whether the user confirmed the answer helped'
        },
        sign_off_message: {
          type: 'string',
          description: 'Peggy\'s closing line'
        }
      },
      required: ['resolution_type', 'matched_topic', 'user_satisfied', 'sign_off_message']
    }
  }
];

CHAT_TOOLS.suggestion = [
  {
    name: 'submit_bug_report',
    description: 'Submit the gathered suggestion details. Call this when you have all the information about the feature request.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-sentence description of the suggestion' },
        category: { type: 'string', description: 'Should be "feature_request" for suggestions' },
        severity_hint: { type: 'string', description: 'Should be "idea" for suggestions' },
        user_description: { type: 'string', description: 'Full description in user\'s words' },
        steps_to_reproduce: { type: 'string', description: 'Not usually applicable for suggestions' },
        expected_behavior: { type: 'string', description: 'What the user envisions' },
        sign_off_message: { type: 'string', description: 'Peggy\'s closing line' }
      },
      required: ['summary', 'category', 'severity_hint', 'user_description']
    }
  },
  {
    name: 'resolve_without_report',
    description: 'Use this when you\'ve successfully helped the user with their question using your app knowledge, and no bug report needs to be filed. Only call this when the user confirms your answer helped.',
    input_schema: {
      type: 'object',
      properties: {
        resolution_type: {
          type: 'string',
          enum: ['deflected', 'known_issue_acknowledged', 'redirected_to_prospero'],
          description: 'How the conversation was resolved'
        },
        matched_topic: {
          type: 'string',
          description: 'The feature or FAQ topic that matched (e.g., \'Release to the Mists\', \'Page mode reader settings\')'
        },
        user_satisfied: {
          type: 'boolean',
          description: 'Whether the user confirmed the answer helped'
        },
        sign_off_message: {
          type: 'string',
          description: 'Peggy\'s closing line'
        }
      },
      required: ['resolution_type', 'matched_topic', 'user_satisfied', 'sign_off_message']
    }
  }
];

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

  // Determine persona based on interview type
  const peggyTypes = ['bug_report', 'suggestion'];
  const isPeggy = peggyTypes.includes(interviewType);

  let systemPrompt, greeting;
  if (isPeggy) {
    // Use Peggy persona for bug reports and suggestions
    systemPrompt = await peggy.assemblePrompt(interviewType, 'text', context);
    greeting = peggy.getGreeting(interviewType, context);
  } else {
    // Use Prospero persona for story interviews
    systemPrompt = assemblePrompt(interviewType, 'text', context);
    greeting = getGreeting(interviewType, context);
  }

  // Determine tools based on interview type
  let tools;
  switch (interviewType) {
    case 'onboarding':
      tools = CHAT_TOOLS.onboarding;
      break;
    case 'returning_user':
      tools = CHAT_TOOLS.returning_user;
      break;
    case 'premise_rejection':
      tools = CHAT_TOOLS.premise_rejection;
      break;
    case 'book_completion':
      tools = CHAT_TOOLS.book_completion;
      break;
    case 'checkpoint':
      tools = CHAT_TOOLS.checkpoint;
      break;
    case 'bug_report':
      tools = CHAT_TOOLS.bug_report;
      break;
    case 'suggestion':
      tools = CHAT_TOOLS.suggestion;
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

    // Handle resolve_without_report tool call
    if (toolUseBlock.name === 'resolve_without_report') {
      console.log('✅ Peggy deflected conversation — no bug report filed');
      // Log the deflection
      try {
        // Try to link deflection to the knowledge base entry that powered it
        let kbEntryId = null;
        try {
          const { data: kbEntry } = await supabaseAdmin
            .from('peggy_knowledge_base')
            .select('id')
            .eq('active', true)
            .ilike('title', `%${toolUseBlock.input.matched_topic}%`)
            .limit(1)
            .maybeSingle();
          kbEntryId = kbEntry?.id || null;
        } catch (lookupErr) {
          // Non-critical — proceed without linking
        }

        await supabaseAdmin.from('peggy_deflections').insert({
          user_id: session.user_id,
          resolution_type: toolUseBlock.input.resolution_type,
          matched_topic: toolUseBlock.input.matched_topic,
          user_satisfied: toolUseBlock.input.user_satisfied,
          interview_mode: 'text',
          knowledge_base_entry_id: kbEntryId
        });
        console.log(`📊 Deflection logged: ${toolUseBlock.input.matched_topic} (${toolUseBlock.input.resolution_type})`);
      } catch (err) {
        console.log('⚠️ Failed to log deflection (non-critical):', err.message);
      }
    }

    // Handle checkpoint feedback tool call server-side
    if (toolUseBlock.name === 'submit_checkpoint_feedback') {
      console.log('📊 Processing checkpoint feedback tool call...');
      const { triggerCheckpointGeneration } = require('../routes/feedback');

      const storyId = session.story_id;
      const userId = session.user_id;

      // Derive checkpoint from context, but VALIDATE it — iOS sometimes sends empty string
      // due to SwiftUI fullScreenCover capture timing. Fall back to deriving from generation_progress.
      let checkpoint = session.context?.checkpoint;
      if (!checkpoint) {
        console.warn('⚠️ Empty checkpoint in session context — deriving from generation_progress');
        const { data: storyForCheckpoint } = await supabaseAdmin
          .from('stories')
          .select('generation_progress')
          .eq('id', storyId)
          .single();

        const currentStep = storyForCheckpoint?.generation_progress?.current_step || '';
        // Map awaiting steps to checkpoint names
        if (currentStep === 'awaiting_chapter_5_feedback' || currentStep.includes('generating_chapter_7')) {
          checkpoint = 'chapter_5';
        } else if (currentStep === 'awaiting_chapter_8_feedback' || currentStep.includes('generating_chapter_10')) {
          checkpoint = 'chapter_8';
        } else {
          checkpoint = 'chapter_2'; // Only default to chapter_2 when we're actually at the first checkpoint
        }
        console.log(`📊 Derived checkpoint from generation_progress: ${checkpoint} (step was: ${currentStep})`);
      }

      if (storyId) {
        try {
          // Store structured feedback in story_feedback.checkpoint_corrections
          const { data: feedbackRow, error: feedbackError } = await supabaseAdmin
            .from('story_feedback')
            .upsert({
              user_id: userId,
              story_id: storyId,
              checkpoint: checkpoint,
              response: 'checkpoint_interview',
              checkpoint_corrections: toolUseBlock.input,
              voice_transcript: null,
              voice_session_id: null
            }, {
              onConflict: 'user_id,story_id,checkpoint'
            })
            .select()
            .single();

          if (feedbackError) {
            console.error('❌ Failed to store checkpoint feedback:', feedbackError);
          } else {
            console.log(`✅ Checkpoint feedback stored for ${checkpoint}`);

            // Trigger generation (non-blocking)
            await triggerCheckpointGeneration(storyId, userId, checkpoint);
          }
        } catch (err) {
          console.error('❌ Error processing checkpoint feedback:', err);
        }
      }
    }

    // Generate a farewell message
    // NOTE: We can't just append the raw response.content (which contains tool_use blocks)
    // and follow with a plain user message — Anthropic API requires a tool_result after tool_use.
    // Instead, use the sign_off_message from the tool call, or make a clean farewell call
    // with only text messages (no tool_use blocks).
    console.log('👋 Generating farewell message...');

    // First, try to use the sign_off_message from the tool call itself
    const signOff = toolCall?.arguments?.sign_off_message;
    if (signOff) {
      assistantMessage = assistantMessage + (assistantMessage ? '\n\n' : '') + signOff;
      console.log(`✅ Farewell from tool call: "${signOff.substring(0, 100)}..."`);
    } else {
      // Fallback: generate farewell using only text content (strip tool_use blocks)
      try {
        const textOnlyContent = assistantMessage || 'I\'ve submitted that for you.';

        // Use a more dramatic farewell prompt for onboarding interviews
        const isOnboarding = session.interview_type === 'onboarding';
        const farewellPrompt = isOnboarding
          ? '[Preferences submitted — Give a warm, magical farewell. ONE short paragraph only, 3-4 sentences max. You have everything you need. Signal the portal is about to open. Be mystical but concise.]'
          : '[Report submitted — give a brief, warm farewell that signals the end of our conversation]';

        const farewellMessages = [
          ...messages,
          { role: 'assistant', content: textOnlyContent },
          { role: 'user', content: farewellPrompt }
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
      } catch (farewellErr) {
        console.error('⚠️ Farewell generation failed (non-fatal):', farewellErr.message);
        // Non-fatal — session still completes, just without a custom farewell
        if (!assistantMessage) {
          assistantMessage = 'Thanks hon! We\'ll reach out if we need more info.';
        }
      }
    }
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

  // SERVER-SIDE PREMISE GENERATION for onboarding and premise_rejection text chat sessions.
  // Handle both first-time onboarding and returning users who rejected premises.
  if (sessionComplete && (session.interview_type === 'onboarding' || session.interview_type === 'premise_rejection') && toolCall?.arguments) {
    const userId = session.user_id;
    const isPremiseRejection = session.interview_type === 'premise_rejection';
    console.log(`📝 ${isPremiseRejection ? 'Premise rejection' : 'Onboarding'} text chat complete — ${isPremiseRejection ? 'generating refined premises' : 'saving preferences and generating premises'} for user ${userId}`);

    try {
      if (isPremiseRejection) {
        // For premise rejection: fetch existing prefs, merge with interview output,
        // then generate new premises through the new-story-request flow
        const { data: userPrefs } = await supabaseAdmin
          .from('user_preferences')
          .select('preferences, reading_level')
          .eq('user_id', userId)
          .maybeSingle();

        if (userPrefs) {
          const refinedRequest = toolCall.arguments;

          // Discard old premises
          await supabaseAdmin
            .from('story_premises')
            .update({ status: 'discarded' })
            .eq('user_id', userId)
            .neq('status', 'discarded');

          // Fetch previous titles for context
          const { data: existingStories } = await supabaseAdmin
            .from('stories')
            .select('title')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(5);
          const previousTitles = existingStories?.map(s => s.title).filter(Boolean) || [];

          // Build enriched preferences — merge existing prefs with interview output
          const enrichedPreferences = {
            ...userPrefs.preferences,
            storyDirection: refinedRequest.direction || 'comfort',
            moodShift: refinedRequest.moodShift || null,
            explicitRequest: refinedRequest.explicitRequest || null,
            newInterests: refinedRequest.newInterests || [],
            rejectionInsight: refinedRequest.rejectionInsight || null,
            previousStoryTitles: previousTitles,
            isReturningUser: true
          };

          // PERSIST enriched preferences so "show me more" / regenerate calls
          // carry the interview context forward (fixes "genre lock" bug)
          await supabaseAdmin
            .from('user_preferences')
            .update({
              preferences: enrichedPreferences,
              updated_at: new Date().toISOString()
            })
            .eq('user_id', userId);

          console.log('🔄 Generating refined premises after rejection (enriched prefs persisted):', {
            direction: enrichedPreferences.storyDirection,
            explicitRequest: enrichedPreferences.explicitRequest?.substring(0, 80),
            rejectionInsight: enrichedPreferences.rejectionInsight?.substring(0, 80)
          });

          const { generatePremises } = require('./generation');
          generatePremises(userId, enrichedPreferences)
            .then(result => {
              console.log(`✅ Refined premises generated after rejection: ${result.premises?.length || 0} premises`);
            })
            .catch(err => {
              console.error('❌ Premise generation after rejection failed:', err.message);
            });
        }
      } else {
        // Original onboarding flow — save preferences and generate
        const extractedPrefs = toolCall.arguments;
        const { error: prefsError } = await supabaseAdmin
          .from('user_preferences')
          .upsert({
            user_id: userId,
            preferences: extractedPrefs,
            reading_level: extractedPrefs.readingLevel || 'adult',
            updated_at: new Date().toISOString()
          }, { onConflict: 'user_id' });

        if (prefsError) {
          console.error('❌ Failed to save text chat preferences:', prefsError);
        } else {
          console.log('✅ Text chat preferences saved to user_preferences');
        }

        const { generatePremises } = require('./generation');
        generatePremises(userId, extractedPrefs)
          .then(result => {
            console.log(`✅ Premises generated after text chat: ${result.premises?.length || 0} premises`);
          })
          .catch(err => {
            console.error('❌ Premise generation after text chat failed:', err.message);
          });
      }
    } catch (err) {
      console.error(`❌ Post-${isPremiseRejection ? 'rejection' : 'onboarding'} text chat processing failed:`, err.message);
    }
  }

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
