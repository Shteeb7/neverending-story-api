/**
 * Chapter Validation Service — Silent Post-Generation Consistency Checks
 *
 * After each chapter is generated, this service:
 * 1. Validates the chapter against the story bible for entity consistency
 * 2. Extracts named entities and facts into chapter_entities table
 * 3. Returns severity assessment (none/minor/critical)
 * 4. For critical issues: triggers targeted surgical revision
 *
 * Uses Haiku for all calls (~$0.01/chapter) — structured data tasks, not creative.
 */

const { anthropic } = require('../config/ai-clients');
const { supabaseAdmin } = require('../config/supabase');

const VALIDATION_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Run full validation pipeline on a newly generated chapter.
 * Non-fatal: if validation fails, the chapter is still delivered.
 *
 * @param {string} storyId
 * @param {string} chapterId - UUID of the stored chapter
 * @param {number} chapterNumber
 * @param {string} chapterContent - The chapter text
 * @param {object} bible - The story bible object
 * @param {string} userId - For cost tracking
 * @returns {object} { severity, validationResult, wasRevised, revisedContent }
 */
async function validateChapter(storyId, chapterId, chapterNumber, chapterContent, bible, userId) {
  const startTime = Date.now();
  const storyTitle = bible?.title || 'Unknown';

  console.log(`🔍 [${storyTitle}] Ch${chapterNumber}: Starting entity validation...`);

  try {
    // Fetch previous chapters' entities for cross-reference
    const { data: priorEntities } = await supabaseAdmin
      .from('chapter_entities')
      .select('entity_type, entity_name, fact, chapter_number')
      .eq('story_id', storyId)
      .lt('chapter_number', chapterNumber)
      .order('chapter_number', { ascending: true });

    // Build canonical entity reference from bible
    const canonicalRef = buildCanonicalReference(bible);

    // Build prior entity context (what's been established in earlier chapters)
    const priorEntityContext = buildPriorEntityContext(priorEntities || []);

    // Run validation + entity extraction in a single Haiku call
    const { validationResult, entities, inputTokens, outputTokens } = await runValidation(
      chapterContent,
      chapterNumber,
      canonicalRef,
      priorEntityContext,
      storyTitle
    );

    const validationTime = Date.now() - startTime;
    const severity = validationResult.severity || 'none';

    console.log(`🔍 [${storyTitle}] Ch${chapterNumber}: Validation complete — severity: ${severity} (${validationTime}ms)`);

    if (validationResult.character_issues?.length > 0) {
      console.log(`   Character issues: ${validationResult.character_issues.map(i => i.description).join('; ')}`);
    }
    if (validationResult.world_issues?.length > 0) {
      console.log(`   World issues: ${validationResult.world_issues.map(i => i.description).join('; ')}`);
    }
    if (validationResult.plot_issues?.length > 0) {
      console.log(`   Plot issues: ${validationResult.plot_issues.map(i => i.description).join('; ')}`);
    }

    // Store extracted entities
    if (entities && entities.length > 0) {
      await storeEntities(storyId, chapterId, chapterNumber, entities);
      console.log(`🔍 [${storyTitle}] Ch${chapterNumber}: ${entities.length} entities extracted`);
    }

    // Store validation result
    const { data: validationRecord } = await supabaseAdmin
      .from('chapter_validations')
      .insert({
        chapter_id: chapterId,
        story_id: storyId,
        chapter_number: chapterNumber,
        validation_result: validationResult,
        severity,
        auto_revised: false,
        model_used: VALIDATION_MODEL,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        validation_time_ms: validationTime
      })
      .select()
      .single();

    // Log cost
    const { logApiCost } = require('./generation');
    await logApiCost(userId, 'chapter_validation', inputTokens, outputTokens, {
      storyId,
      chapterNumber,
      severity
    });

    // Handle critical severity — surgical revision
    let revisedContent = null;
    if (severity === 'critical') {
      console.log(`🔧 [${storyTitle}] Ch${chapterNumber}: Critical issues detected — attempting surgical revision...`);
      revisedContent = await surgicalRevision(
        storyId, chapterId, chapterNumber, chapterContent,
        validationResult, canonicalRef, userId, storyTitle
      );

      if (revisedContent) {
        // Update the validation record
        await supabaseAdmin
          .from('chapter_validations')
          .update({
            auto_revised: true,
            revision_diff: buildRevisionSummary(validationResult)
          })
          .eq('id', validationRecord.id);

        console.log(`🔧 [${storyTitle}] Ch${chapterNumber}: Surgical revision applied`);
      } else {
        console.log(`⚠️ [${storyTitle}] Ch${chapterNumber}: Surgical revision failed — delivering original`);
      }
    }

    return {
      severity,
      validationResult,
      wasRevised: !!revisedContent,
      revisedContent
    };

  } catch (err) {
    const validationTime = Date.now() - startTime;
    console.error(`⚠️ [${storyTitle}] Ch${chapterNumber}: Validation failed (non-fatal, ${validationTime}ms): ${err.message}`);

    // Non-fatal — chapter still gets delivered
    return {
      severity: 'none',
      validationResult: { error: err.message },
      wasRevised: false,
      revisedContent: null
    };
  }
}

