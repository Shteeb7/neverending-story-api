const { anthropic } = require('../config/ai-clients');
const { storyLog } = require('./story-logger');

// Model constants
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * Calculate cost for Claude API call
 * Haiku pricing: $0.40/M input, $2/M output
 * Sonnet pricing: $1.50/M input, $7.50/M output
 */
function calculateConstraintCost(inputTokens, outputTokens, model) {
  const pricing = {
    [HAIKU_MODEL]: { input: 0.40, output: 2.00 },
    [SONNET_MODEL]: { input: 1.50, output: 7.50 }
  };

  const rates = pricing[model] || pricing[SONNET_MODEL];
  const inputCost = (inputTokens / 1_000_000) * rates.input;
  const outputCost = (outputTokens / 1_000_000) * rates.output;
  return inputCost + outputCost;
}

/**
 * Extract structured constraints from chapter outline and story context
 * Pass 1 of the three-pass architecture
 *
 * @param {Object} chapterOutline - The arc's chapter object
 * @param {Array} previousChaptersKeyEvents - Array of key_events from previous chapters
 * @param {string} worldStateLedger - Recent world state entries
 * @param {string} characterLedger - Recent character ledger entries
 * @param {string} storyId - For logging
 * @param {string} storyTitle - For logging
 * @param {number} chapterNumber - For logging
 * @returns {Object} { must: [], must_not: [], should: [] }
 */
async function extractChapterConstraints(
  chapterOutline,
  previousChaptersKeyEvents,
  worldStateLedger,
  characterLedger,
  storyId,
  storyTitle,
  chapterNumber
) {
  const startTime = Date.now();

  // Build previous events context
  const previousEventsText = previousChaptersKeyEvents && previousChaptersKeyEvents.length > 0
    ? previousChaptersKeyEvents.map((ch, idx) => {
        const events = Array.isArray(ch.key_events)
          ? ch.key_events.join('; ')
          : (ch.key_events || 'None');
        return `Chapter ${ch.chapter_number}: ${events}`;
      }).join('\n')
    : 'No previous chapters';

  const prompt = `You are a story continuity editor. Your job is to extract hard constraints from the story plan before the chapter is written.

Read the chapter outline, previous events, and world rules. Produce three categories of constraints:

MUST constraints: Non-negotiable plot requirements from the arc outline. These are the author's planned beats — key_revelations that MUST appear, emotional_arc transitions that MUST happen, events from events_summary that MUST occur. If the arc says "200 colonists die," that is a MUST. Be specific and actionable.

MUST NOT constraints: Things that would contradict established facts. Check previous chapter key_events for anything that would be contradicted by the arc plan. Check world rules for any constraints the chapter must respect. Be specific: "Character X must not know about Y because they haven't learned it yet."

SHOULD constraints: Soft quality targets. Callbacks to earlier moments (from the callback_bank if available), emotional beats that would strengthen the chapter, character dynamics that should be maintained. These are aspirational, not required.

Extract 3-8 MUST constraints, 2-5 MUST NOT constraints, and 2-5 SHOULD constraints. Each must have a unique ID and cite its source.

<chapter_outline>
  Chapter Number: ${chapterNumber}
  Title: ${chapterOutline.title || 'Untitled'}
  Events Summary: ${chapterOutline.events_summary || 'N/A'}
  Key Revelations: ${chapterOutline.key_revelations || 'N/A'}
  Emotional Arc: ${chapterOutline.emotional_arc || 'N/A'}
  Character Focus: ${chapterOutline.character_focus || 'N/A'}
  Tension Level: ${chapterOutline.tension_level || 'N/A'}
  Chapter Hook: ${chapterOutline.chapter_hook || 'N/A'}
</chapter_outline>

<previous_chapter_events>
${previousEventsText}
</previous_chapter_events>

${worldStateLedger ? `<world_state_ledger>
${worldStateLedger}
</world_state_ledger>` : ''}

${characterLedger ? `<character_ledger>
${characterLedger}
</character_ledger>` : ''}

Respond with valid JSON only, in this exact structure:
{
  "must": [
    { "id": "must_1", "constraint": "...", "source": "arc_events_summary" }
  ],
  "must_not": [
    { "id": "mustnot_1", "constraint": "...", "source": "previous_chapter_events" }
  ],
  "should": [
    { "id": "should_1", "constraint": "...", "source": "callback_bank" }
  ]
}`;

  try {
    const response = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const duration = Date.now() - startTime;

    // Parse JSON response
    let jsonText = response.content[0].text.trim();

    // Strip markdown code fences if present
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
    }

    const constraints = JSON.parse(jsonText);

    // Validate structure
    if (!constraints.must || !constraints.must_not || !constraints.should) {
      throw new Error('Invalid constraint structure: missing must, must_not, or should arrays');
    }

    storyLog(
      storyId,
      storyTitle,
      `📋 [${storyTitle}] Ch${chapterNumber}: Extracted ${constraints.must.length} MUST, ${constraints.must_not.length} MUST NOT, ${constraints.should.length} SHOULD constraints (${duration}ms)`
    );

    return {
      constraints,
      inputTokens,
      outputTokens,
      duration
    };
  } catch (error) {
    storyLog(
      storyId,
      storyTitle,
      `❌ [${storyTitle}] Ch${chapterNumber}: Constraint extraction failed — ${error.message}`
    );
    throw error;
  }
}

