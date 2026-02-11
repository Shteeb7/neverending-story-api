const { anthropic } = require('../config/ai-clients');
const { supabaseAdmin } = require('../config/supabase');

// Claude Opus 4.6 pricing (per million tokens)
const PRICING = {
  INPUT_PER_MILLION: 15,
  OUTPUT_PER_MILLION: 75,
  MODEL: 'claude-opus-4-6'
};

/**
 * Calculate cost in USD for Claude API call
 */
function calculateCost(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1_000_000) * PRICING.INPUT_PER_MILLION;
  const outputCost = (outputTokens / 1_000_000) * PRICING.OUTPUT_PER_MILLION;
  return inputCost + outputCost;
}

/**
 * Log API cost to database
 */
async function logApiCost(userId, operation, inputTokens, outputTokens, metadata = {}) {
  const totalTokens = inputTokens + outputTokens;
  const cost = calculateCost(inputTokens, outputTokens);

  try {
    await supabaseAdmin
      .from('api_costs')
      .insert({
        user_id: userId,
        story_id: metadata.storyId || null,
        provider: 'claude',
        model: PRICING.MODEL,
        operation,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        cost,
        metadata,
        created_at: new Date().toISOString()
      });
  } catch (error) {
    // Don't throw on cost logging failures - log to console instead
    console.error('Failed to log API cost:', error);
  }
}

/**
 * Parse and validate JSON response from Claude
 * Handles both raw JSON and markdown-wrapped JSON (```json ... ```)
 */
