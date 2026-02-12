const express = require('express');
const { anthropic } = require('../config/ai-clients');
const { asyncHandler } = require('../middleware/error-handler');
const {
  generatePremises,
  generateStoryBible,
  generateArcOutline,
  generateChapter
} = require('../services/generation');

const router = express.Router();

// Hardcoded test user ID (consistent across test runs)
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

// Read generation model from environment
const GENERATION_MODEL = process.env.CLAUDE_GENERATION_MODEL || 'claude-opus-4-6';

/**
 * GET /test/claude
 * Test Claude API integration with a simple story premise generation
 */
router.get('/claude', asyncHandler(async (req, res) => {
  const startTime = Date.now();

  try {
    // Call Claude API with a simple prompt
    const message = await anthropic.messages.create({
      model: GENERATION_MODEL,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: 'Write a one-sentence premise for a fantasy story.'
      }]
    });

    const responseTime = Date.now() - startTime;

    // Extract token usage
    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;

    // Calculate cost (Claude Opus 4.6 pricing as of 2026)
    // Input: $5 per million tokens, Output: $25 per million tokens
    const inputCost = (inputTokens / 1_000_000) * 5;
    const outputCost = (outputTokens / 1_000_000) * 25;
    const totalCost = inputCost + outputCost;

    // Extract the generated text
    const generatedPremise = message.content[0].text;

    res.json({
      success: true,
      test: 'Claude API Integration',
      model: GENERATION_MODEL,
      premise: generatedPremise,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens
      },
      cost: {
        inputCost: `$${inputCost.toFixed(6)}`,
        outputCost: `$${outputCost.toFixed(6)}`,
        totalCost: `$${totalCost.toFixed(6)}`
      },
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Claude API Error:', error);

    // Return detailed error information
    res.status(500).json({
      success: false,
      test: 'Claude API Integration',
      error: error.message,
      errorType: error.constructor.name,
      details: error.error || null,
      timestamp: new Date().toISOString()
    });
  }
}));

/**
 * GET /test/health
 * Simple health check for the test routes
 */
router.get('/health', asyncHandler(async (req, res) => {
  res.json({
    success: true,
    message: 'Test routes are operational',
    availableTests: [
      'GET /test/claude - Test Claude API integration',
      'POST /test/generate-story - Full end-to-end generation test',
      'GET /test/schema - Check actual database schema',
      'GET /test/health - This endpoint'
    ]
  });
}));

/**
 * GET /test/schema
 * Query actual database schema - try inserting with minimal data to see what's required
 */
router.get('/schema', asyncHandler(async (req, res) => {
  const { supabaseAdmin } = require('../config/supabase');

  const results = {
    success: true,
    story_bibles: { required_fields: [], errors: [] },
    stories: { required_fields: [], errors: [] }
  };

  // Test 1: Try to insert minimal story_bibles record to see what fields are required
  try {
    const { error } = await supabaseAdmin
      .from('story_bibles')
      .insert({ user_id: '00000000-0000-0000-0000-000000000001' })
      .select();

    if (error) {
      results.story_bibles.errors.push(error.message);
      // Parse error to extract required fields
      if (error.message.includes('violates not-null constraint')) {
        const match = error.message.match(/column "([^"]+)"/);
        if (match) results.story_bibles.required_fields.push(match[1]);
      }
    }
  } catch (e) {
    results.story_bibles.errors.push(e.message);
  }

  // Test 2: Try to insert minimal stories record
  try {
    const { error } = await supabaseAdmin
      .from('stories')
      .insert({ user_id: '00000000-0000-0000-0000-000000000001' })
      .select();

    if (error) {
      results.stories.errors.push(error.message);
      if (error.message.includes('violates not-null constraint')) {
        const match = error.message.match(/column "([^"]+)"/);
        if (match) results.stories.required_fields.push(match[1]);
      }
      if (error.message.includes('violates check constraint')) {
        results.stories.errors.push('Has CHECK constraints - see error details');
      }
    }
  } catch (e) {
    results.stories.errors.push(e.message);
  }

  res.json(results);
}));