/**
 * Validate generated chapter against extracted constraints
 * Pass 3 of the three-pass architecture
 *
 * @param {string} chapterContent - The generated chapter text
 * @param {Object} constraints - The Pass 1 output (must/must_not/should arrays)
 * @param {string} storyId - For logging
 * @param {string} storyTitle - For logging
 * @param {number} chapterNumber - For logging
 * @returns {Object} { verdict: 'PASS'|'FAIL', must_results: [], must_not_results: [], should_results: [], specific_issues: [] }
 */
async function validateChapterConstraints(
  chapterContent,
  constraints,
  storyId,
  storyTitle,
  chapterNumber
) {
  const startTime = Date.now();

  const prompt = `You are a story continuity validator. A chapter has just been generated and you need to verify it against the pre-extracted constraints.

For each MUST constraint: Search the chapter for evidence that this requirement was delivered. Quote the specific passage. If you cannot find evidence, mark it NOT_DELIVERED.

For each MUST NOT constraint: Search the chapter for any violation. Quote the specific passage if violated. If no violation found, mark it CLEAR.

For each SHOULD constraint: Check if it was delivered. This is informational only — SHOULD failures don't affect the verdict.

VERDICT rules:
- Any MUST marked NOT_DELIVERED → FAIL
- Any MUST NOT marked VIOLATED → FAIL
- All MUST DELIVERED and all MUST NOT CLEAR → PASS

If FAIL: Write specific_issues describing exactly what needs to change. Be surgical — identify the specific scene or passage that needs revision, not a vague "rewrite the chapter."

<constraints>
MUST (Non-negotiable requirements):
${constraints.must.map(c => `[${c.id}] ${c.constraint}`).join('\n')}

MUST NOT (Contradictions to avoid):
${constraints.must_not.map(c => `[${c.id}] ${c.constraint}`).join('\n')}

SHOULD (Quality targets):
${constraints.should.map(c => `[${c.id}] ${c.constraint}`).join('\n')}
</constraints>

<chapter_to_validate>
${chapterContent}
</chapter_to_validate>

Respond with valid JSON only, in this exact structure:
{
  "verdict": "PASS",
  "must_results": [
    { "id": "must_1", "status": "DELIVERED", "evidence": "Quote from chapter proving delivery" }
  ],
  "must_not_results": [
    { "id": "mustnot_1", "status": "CLEAR", "evidence": "No mention of X" }
  ],
  "should_results": [
    { "id": "should_1", "status": "DELIVERED", "evidence": "Quote or explanation" }
  ],
  "specific_issues": []
}`;

  try {
    const response = await anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const duration = Date.now() - startTime;

    // Parse JSON response
    let jsonText = response.content[0].text.trim();

    // Strip markdown code fences if present
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
    }

    const validation = JSON.parse(jsonText);

    // Validate structure
    if (!validation.verdict || !validation.must_results || !validation.must_not_results) {
      throw new Error('Invalid validation structure');
    }

    const statusEmoji = validation.verdict === 'PASS' ? '✅' : '⚠️';
    const mustDelivered = validation.must_results.filter(r => r.status === 'DELIVERED').length;
    const mustNotClear = validation.must_not_results.filter(r => r.status === 'CLEAR').length;

    storyLog(
      storyId,
      storyTitle,
      `${statusEmoji} [${storyTitle}] Ch${chapterNumber}: Constraint validation ${validation.verdict} (${mustDelivered} MUST delivered, ${mustNotClear} MUST NOT clear) (${duration}ms)`
    );

    return {
      validation,
      inputTokens,
      outputTokens,
      duration
    };
  } catch (error) {
    storyLog(
      storyId,
      storyTitle,
      `❌ [${storyTitle}] Ch${chapterNumber}: Constraint validation failed — ${error.message}`
    );
    throw error;
  }
}

/**
 * Build the constraint block for injection into the generation prompt
 * @param {Object} constraints - The extracted constraints
 * @returns {string} XML-formatted constraint block
 */
function buildConstraintsBlock(constraints) {
  if (!constraints) return '';

  return `
<chapter_constraints>
  AUTHORIAL COMMITMENTS — These are YOUR planned story beats. You designed this arc. These constraints are not external rules imposed on you — they are the promises you made to the story when you outlined it. A chapter that fails to deliver a MUST requirement is a failed chapter, regardless of how well-written it is.

  NON-NEGOTIABLE REQUIREMENTS:
  ${constraints.must.map(c => `- [${c.id}] ${c.constraint}`).join('\n  ')}

  CONTRADICTIONS TO AVOID:
  ${constraints.must_not.map(c => `- [${c.id}] ${c.constraint}`).join('\n  ')}

  QUALITY TARGETS (deliver if natural, don't force):
  ${constraints.should.map(c => `- [${c.id}] ${c.constraint}`).join('\n  ')}
</chapter_constraints>
`;
}

module.exports = {
  extractChapterConstraints,
  validateChapterConstraints,
  buildConstraintsBlock,
  HAIKU_MODEL,
  SONNET_MODEL
};