function parseAndValidateJSON(jsonString, requiredFields = []) {
  let parsed;

  // DEBUG: Log raw input details
  console.log('🔍 DEBUG parseAndValidateJSON:');
  console.log(`   Input length: ${jsonString.length} chars`);
  console.log(`   First 100 chars: "${jsonString.substring(0, 100)}"`);
  console.log(`   Last 50 chars: "${jsonString.substring(Math.max(0, jsonString.length - 50))}"`);

  // Step 1: Trim input to remove leading/trailing whitespace
  const trimmed = jsonString.trim();
  console.log(`   After trim length: ${trimmed.length} chars`);

  // Step 2: Try direct JSON.parse() first (handles raw JSON)
  try {
    parsed = JSON.parse(trimmed);
    console.log('   ✅ Direct JSON.parse() succeeded');
  } catch (e) {
    console.log(`   ❌ Direct JSON.parse() failed: ${e.message}`);

    // Step 3: Try to extract JSON from markdown code blocks
    // Matches: ```json\n{...}\n``` or ```{...}``` or incomplete blocks like ```json\n{...}
    // The closing ``` is optional (?:\n?```)? and anchored to end of string with $
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)(?:\n?```)?$/);

    console.log(`   Markdown regex match: ${codeBlockMatch ? 'SUCCESS' : 'FAILED'}`);
    if (codeBlockMatch) {
      console.log(`   Captured groups: ${codeBlockMatch.length}`);
      console.log(`   Group[1] length: ${codeBlockMatch[1]?.length || 0} chars`);
      console.log(`   Group[1] first 100: "${codeBlockMatch[1]?.substring(0, 100)}"`);
    }

    if (codeBlockMatch && codeBlockMatch[1]) {
      // Step 4: Parse the extracted JSON content
      const extracted = codeBlockMatch[1].trim();
      console.log(`   Attempting to parse extracted content (${extracted.length} chars)...`);

      try {
        parsed = JSON.parse(extracted);
        console.log('   ✅ Markdown extraction and parse succeeded');
      } catch (e2) {
        console.log(`   ❌ Failed to parse extracted JSON: ${e2.message}`);
        throw new Error(`Failed to parse JSON from markdown block: ${e2.message}`);
      }
    } else {
      // No markdown block found, throw original error
      console.log('   ❌ No markdown block found, throwing error');
      throw new Error(`Failed to parse JSON: ${e.message}`);
    }
  }

  console.log('   ✅ Parsing complete, validating required fields...');

  // Validate required fields if specified
  for (const field of requiredFields) {
    if (!(field in parsed)) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  console.log('   ✅ Validation complete\n');
  return parsed;
}

/**
 * Call Claude API with retry logic
 */
async function callClaudeWithRetry(messages, maxTokens, metadata = {}, attempts = 3) {
  let lastError;
  const delays = [0, 1000, 2000]; // Exponential backoff: 0s, 1s, 2s

  for (let i = 0; i < attempts; i++) {
    try {
      // Wait before retry (except first attempt)
      if (i > 0 && delays[i]) {
        await new Promise(resolve => setTimeout(resolve, delays[i]));
      }

      const response = await anthropic.messages.create({
        model: PRICING.MODEL,
        max_tokens: maxTokens,
        messages
      });

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const cost = calculateCost(inputTokens, outputTokens);

      return {
        response: response.content[0].text,
        inputTokens,
        outputTokens,
        cost
      };
    } catch (error) {
      lastError = error;

      // Retry on rate limits, overloaded errors, or network timeouts
      const shouldRetry =
        error.status === 529 ||
        error.type === 'overloaded_error' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNRESET';

      if (!shouldRetry || i === attempts - 1) {
        throw error;
      }

      console.log(`Claude API call failed (attempt ${i + 1}/${attempts}):`, error.message);
    }
  }

  throw lastError;
}

/**
 * Update story generation progress
 */
async function updateGenerationProgress(storyId, progressData) {
  const { error } = await supabaseAdmin
    .from('stories')
    .update({
      generation_progress: {
        ...progressData,
        last_updated: new Date().toISOString()
      }
    })
    .eq('id', storyId);

  if (error) {
    console.error('Failed to update generation progress:', error);
  }
}

/**
 * Generate 3 story premises from user preferences
 */
async function generatePremises(userId, preferences) {
  const { favorite_series = [], favorite_genres = [], loved_elements = [], disliked_elements = [] } = preferences;

  const prompt = `You are an expert children's book author specializing in creating engaging stories for ages 8-12.

Based on the following user preferences, generate 3 unique and compelling story premises:

Favorite Series: ${favorite_series.join(', ') || 'None specified'}
Favorite Genres: ${favorite_genres.join(', ') || 'None specified'}
Loved Elements: ${loved_elements.join(', ') || 'None specified'}
Elements to Avoid: ${disliked_elements.join(', ') || 'None specified'}

Create 3 distinct story premises that:
1. Incorporate the loved elements naturally
2. Avoid all disliked elements
3. Are appropriate for ages 8-12
4. Have strong hooks that grab attention
5. Are different from each other in tone and setting

Return ONLY a JSON object in this exact format:
{
  "premises": [
    {
      "title": "Story Title",
      "description": "2-3 sentence compelling description of the story",
      "hook": "One sentence that makes kids want to read it",
      "genre": "primary genre",
      "themes": ["theme1", "theme2", "theme3"],
      "age_range": "8-12"
    }
  ]
}`;

  const messages = [{ role: 'user', content: prompt }];

  const { response, inputTokens, outputTokens } = await callClaudeWithRetry(
    messages,
    64000,
    { operation: 'generate_premises', userId }
  );

  await logApiCost(userId, 'generate_premises', inputTokens, outputTokens, { preferences });

  const parsed = parseAndValidateJSON(response, ['premises']);

  if (!Array.isArray(parsed.premises) || parsed.premises.length !== 3) {
    throw new Error('Expected exactly 3 premises');
  }

  // Store in database
  const { data, error } = await supabaseAdmin
    .from('story_premises')
    .insert({
      user_id: userId,
      premises: parsed.premises,
      status: 'offered',
      preferences_used: preferences,
      generated_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to store premises: ${error.message}`);
  }

  return {
    premises: parsed.premises,
    premisesId: data.id
  };
}

/**
 * Generate comprehensive story bible from selected premise
 */