/**
 * Build a canonical reference string from the story bible
 * for the validation prompt to check against.
 */
function buildCanonicalReference(bible) {
  if (!bible) return 'No story bible available.';

  const parts = [];

  // Characters
  if (bible.characters) {
    const chars = [];
    if (bible.characters.protagonist) {
      const p = bible.characters.protagonist;
      chars.push(`PROTAGONIST: ${p.name} — Age: ${p.age || 'unknown'}, Personality: ${p.personality || 'N/A'}, Goals: ${p.goals || 'N/A'}, Fears: ${p.fears || 'N/A'}`);
    }
    if (bible.characters.antagonist) {
      const a = bible.characters.antagonist;
      chars.push(`ANTAGONIST: ${a.name} — Motivation: ${a.motivation || 'N/A'}`);
    }
    if (Array.isArray(bible.characters.supporting)) {
      bible.characters.supporting.forEach(s => {
        chars.push(`SUPPORTING: ${s.name} — Role: ${s.role || 'N/A'}, Relationship: ${s.relationship_dynamic || 'N/A'}`);
      });
    }
    parts.push('CHARACTERS:\n' + chars.join('\n'));
  }

  // World rules
  if (bible.world_rules) {
    const rules = typeof bible.world_rules === 'string'
      ? bible.world_rules
      : JSON.stringify(bible.world_rules);
    parts.push('WORLD RULES:\n' + rules);
  }

  // Key locations
  if (bible.key_locations && Array.isArray(bible.key_locations)) {
    const locs = bible.key_locations.map(l =>
      typeof l === 'string' ? l : `${l.name}: ${l.description || ''}`
    ).join('\n');
    parts.push('KEY LOCATIONS:\n' + locs);
  }

  // Central conflict
  if (bible.central_conflict) {
    const conflict = typeof bible.central_conflict === 'string'
      ? bible.central_conflict
      : bible.central_conflict.description || JSON.stringify(bible.central_conflict);
    parts.push('CENTRAL CONFLICT:\n' + conflict);
  }

  // Stakes
  if (bible.stakes) {
    parts.push('STAKES:\n' + (typeof bible.stakes === 'string' ? bible.stakes : JSON.stringify(bible.stakes)));
  }

  return parts.join('\n\n');
}

/**
 * Build prior entity context from previously extracted entities
 */