/**
 * POST /test/generate-sample-chapter
 * Test new generation prompts without database dependencies
 * NO AUTHENTICATION REQUIRED - test endpoint only
 *
 * Generates a single test chapter with hardcoded bible/arc
 * Returns: generated chapter + quality review + metadata
 *
 * Expected time: ~30-60 seconds
 * Expected cost: ~$0.50-1.00
 */
router.post('/generate-sample-chapter', asyncHandler(async (req, res) => {
  console.log('\n🧪 Starting sample chapter generation...');
  const overallStartTime = Date.now();

  const { genre = 'fantasy', ageRange = 'young-adult' } = req.body;

  // Hardcoded minimal test bible
  const testBible = {
    title: "The Test Chronicle",
    genre: genre,
    world_rules: {
      magic_system: "Magic comes from storms",
      technology_level: "Medieval-ish",
      society_structure: "Coastal kingdom with storm barriers",
      unique_rules: ["Storm intensity is increasing", "Barrier stones can channel storm energy"]
    },
    characters: {
      protagonist: {
        name: "Kael",
        age: 16,
        personality: "Cautious but fiercely curious",
        strengths: ["Quick learner", "Empathetic"],
        flaws: ["Overthinks", "Avoids confrontation"],
        goals: "Understand why the storms are getting worse",
        fears: "Losing the people he loves to the storms",
        internal_contradiction: "Wants to protect everyone but can't face direct conflict",
        lie_they_believe: "If I stay quiet and careful, I can keep everyone safe",
        deepest_fear: "That his caution is actually cowardice",
        voice_notes: "Speaks carefully, often pauses mid-sentence"
      },
      antagonist: {
        name: "The Tide Warden",
        motivation: "Preserve the old storm barriers at any cost",
        methods: "Sacrificing villages to power the barriers",
        backstory: "Lost their own child to a storm they failed to predict",
        why_they_believe_theyre_right: "The barriers kept people safe for centuries — breaking tradition is the real danger",
        sympathetic_element: "Lost their own child to a storm they failed to predict",
        point_of_no_return: "Chose to sacrifice a village to power the barriers"
      },
      supporting: [
        {
          name: "Lira",
          role: "Kael's best friend",
          personality: "Bold and ambitious navigator",
          relationship_dynamic: "Pushes Kael to take risks while he grounds her recklessness",
          their_own_goal: "Prove herself as a navigator"
        }
      ]
    },
    central_conflict: {
      description: "The storms are getting worse because the barriers are failing, but the Warden refuses to try a new approach",
      inciting_incident: "Kael discovers a crack in the nearest barrier stone",
      complications: ["The Warden sees any challenge as heresy", "The storms are intensifying faster than expected"]
    },
    stakes: {
      personal: "Kael must choose between safety and truth",
      broader: "The entire coastal kingdom could be destroyed",
      emotional: "Kael must confront his fear of confrontation to save lives"
    },
    themes: ["courage vs. caution", "tradition vs. innovation", "growth through adversity"],
    key_locations: [
      {
        name: "The Harbor",
        description: "A bustling coastal port with storm-worn docks",
        significance: "Where Kael witnesses the storm's power",
        sensory_details: {
          sounds: "Waves crashing, gulls crying, ropes creaking",
          smells: "Salt spray, fish, tar",
          tactile: "Cold wind, damp air, rough wooden planks"
        }
      },
      {
        name: "The Barrier Stone",
        description: "A massive carved stone pillar glowing faintly with channeled storm energy",
        significance: "The failing defense mechanism",
        sensory_details: {
          sounds: "Low humming, occasional crackling",
          smells: "Ozone, wet stone",
          tactile: "Vibrating warmth, smooth ancient carvings"
        }
      }
    ]
  };

  // Hardcoded minimal arc outline for chapter 1
  const chapterOutline = {
    chapter_number: 1,
    title: "The Warning Bell",
    events_summary: "Kael witnesses an unusually violent storm, the harbor warning bell rings for the first time in years, Kael discovers a crack in the nearest barrier stone",
    character_focus: "Establish Kael's cautious nature and his deep curiosity about the storms",
    tension_level: 3,
    word_count_target: 3000
  };

  // Build chapter generation prompt
  const generatePrompt = `You are an award-winning fiction author known for prose that shows instead of tells, vivid character work, and compulsive page-turning narratives.

Write Chapter 1 of "${testBible.title}" following this outline and craft rules.

<story_context>
  <protagonist>
    <name>${testBible.characters.protagonist.name}</name>
    <age>${testBible.characters.protagonist.age}</age>
    <personality>${testBible.characters.protagonist.personality}</personality>
    <strengths>${testBible.characters.protagonist.strengths.join(', ')}</strengths>
    <flaws>${testBible.characters.protagonist.flaws.join(', ')}</flaws>
    <goals>${testBible.characters.protagonist.goals}</goals>
    <fears>${testBible.characters.protagonist.fears}</fears>
    <internal_contradiction>${testBible.characters.protagonist.internal_contradiction}</internal_contradiction>
    <lie_they_believe>${testBible.characters.protagonist.lie_they_believe}</lie_they_believe>
    <deepest_fear>${testBible.characters.protagonist.deepest_fear}</deepest_fear>
    <voice_notes>${testBible.characters.protagonist.voice_notes}</voice_notes>
  </protagonist>

  <antagonist>
    <name>${testBible.characters.antagonist.name}</name>
    <motivation>${testBible.characters.antagonist.motivation}</motivation>
    <methods>${testBible.characters.antagonist.methods}</methods>
    <why_they_believe_theyre_right>${testBible.characters.antagonist.why_they_believe_theyre_right}</why_they_believe_theyre_right>
    <sympathetic_element>${testBible.characters.antagonist.sympathetic_element}</sympathetic_element>
  </antagonist>

  <supporting_characters>
    ${testBible.characters.supporting.map(sc => `<character name="${sc.name}" role="${sc.role}" relationship="${sc.relationship_dynamic}">${sc.personality}</character>`).join('\n    ')}
  </supporting_characters>

  <world_rules>
    ${JSON.stringify(testBible.world_rules)}
  </world_rules>

  <central_conflict>${testBible.central_conflict.description}</central_conflict>

  <stakes>
    <personal>${testBible.stakes.personal}</personal>
    <broader>${testBible.stakes.broader}</broader>
  </stakes>

  <key_locations>
    ${testBible.key_locations.map(loc => `<location name="${loc.name}">${loc.description}</location>`).join('\n    ')}
  </key_locations>
</story_context>

<chapter_outline>
  <chapter_number>${chapterOutline.chapter_number}</chapter_number>
  <title>${chapterOutline.title}</title>
  <events_summary>${chapterOutline.events_summary}</events_summary>
  <character_focus>${chapterOutline.character_focus}</character_focus>
  <tension_level>${chapterOutline.tension_level}</tension_level>
  <word_count_target>${chapterOutline.word_count_target}</word_count_target>
</chapter_outline>

<previous_chapters>
This is the first chapter.
</previous_chapters>

<writing_craft_rules>

  <show_dont_tell>
    NEVER name an emotion directly. Show it through physical sensation, action, dialogue, or metaphor.

    If you write a sentence containing "felt", "was", or "seemed" followed by an emotion word, DELETE IT and rewrite.

    EXAMPLES:
    ❌ "She felt angry"
    ✅ "Her hands curled into fists, jaw clenched so tight her teeth ached"

    ❌ "The forest was scary"
    ✅ "Branches clawed at the sky like skeletal fingers, and something rustled in the undergrowth"

    ❌ "He was brave"
    ✅ "His knees wobbled, but he stepped forward anyway"

    ❌ "They were best friends"
    ✅ "She shoved him with her shoulder and he shoved back, both grinning"

    ❌ "The magic was powerful"
    ✅ "The spell hit like a thunderclap—the ground split, and blue light poured from the cracks"

    ❌ "She was nervous about the test"
    ✅ "Her pencil tapped against the desk. Tap-tap-tap. She couldn't make it stop."

    ❌ "The room felt cold and unwelcoming"
    ✅ "Frost crept up the windows in jagged patterns. Each breath hung in the air like a ghost."
  </show_dont_tell>

  <dialogue_quality>
    • Each character MUST sound distinct through vocabulary, sentence length, speech patterns, and concerns
    • NO adverb dialogue tags ("said angrily", "whispered softly")—use action beats instead
    • Dialogue must do double duty: reveal character AND advance plot simultaneously
    • Include subtext—characters don't always say what they mean, especially in conflict
    • Beats between dialogue lines (physical actions, observations, internal reactions)
    • No more than 3 consecutive lines of dialogue without a beat or action

    EXAMPLE of good dialogue with beats:
    "I didn't take your stupid necklace." Maya crossed her arms, but her eyes flicked to the drawer.
    "Then why won't you look at me?"
    She kicked at the rug. "Because you always blame me for everything."

    NOT this:
    "I didn't take your necklace," Maya said defensively.
    "Then why won't you look at me?" her sister asked suspiciously.
    "Because you always blame me," Maya replied angrily.
  </dialogue_quality>

  <pacing_and_structure>
    • Vary sentence length: short punchy sentences for tension, longer flowing ones for atmosphere
    • Open every chapter with action, dialogue, or intrigue—NEVER pure description
    • End every chapter with a hook that compels the reader forward
    • Target balance: ~40% action/dialogue, ~30% character moments, ~30% world/atmosphere
    • Scene transitions should be crisp, not padded with unnecessary "meanwhile" or "later that day"
    • Use white space—paragraph breaks create rhythm and breathing room
  </pacing_and_structure>

  <things_to_avoid>
    FORBIDDEN CONSTRUCTIONS (AI tells):
    • Purple prose and flowery over-description
    • Explaining emotions instead of showing them
    • "Not X, but Y" sentence structure (e.g., "It wasn't fear, but excitement")
    • Rhetorical questions as filler ("What could go wrong?", "How hard could it be?")
    • Em dash overuse (max 2 per chapter)
    • Repeating the same sentence structure more than twice in a row
    • Starting consecutive paragraphs the same way
    • Adverbs modifying "said" (said quickly, said nervously, said hopefully)
    • "Letting out a breath they didn't know they were holding"
    • "A mixture of X and Y" emotion descriptions
    • Any form of "little did they know"
    • "Their heart pounded in their chest" (where else would it pound?)
    • Over-reliance on character names—use pronouns naturally
  </things_to_avoid>

</writing_craft_rules>

<style_example>
  This is the prose standard you're aiming for:

  The door stood open. Not kicked in, not broken—just open, like an invitation written in silence. Mira's pulse kicked up. She pressed her back against the hallway wall, felt the rough brick bite through her jacket, and counted to three. No sound from inside. No movement.

  She slipped through. The apartment looked wrong. Not ransacked-wrong, but rearranged-wrong. Someone had been careful. The couch cushions sat perfectly straight. The stack of mail on the counter lined up like soldiers. Her breath came shallow now. Whoever did this wanted her to know they'd been here. Wanted her to feel it.
</style_example>

<word_count>
  STRICT REQUIREMENT: This chapter must be between 2500 and 3500 words. Not a guideline—a hard constraint. Count carefully.

  If you approach 3500 words and haven't completed the chapter arc, condense. If you finish the chapter arc before 2500 words, expand scenes with richer detail, more character interiority, or stronger sensory grounding.
</word_count>

<target_age_range>
  Age Range: ${ageRange}

  Adjust vocabulary complexity, sentence structure, and thematic sophistication to match this age range. For children (8-12), keep sentences varied but accessible, avoid abstract philosophical digressions, and ground emotions in concrete physical experience. For teens (13-17), you can explore more complex interior conflict and moral ambiguity. For adults (18+), full range of vocabulary and thematic depth.
</target_age_range>

Return ONLY a JSON object in this exact format:
{
  "chapter": {
    "chapter_number": 1,
    "title": "${chapterOutline.title}",
    "content": "The full chapter text here...",
    "word_count": number,
    "opening_hook": "First sentence or two",
    "closing_hook": "Last sentence or two",
    "key_events": ["event1", "event2"],
    "character_development": "Brief note on character growth"
  }
}`;

  // Generate chapter
  console.log('✍️  Generating chapter...');
  const genStartTime = Date.now();

  const chapterMessage = await anthropic.messages.create({
    model: GENERATION_MODEL,
    max_tokens: 16000,
    messages: [{ role: 'user', content: generatePrompt }]
  });

  const genTime = Date.now() - genStartTime;
  const genInputTokens = chapterMessage.usage.input_tokens;
  const genOutputTokens = chapterMessage.usage.output_tokens;

  // Calculate generation cost
  const genInputCost = (genInputTokens / 1_000_000) * 5;
  const genOutputCost = (genOutputTokens / 1_000_000) * 25;
  const genTotalCost = genInputCost + genOutputCost;

  // Parse chapter
  const chapterText = chapterMessage.content[0].text;
  let chapter;
  try {
    // Remove markdown code blocks if present
    const jsonText = chapterText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    const parsed = JSON.parse(jsonText);
    chapter = parsed.chapter;
  } catch (e) {
    console.error('Failed to parse chapter JSON:', e);
    return res.status(500).json({
      success: false,
      error: 'Failed to parse chapter JSON',
      raw_response: chapterText
    });
  }

  console.log(`✅ Chapter generated: ${chapter.word_count} words in ${(genTime / 1000).toFixed(1)}s`);

  // Quality review
  console.log('🔍 Running quality review...');
  const reviewStartTime = Date.now();

  const reviewPrompt = `You are an expert editor for fiction with deep knowledge of show-don't-tell craft, dialogue quality, and prose technique.

Review this chapter against the same writing craft standards it was supposed to follow.

<chapter_to_review>
${JSON.stringify(chapter, null, 2)}
</chapter_to_review>

<story_context>
Target Age: ${ageRange}
Genre: ${testBible.genre}
Protagonist: ${testBible.characters.protagonist.name}
</story_context>

<writing_craft_standards>

SHOW DON'T TELL:
• NEVER name emotions directly ("felt angry", "was scared", "seemed happy")
• Show through physical sensation, action, dialogue, metaphor
• Examples:
  ❌ "She felt angry" → ✅ "Her hands curled into fists, jaw clenched so tight her teeth ached"
  ❌ "The forest was scary" → ✅ "Branches clawed at the sky like skeletal fingers"
  ❌ "He was brave" → ✅ "His knees wobbled, but he stepped forward anyway"

DIALOGUE QUALITY:
• Each character sounds distinct through vocabulary, rhythm, concerns
• NO adverb dialogue tags ("said angrily")—use action beats instead
• Dialogue advances plot AND reveals character simultaneously
• Include subtext—characters don't always say what they mean
• No more than 3 lines of dialogue without a beat or action

PACING & STRUCTURE:
• Vary sentence length (short = tension, longer = atmosphere)
• Strong opening hook (action/dialogue/intrigue, NOT description)
• Compelling chapter-ending hook
• Balance: ~40% action/dialogue, ~30% character, ~30% world/atmosphere
• Crisp scene transitions

THINGS TO AVOID (AI tells):
• Purple prose and flowery over-description
• "Not X, but Y" constructions
• Rhetorical questions as filler
• Em dash overuse (max 2 per chapter)
• Repeating sentence structures 3+ times in a row
• Starting consecutive paragraphs identically
• "Letting out a breath they didn't know they were holding"
• "A mixture of X and Y" emotion descriptions
• "Little did they know"

</writing_craft_standards>

<weighted_rubric>

Score each criterion (1-10), provide evidence quotes, and suggest fixes if score < 7.

1. SHOW DON'T TELL (Weight: 25%)
   - Does the chapter show emotions through action/sensation/dialogue rather than naming them?
   - Quote any instances of emotion-telling
   - Are abstract states made concrete?

2. DIALOGUE QUALITY (Weight: 20%)
   - Do characters sound distinct?
   - Are there action beats instead of adverb tags?
   - Does dialogue advance plot and reveal character?
   - Quote any generic or flat dialogue

3. PACING & ENGAGEMENT (Weight: 20%)
   - Does the chapter pull the reader forward?
   - Strong opening? Compelling ending hook?
   - Varied sentence rhythm?
   - Good balance of action/character/world?

4. AGE APPROPRIATENESS (Weight: 15%)
   - Is vocabulary and complexity right for ${ageRange}?
   - Natural voice without talking down?
   - Themes handled appropriately?

5. CHARACTER CONSISTENCY (Weight: 10%)
   - Do character decisions flow from established traits, fears, goals?
   - Any out-of-character moments?
   - Does this chapter develop the character arc?

6. PROSE QUALITY (Weight: 10%)
   - Clean writing free of AI tells ("not X but Y", rhetorical questions, etc.)?
   - No purple prose or clichés?
   - Varied sentence structure?

</weighted_rubric>

Calculate weighted_score = sum of (criterion_score × weight).

Pass threshold: weighted_score >= 7.5

Return ONLY a JSON object in this exact format:
{
  "quality_review": {
    "weighted_score": number (calculated sum of score × weight),
    "criteria_scores": {
      "show_dont_tell": {
        "score": number (1-10),
        "weight": 0.25,
        "quotes": ["quote1 showing issue or strength", "quote2"],
        "fix": "actionable fix if score < 7, else empty string"
      },
      "dialogue_quality": {
        "score": number (1-10),
        "weight": 0.20,
        "quotes": ["quote1", "quote2"],
        "fix": "actionable fix or empty"
      },
      "pacing_engagement": {
        "score": number (1-10),
        "weight": 0.20,
        "quotes": ["quote1", "quote2"],
        "fix": "actionable fix or empty"
      },
      "age_appropriateness": {
        "score": number (1-10),
        "weight": 0.15,
        "quotes": ["quote1", "quote2"],
        "fix": "actionable fix or empty"
      },
      "character_consistency": {
        "score": number (1-10),
        "weight": 0.10,
        "quotes": ["quote1", "quote2"],
        "fix": "actionable fix or empty"
      },
      "prose_quality": {
        "score": number (1-10),
        "weight": 0.10,
        "quotes": ["quote1", "quote2"],
        "fix": "actionable fix or empty"
      }
    },
    "strengths": ["strength1", "strength2"],
    "weaknesses": ["weakness1", "weakness2"],
    "pass": boolean (weighted_score >= 7.5)
  }
}`;

  const reviewMessage = await anthropic.messages.create({
    model: GENERATION_MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: reviewPrompt }]
  });

  const reviewTime = Date.now() - reviewStartTime;
  const reviewInputTokens = reviewMessage.usage.input_tokens;
  const reviewOutputTokens = reviewMessage.usage.output_tokens;

  // Calculate review cost
  const reviewInputCost = (reviewInputTokens / 1_000_000) * 5;
  const reviewOutputCost = (reviewOutputTokens / 1_000_000) * 25;
  const reviewTotalCost = reviewInputCost + reviewOutputCost;

  // Parse quality review
  const reviewText = reviewMessage.content[0].text;
  let qualityReview;
  try {
    const jsonText = reviewText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    const parsed = JSON.parse(jsonText);
    qualityReview = parsed.quality_review;
  } catch (e) {
    console.error('Failed to parse quality review JSON:', e);
    return res.status(500).json({
      success: false,
      error: 'Failed to parse quality review JSON',
      raw_response: reviewText
    });
  }

  console.log(`✅ Quality review complete: score ${qualityReview.weighted_score.toFixed(2)}/10 in ${(reviewTime / 1000).toFixed(1)}s`);

  const totalTime = Date.now() - overallStartTime;
  const totalCost = genTotalCost + reviewTotalCost;

  res.json({
    success: true,
    chapter: {
      title: chapter.title,
      content: chapter.content,
      word_count: chapter.word_count,
      opening_hook: chapter.opening_hook,
      closing_hook: chapter.closing_hook,
      key_events: chapter.key_events,
      character_development: chapter.character_development
    },
    quality_review: qualityReview,
    metadata: {
      model: GENERATION_MODEL,
      generation_time_ms: genTime,
      review_time_ms: reviewTime,
      total_time_ms: totalTime,
      total_cost: `$${totalCost.toFixed(4)}`,
      token_usage: {
        generation: {
          input: genInputTokens,
          output: genOutputTokens,
          total: genInputTokens + genOutputTokens
        },
        review: {
          input: reviewInputTokens,
          output: reviewOutputTokens,
          total: reviewInputTokens + reviewOutputTokens
        }
      }
    }
  });
}));