async function generateStoryBible(premiseId, userId) {
  // Fetch premise and user preferences
  const { data: premiseData, error: premiseError } = await supabaseAdmin
    .from('story_premises')
    .select('premises, preferences_used')
    .eq('id', premiseId)
    .single();

  if (premiseError || !premiseData) {
    throw new Error('Premise not found');
  }

  // The premise is stored as an array, we need to get the selected one
  // For now, we'll use the first one (this should be updated to handle selection)
  const premise = Array.isArray(premiseData.premises) ? premiseData.premises[0] : premiseData.premises;

  const prompt = `You are an expert world-builder and story architect for children's fiction.

Create a comprehensive story bible for this premise:

Title: ${premise.title}
Description: ${premise.description}
Genre: ${premise.genre}
Themes: ${premise.themes.join(', ')}

The story bible should include:

1. WORLD RULES: The fundamental rules of this story's world (magic systems, technology, society structure)
2. CHARACTERS:
   - Protagonist: Name, age, personality, strengths, flaws, goals, fears
   - Antagonist: Name, motivation, methods, backstory
   - Supporting Characters: 2-3 key supporting characters with roles and personalities
3. CENTRAL CONFLICT: The main problem/challenge the protagonist must overcome
4. STAKES: What happens if the protagonist fails? What's at risk?
5. THEMES: Core themes to explore throughout the story
6. KEY LOCATIONS: 3-5 important settings with descriptions
7. TIMELINE: Story timeframe and key events

Create a rich, consistent world that will support a 12-chapter story for ages 8-12.

Return ONLY a JSON object in this exact format:
{
  "title": "${premise.title}",
  "world_rules": {
    "magic_system": "description if applicable",
    "technology_level": "description",
    "society_structure": "description",
    "unique_rules": ["rule1", "rule2"]
  },
  "characters": {
    "protagonist": {
      "name": "string",
      "age": number,
      "personality": "string",
      "strengths": ["strength1", "strength2"],
      "flaws": ["flaw1", "flaw2"],
      "goals": "string",
      "fears": "string"
    },
    "antagonist": {
      "name": "string",
      "motivation": "string",
      "methods": "string",
      "backstory": "string"
    },
    "supporting": [
      {
        "name": "string",
        "role": "string",
        "personality": "string"
      }
    ]
  },
  "central_conflict": {
    "description": "string",
    "inciting_incident": "string",
    "complications": ["complication1", "complication2"]
  },
  "stakes": {
    "personal": "string",
    "broader": "string",
    "emotional": "string"
  },
  "themes": ["theme1", "theme2", "theme3"],
  "key_locations": [
    {
      "name": "string",
      "description": "string",
      "significance": "string"
    }
  ],
  "timeline": {
    "total_duration": "string",
    "key_milestones": ["milestone1", "milestone2"]
  }
}`;

  const messages = [{ role: 'user', content: prompt }];

  const { response, inputTokens, outputTokens } = await callClaudeWithRetry(
    messages,
    64000,
    { operation: 'generate_bible', userId, premiseId }
  );

  const parsed = parseAndValidateJSON(response, [
    'title', 'world_rules', 'characters', 'central_conflict',
    'stakes', 'themes', 'key_locations', 'timeline'
  ]);

  // Step 1: Create story record FIRST (bible table requires story_id foreign key)
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .insert({
      user_id: userId,
      premise_id: premiseId,
      title: parsed.title,
      status: 'active',  // Use 'active' - generation_progress tracks actual status
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
    throw new Error(`Failed to create story: ${storyError.message}`);
  }

  // Step 2: Store bible in database with story_id
  const { data: bible, error: bibleError } = await supabaseAdmin
    .from('story_bibles')
    .insert({
      user_id: userId,
      premise_id: premiseId,
      story_id: story.id,  // Required NOT NULL
      content: parsed,  // Required NOT NULL - JSONB type, store structured data
      title: parsed.title,
      world_rules: parsed.world_rules,
      characters: parsed.characters,
      central_conflict: parsed.central_conflict,
      stakes: parsed.stakes,
      themes: parsed.themes,
      key_locations: parsed.key_locations,
      timeline: parsed.timeline
    })
    .select()
    .single();

  if (bibleError) {
    throw new Error(`Failed to store bible: ${bibleError.message}`);
  }

  // Step 3: Update story with bible_id now that bible is created
  const { error: updateError } = await supabaseAdmin
    .from('stories')
    .update({
      bible_id: bible.id,
      generation_progress: {
        bible_complete: true,
        arc_complete: false,
        chapters_generated: 0,
        current_step: 'bible_created',
        last_updated: new Date().toISOString()
      }
    })
    .eq('id', story.id);

  if (updateError) {
    throw new Error(`Failed to update story with bible_id: ${updateError.message}`);
  }

  await logApiCost(userId, 'generate_bible', inputTokens, outputTokens, {
    storyId: story.id,
    premiseId
  });

  return {
    bible: parsed,
    storyId: story.id
  };
}

/**
 * Generate 12-chapter arc outline
 */
async function generateArcOutline(storyId, userId) {
  // Fetch story and bible
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select(`
      *,
      bible:story_bibles(*)
    `)
    .eq('id', storyId)
    .single();

  if (storyError || !story) {
    throw new Error('Story not found');
  }

  const bible = story.bible;

  const prompt = `You are an expert story structure designer for children's fiction.

Using this story bible, create a detailed 12-chapter outline following a classic 3-act structure:

TITLE: ${bible.title}

PROTAGONIST: ${bible.characters.protagonist.name}, age ${bible.characters.protagonist.age}
Goals: ${bible.characters.protagonist.goals}
Fears: ${bible.characters.protagonist.fears}

ANTAGONIST: ${bible.characters.antagonist.name}
Motivation: ${bible.characters.antagonist.motivation}

CENTRAL CONFLICT: ${bible.central_conflict.description}

STAKES: ${bible.stakes.personal}

Create a 12-chapter outline that:
- Follows 3-act structure (Setup: Ch 1-4, Confrontation: Ch 5-9, Resolution: Ch 10-12)
- Each chapter builds tension and advances the plot
- Includes character development moments
- Has appropriate pacing for ages 8-12
- Each chapter is 2500-3500 words

Return ONLY a JSON object in this exact format:
{
  "chapters": [
    {
      "chapter_number": 1,
      "title": "Chapter Title",
      "events_summary": "2-3 sentence summary of what happens",
      "character_focus": "Which character(s) are featured",
      "tension_level": "low/medium/high",
      "key_revelations": ["revelation1", "revelation2"],
      "word_count_target": 3000
    }
  ],
  "pacing_notes": "Overall pacing strategy",
  "story_threads": {
    "main_plot": "description",
    "subplots": ["subplot1", "subplot2"]
  }
}`;

  const messages = [{ role: 'user', content: prompt }];

  const { response, inputTokens, outputTokens } = await callClaudeWithRetry(
    messages,
    64000,
    { operation: 'generate_arc', userId, storyId }
  );

  const parsed = parseAndValidateJSON(response, ['chapters', 'pacing_notes', 'story_threads']);

  if (!Array.isArray(parsed.chapters) || parsed.chapters.length !== 12) {
    throw new Error('Expected exactly 12 chapters in arc outline');
  }

  // Store arc in database
  const { data: arc, error: arcError } = await supabaseAdmin
    .from('story_arcs')
    .insert({
      story_id: storyId,
      bible_id: bible.id,
      chapters: parsed.chapters,
      pacing_notes: parsed.pacing_notes,
      story_threads: parsed.story_threads,
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  if (arcError) {
    throw new Error(`Failed to store arc: ${arcError.message}`);
  }

  // Update story progress
  await updateGenerationProgress(storyId, {
    bible_complete: true,
    arc_complete: true,
    chapters_generated: 0,
    current_step: 'arc_created'
  });

  await logApiCost(userId, 'generate_arc', inputTokens, outputTokens, { storyId });

  return { arc: parsed };
}

/**
 * Generate a single chapter with quality review
 */
async function generateChapter(storyId, chapterNumber, userId) {
  // Fetch story, bible, arc, and previous chapters
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select(`
      *,
      bible:story_bibles(*),
      arc:story_arcs(*)
    `)
    .eq('id', storyId)
    .single();

  if (storyError || !story) {
    throw new Error('Story not found');
  }

  // Get last 3 chapters for context
  const { data: previousChapters } = await supabaseAdmin
    .from('chapters')
    .select('chapter_number, title, content, key_events')
    .eq('story_id', storyId)
    .lt('chapter_number', chapterNumber)
    .order('chapter_number', { ascending: false })
    .limit(3);

  const bible = story.bible;
  const arc = story.arc;
  const chapterOutline = arc.chapters.find(ch => ch.chapter_number === chapterNumber);

  if (!chapterOutline) {
    throw new Error(`Chapter ${chapterNumber} not found in arc outline`);
  }

  // Build context from previous chapters
  const previousContext = previousChapters && previousChapters.length > 0
    ? previousChapters.reverse().map(ch =>
        `Chapter ${ch.chapter_number}: ${ch.title}\nKey events: ${ch.key_events?.join(', ') || 'N/A'}`
      ).join('\n\n')
    : 'This is the first chapter.';

  const generatePrompt = `You are an award-winning children's book author.

Write Chapter ${chapterNumber} of "${bible.title}" following this outline:

CHAPTER OUTLINE:
Title: ${chapterOutline.title}
Events: ${chapterOutline.events_summary}
Character Focus: ${chapterOutline.character_focus}
Tension Level: ${chapterOutline.tension_level}
Word Count Target: ${chapterOutline.word_count_target}

STORY BIBLE:
Protagonist: ${bible.characters.protagonist.name} - ${bible.characters.protagonist.personality}
Antagonist: ${bible.characters.antagonist.name} - ${bible.characters.antagonist.motivation}
Central Conflict: ${bible.central_conflict.description}
World Rules: ${JSON.stringify(bible.world_rules)}

PREVIOUS CHAPTERS CONTEXT:
${previousContext}

Write a compelling chapter that:
- Is 2500-3500 words
- Uses vivid, engaging prose appropriate for ages 8-12
- Includes dialogue that sounds natural for the characters
- Has clear scene structure with strong opening and closing hooks
- Advances the plot while developing characters
- Maintains consistency with the world rules and previous chapters
- Avoids overly complex vocabulary but doesn't talk down to readers

Return ONLY a JSON object in this exact format:
{
  "chapter": {
    "chapter_number": ${chapterNumber},
    "title": "${chapterOutline.title}",
    "content": "The full chapter text here...",
    "word_count": number,
    "opening_hook": "First sentence or two",
    "closing_hook": "Last sentence or two",
    "key_events": ["event1", "event2"],
    "character_development": "Brief note on character growth"
  }
}`;

  let regenerationCount = 0;
  let chapter;
  let qualityReview;
  let passedQuality = false;

  // Generation with quality review loop (max 3 attempts)
  while (!passedQuality && regenerationCount < 3) {
    const messages = regenerationCount === 0
      ? [{ role: 'user', content: generatePrompt }]
      : [
          { role: 'user', content: generatePrompt },
          { role: 'assistant', content: JSON.stringify({ chapter }) },
          { role: 'user', content: `This chapter needs revision based on the following quality review:\n\n${JSON.stringify(qualityReview, null, 2)}\n\nPlease revise the chapter to address all issues while maintaining the plot events. Return the complete revised chapter in the same JSON format.` }
        ];

    const { response, inputTokens, outputTokens } = await callClaudeWithRetry(
      messages,
      64000,
      { operation: 'generate_chapter', userId, storyId, chapterNumber, regenerationCount }
    );

    await logApiCost(userId, 'generate_chapter', inputTokens, outputTokens, {
      storyId,
      chapterNumber,
      regenerationCount
    });

    const parsed = parseAndValidateJSON(response, ['chapter']);
    chapter = parsed.chapter;

    // Quality review pass
    const reviewPrompt = `You are an expert editor for children's fiction.

Review this chapter and score it on the following criteria (1-10 scale):

CHAPTER:
${JSON.stringify(chapter, null, 2)}

STORY CONTEXT:
Target Age: 8-12 years
Genre: ${bible.themes.join(', ')}
Protagonist: ${bible.characters.protagonist.name}

Score each criterion (1-10):
1. Age-appropriateness: Language and content suitable for 8-12 year olds
2. Engagement: Compelling and maintains reader interest
3. Pacing: Good balance of action, dialogue, and description
4. Character Consistency: Characters act consistently with their established traits
5. Arc Alignment: Chapter follows the outline and advances the plot
6. Writing Quality: Strong prose, vivid descriptions, natural dialogue

Return ONLY a JSON object in this exact format:
{
  "quality_review": {
    "score": average score (1-10),
    "criteria_scores": {
      "age_appropriateness": score,
      "engagement": score,
      "pacing": score,
      "character_consistency": score,
      "arc_alignment": score,
      "writing_quality": score
    },
    "strengths": ["strength1", "strength2"],
    "issues": ["issue1", "issue2"],
    "revision_notes": "Specific suggestions for improvement",
    "pass": true/false (pass if score >= 7)
  }
}`;

    const reviewMessages = [{ role: 'user', content: reviewPrompt }];

    const { response: reviewResponse, inputTokens: reviewInputTokens, outputTokens: reviewOutputTokens } = await callClaudeWithRetry(
      reviewMessages,
      64000,
      { operation: 'quality_review', userId, storyId, chapterNumber, regenerationCount }
    );

    await logApiCost(userId, 'quality_review', reviewInputTokens, reviewOutputTokens, {
      storyId,
      chapterNumber,
      regenerationCount
    });

    const reviewParsed = parseAndValidateJSON(reviewResponse, ['quality_review']);
    qualityReview = reviewParsed.quality_review;

    if (qualityReview.score >= 7) {
      passedQuality = true;
    } else {
      regenerationCount++;
      console.log(`Chapter ${chapterNumber} quality score: ${qualityReview.score}. Regenerating (attempt ${regenerationCount}/2)...`);
    }
  }

  // Store chapter in database
  const { data: storedChapter, error: chapterError } = await supabaseAdmin
    .from('chapters')
    .insert({
      story_id: storyId,
      chapter_number: chapterNumber,
      title: chapter.title,
      content: chapter.content,
      word_count: chapter.word_count,
      quality_score: Math.round(qualityReview.score),
      quality_review: qualityReview,
      quality_pass_completed: true,
      regeneration_count: regenerationCount,
      metadata: {
        opening_hook: chapter.opening_hook,
        closing_hook: chapter.closing_hook,
        key_events: chapter.key_events,
        character_development: chapter.character_development
      },
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  if (chapterError) {
    throw new Error(`Failed to store chapter: ${chapterError.message}`);
  }

  // Update story progress
  const currentProgress = story.generation_progress || {};
  await updateGenerationProgress(storyId, {
    ...currentProgress,
    chapters_generated: chapterNumber,
    current_step: `chapter_${chapterNumber}_complete`
  });

  return storedChapter;
}

/**
 * Orchestrate complete pre-generation: Bible -> Arc -> Chapters 1-8
 */
async function orchestratePreGeneration(storyId, userId) {
  try {
    // Step 1: Generate Bible (already done when story was created)
    const { data: story } = await supabaseAdmin
      .from('stories')
      .select('*, bible:story_bibles(*)')
      .eq('id', storyId)
      .single();

    if (!story || !story.bible) {
      throw new Error('Story or bible not found');
    }

    // Step 2: Generate Arc
    await updateGenerationProgress(storyId, {
      bible_complete: true,
      arc_complete: false,
      chapters_generated: 0,
      current_step: 'generating_arc'
    });

    await generateArcOutline(storyId, userId);

    // Step 3: Generate Chapters 1-8
    for (let i = 1; i <= 8; i++) {
      await updateGenerationProgress(storyId, {
        bible_complete: true,
        arc_complete: true,
        chapters_generated: i - 1,
        current_step: `generating_chapter_${i}`
      });

      await generateChapter(storyId, i, userId);

      // 1-second pause between chapters to avoid rate limits
      if (i < 8) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Mark story as active
    await supabaseAdmin
      .from('stories')
      .update({
        status: 'active',
        generation_progress: {
          bible_complete: true,
          arc_complete: true,
          chapters_generated: 8,
          current_step: 'complete',
          last_updated: new Date().toISOString()
        }
      })
      .eq('id', storyId);

    console.log(`Pre-generation complete for story ${storyId}`);
  } catch (error) {
    console.error(`Pre-generation failed for story ${storyId}:`, error);

    // Update story with error status
    await supabaseAdmin
      .from('stories')
      .update({
        status: 'error',
        error_message: error.message
      })
      .eq('id', storyId);

    throw error;
  }
}

module.exports = {
  generatePremises,
  generateStoryBible,
  generateArcOutline,
  generateChapter,
  orchestratePreGeneration,
  // Export utilities for testing
  calculateCost,
  parseAndValidateJSON
};