function buildPriorEntityContext(priorEntities) {
  if (priorEntities.length === 0) return 'This is the first chapter — no prior entities established.';

  // Group by entity type and name
  const grouped = {};
  for (const entity of priorEntities) {
    const key = `${entity.entity_type}:${entity.entity_name}`;
    if (!grouped[key]) {
      grouped[key] = { type: entity.entity_type, name: entity.entity_name, facts: [] };
    }
    grouped[key].facts.push(`Ch${entity.chapter_number}: ${entity.fact}`);
  }

  const lines = Object.values(grouped).map(g =>
    `[${g.type.toUpperCase()}] ${g.name}:\n  ${g.facts.join('\n  ')}`
  );

  return 'ESTABLISHED FACTS FROM PRIOR CHAPTERS:\n\n' + lines.join('\n\n');
}

/**
 * Run the actual validation call via Haiku
 */
async function runValidation(chapterContent, chapterNumber, canonicalRef, priorEntityContext, storyTitle) {
  const prompt = `You are a continuity editor for a serialized novel. Your job is to check this chapter for factual consistency against the story bible and prior chapters.

<story_bible>
${canonicalRef}
</story_bible>

<prior_chapters_entities>
${priorEntityContext}
</prior_chapters_entities>

<chapter_to_validate>
Chapter ${chapterNumber}:

${chapterContent}
</chapter_to_validate>

Perform TWO tasks:

TASK 1 — CONSISTENCY VALIDATION
Check the chapter for these specific issues:

1. CHARACTER CONSISTENCY: Are character names spelled correctly? Do physical descriptions match the bible? Are relationships correct? Do characters act within their established personality/motivations?

2. WORLD RULE VIOLATIONS: Does anything contradict established magic systems, technology, geography, or setting rules?

3. PLOT CONTINUITY: Does this chapter contradict any events from prior chapters? Are resolved plot threads treated as still open (or vice versa)?

For each issue found, classify as:
- "critical" = factual contradiction that a reader would notice (wrong name, dead character appears alive, location changes impossibly)
- "minor" = slight inconsistency that most readers wouldn't catch (personality drift, minor timeline fuzziness)

TASK 2 — ENTITY EXTRACTION
Extract every named entity mentioned in this chapter with their associated facts. Types: character, location, world_rule, timeline, plot_thread.

Return ONLY this JSON:
{
  "validation": {
    "character_issues": [{"description": "...", "severity": "critical|minor", "quote": "relevant passage", "canonical": "what bible says"}],
    "world_issues": [{"description": "...", "severity": "critical|minor", "quote": "...", "canonical": "..."}],
    "plot_issues": [{"description": "...", "severity": "critical|minor", "quote": "...", "canonical": "..."}],
    "severity": "none|minor|critical"
  },
  "entities": [
    {"entity_type": "character|location|world_rule|timeline|plot_thread", "entity_name": "Name", "fact": "What is stated about this entity", "source_quote": "Brief quote from chapter", "is_consistent": true}
  ]
}

If no issues found, return empty arrays and severity "none". The overall severity is the highest severity of any individual issue found. Be precise — only flag genuine contradictions, not stylistic choices or ambiguity.`;

  const apiStartTime = Date.now();
  const response = await anthropic.messages.create({
    model: VALIDATION_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }]
  });

  const apiDuration = ((Date.now() - apiStartTime) / 1000).toFixed(1);
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const responseText = response.content[0].text;

  console.log(`🔍 [${storyTitle}] Ch${chapterNumber}: Haiku validation call (${apiDuration}s, ${inputTokens}+${outputTokens} tokens)`);

  // Parse response
  const { parseAndValidateJSON } = require('./generation');
  const parsed = parseAndValidateJSON(responseText, ['validation', 'entities']);

  return {
    validationResult: parsed.validation,
    entities: parsed.entities || [],
    inputTokens,
    outputTokens
  };
}

/**
 * Store extracted entities in the chapter_entities table
 */