/**
 * POST /test/generate-story
 * Full end-to-end test of the story generation pipeline
 * NO AUTHENTICATION REQUIRED - test endpoint only
 *
 * Tests:
 * 1. Generate 3 premises from preferences
 * 2. Generate story bible from first premise
 * 3. Generate arc outline
 * 4. Generate first chapter with quality pass
 *
 * Expected time: ~3-4 minutes
 * Expected cost: ~$1.50
 */
router.post('/generate-story', asyncHandler(async (req, res) => {
  console.log('\n🧪 Starting full generation test...');
  const overallStartTime = Date.now();

  const results = {
    success: true,
    test: 'Full Story Generation Pipeline',
    test_user_id: TEST_USER_ID,
    timestamps: {},
    timings: {},
    costs: {},
    errors: []
  };

  try {
    // Step 1: Generate 3 premises
    console.log('📚 Step 1: Generating premises...');
    const premisesStartTime = Date.now();

    const preferences = {
      favorite_series: ['Harry Potter'],
      favorite_genres: ['fantasy'],
      loved_elements: ['magic', 'adventure'],
      disliked_elements: []
    };

    const { premises, premisesId } = await generatePremises(TEST_USER_ID, preferences);

    results.premises = premises.map(p => ({
      id: p.id,
      title: p.title,
      genre: p.genre,
      hook: p.hook,
      themes: p.themes
    }));
    results.premises_id = premisesId;
    results.timestamps.premises_generated = new Date().toISOString();
    results.timings.premises_generation = `${((Date.now() - premisesStartTime) / 1000).toFixed(1)}s`;

    console.log(`✅ Generated ${premises.length} premises in ${results.timings.premises_generation}`);

    // Step 2: Generate story bible from first premise
    console.log('📖 Step 2: Generating story bible...');
    const bibleStartTime = Date.now();

    const { bible, storyId } = await generateStoryBible(premisesId, TEST_USER_ID);

    results.story_id = storyId;
    results.bible = {
      title: bible.title,
      protagonist: bible.characters.protagonist.name,
      antagonist: bible.characters.antagonist.name,
      central_conflict: bible.central_conflict.description,
      themes: bible.themes,
      key_locations_count: bible.key_locations.length
    };
    results.timestamps.bible_generated = new Date().toISOString();
    results.timings.bible_generation = `${((Date.now() - bibleStartTime) / 1000).toFixed(1)}s`;

    console.log(`✅ Generated story bible in ${results.timings.bible_generation}`);

    // Step 3: Generate arc outline
    console.log('📋 Step 3: Generating arc outline...');
    const arcStartTime = Date.now();

    const { arc } = await generateArcOutline(storyId, TEST_USER_ID);

    results.arc = {
      chapter_count: arc.chapters.length,
      chapters: arc.chapters.map(ch => ({
        number: ch.chapter_number,
        title: ch.title,
        tension_level: ch.tension_level,
        word_count_target: ch.word_count_target
      })),
      pacing_notes: arc.pacing_notes
    };
    results.timestamps.arc_generated = new Date().toISOString();
    results.timings.arc_generation = `${((Date.now() - arcStartTime) / 1000).toFixed(1)}s`;

    console.log(`✅ Generated ${arc.chapters.length}-chapter arc in ${results.timings.arc_generation}`);

    // Step 4: Generate first chapter
    console.log('✍️  Step 4: Generating first chapter...');
    const chapterStartTime = Date.now();

    const chapter = await generateChapter(storyId, 1, TEST_USER_ID);

    results.chapter_1 = {
      id: chapter.id,
      title: chapter.title,
      word_count: chapter.word_count,
      quality_score: chapter.quality_score,
      regeneration_count: chapter.regeneration_count,
      content_preview: chapter.content.substring(0, 500) + '...',
      content_full: chapter.content // Include full content for verification
    };

    if (chapter.quality_review) {
      results.chapter_1.quality_review = {
        criteria_scores: chapter.quality_review.criteria_scores,
        strengths: chapter.quality_review.strengths,
        passed: chapter.quality_review.pass
      };
    }

    results.timestamps.chapter_generated = new Date().toISOString();
    results.timings.chapter_generation = `${((Date.now() - chapterStartTime) / 1000).toFixed(1)}s`;

    console.log(`✅ Generated chapter 1 in ${results.timings.chapter_generation}`);
    console.log(`   Word count: ${chapter.word_count}`);
    console.log(`   Quality score: ${chapter.quality_score}/10`);
    console.log(`   Regenerations: ${chapter.regeneration_count}`);

    // Calculate totals
    const totalTime = (Date.now() - overallStartTime) / 1000;
    results.timings.total = `${totalTime.toFixed(1)}s`;
    results.timings.total_minutes = `${(totalTime / 60).toFixed(2)}min`;

    // Estimate cost (rough calculation based on typical token usage)
    // These are estimates - actual costs tracked in api_costs table
    const estimatedCosts = {
      premises: 0.05,
      bible: 0.75,
      arc: 0.50,
      chapter: 0.90
    };

    const totalEstimatedCost = Object.values(estimatedCosts).reduce((a, b) => a + b, 0);

    results.costs = {
      premises_estimated: `$${estimatedCosts.premises.toFixed(2)}`,
      bible_estimated: `$${estimatedCosts.bible.toFixed(2)}`,
      arc_estimated: `$${estimatedCosts.arc.toFixed(2)}`,
      chapter_estimated: `$${estimatedCosts.chapter.toFixed(2)}`,
      total_estimated: `$${totalEstimatedCost.toFixed(2)}`,
      note: 'Actual costs tracked in api_costs table - query for exact values'
    };

    console.log(`\n✅ Full generation test completed in ${results.timings.total}`);
    console.log(`💰 Estimated cost: ${results.costs.total_estimated}`);

    res.json(results);

  } catch (error) {
    console.error('❌ Generation test failed:', error);

    // Return partial results with error
    results.success = false;
    results.error = error.message;
    results.error_type = error.constructor.name;
    results.error_stack = error.stack;
    results.timings.total = `${((Date.now() - overallStartTime) / 1000).toFixed(1)}s (failed)`;

    res.status(500).json(results);
  }
}));

module.exports = router;