async function storeEntities(storyId, chapterId, chapterNumber, entities) {
  // Build rows, capping at 50 entities per chapter to prevent bloat
  const rows = entities.slice(0, 50).map(e => ({
    chapter_id: chapterId,
    story_id: storyId,
    chapter_number: chapterNumber,
    entity_type: e.entity_type,
    entity_name: e.entity_name,
    fact: e.fact,
    source_quote: e.source_quote || null,
    canonical_value: null, // Filled by validation comparison
    is_consistent: e.is_consistent !== false
  }));

  const { error } = await supabaseAdmin
    .from('chapter_entities')
    .insert(rows);

  if (error) {
    console.error(`⚠️ Failed to store entities for chapter ${chapterNumber}: ${error.message}`);
  }
}

/**
 * Surgical revision: fix specific passages with critical inconsistencies.
 * Uses Haiku for targeted find-and-replace style fixes, NOT full chapter regeneration.
 *
 * @returns {string|null} Revised content, or null if revision failed
 */
async function surgicalRevision(storyId, chapterId, chapterNumber, chapterContent, validationResult, canonicalRef, userId, storyTitle) {
  // Collect all critical issues
  const criticalIssues = [
    ...(validationResult.character_issues || []).filter(i => i.severity === 'critical'),
    ...(validationResult.world_issues || []).filter(i => i.severity === 'critical'),
    ...(validationResult.plot_issues || []).filter(i => i.severity === 'critical')
  ];

  if (criticalIssues.length === 0) return null;

  const issueList = criticalIssues.map((issue, i) =>
    `${i + 1}. ${issue.description}\n   Found: "${issue.quote}"\n   Should be: ${issue.canonical}`
  ).join('\n\n');

  const prompt = `You are a surgical text editor. Fix ONLY the specific inconsistencies listed below. Do NOT change anything else — same voice, same style, same events. Change only the minimum words necessary to resolve each contradiction.

<canonical_reference>
${canonicalRef}
</canonical_reference>

<critical_issues>
${issueList}
</critical_issues>

<chapter_text>
${chapterContent}
</chapter_text>

Return ONLY a JSON object:
{
  "revised_content": "The complete chapter text with ONLY the critical issues fixed. Everything else must be identical.",
  "changes_made": ["Brief description of each change"]
}`;

  try {
    const response = await anthropic.messages.create({
      model: VALIDATION_MODEL,
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }]
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    // Log cost
    const { logApiCost } = require('./generation');
    await logApiCost(userId, 'surgical_revision', inputTokens, outputTokens, {
      storyId,
      chapterNumber,
      issueCount: criticalIssues.length
    });

    const { parseAndValidateJSON } = require('./generation');
    const parsed = parseAndValidateJSON(response.content[0].text, ['revised_content']);

    if (parsed.revised_content) {
      // Update the chapter content in the database
      const { error } = await supabaseAdmin
        .from('chapters')
        .update({ content: parsed.revised_content })
        .eq('id', chapterId);

      if (error) {
        console.error(`⚠️ [${storyTitle}] Ch${chapterNumber}: Failed to save surgical revision: ${error.message}`);
        return null;
      }

      console.log(`🔧 [${storyTitle}] Ch${chapterNumber}: ${parsed.changes_made?.length || 0} surgical fixes applied`);
      return parsed.revised_content;
    }

    return null;
  } catch (err) {
    console.error(`⚠️ [${storyTitle}] Ch${chapterNumber}: Surgical revision error: ${err.message}`);
    return null;
  }
}

/**
 * Build a human-readable summary of what was revised
 */
function buildRevisionSummary(validationResult) {
  const issues = [
    ...(validationResult.character_issues || []).filter(i => i.severity === 'critical'),
    ...(validationResult.world_issues || []).filter(i => i.severity === 'critical'),
    ...(validationResult.plot_issues || []).filter(i => i.severity === 'critical')
  ];

  return issues.map(i => `Fixed: ${i.description}`).join('\n');
}

module.exports = {
  validateChapter,
  buildCanonicalReference,
  VALIDATION_MODEL
};
