/**
 * Prospero's Editor — Reader-Facing Consistency Collaboration
 *
 * When a reader highlights a passage and consults Prospero, this service:
 * 1. Investigates the highlighted text against story bible + entity ledger
 * 2. Returns Prospero's in-character response (concise, 1-2 sentences)
 * 3. If genuine inconsistency: provides corrected text for the passage
 * 4. Logs everything to reader_corrections for learning loop
 * 5. Updates reader_contribution_stats
 *
 * Uses Haiku for speed (~2-4 seconds target response time).
 */

const { anthropic } = require('../config/ai-clients');
const { supabaseAdmin } = require('../config/supabase');
const { logApiCost } = require('./generation');

const EDITOR_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * Investigate a reader-flagged passage.
 *
 * @param {object} params
 * @param {string} params.storyId
 * @param {string} params.chapterId
 * @param {number} params.chapterNumber
 * @param {string} params.highlightedText - The exact text the reader selected
 * @param {number} params.highlightStart - Character offset start
 * @param {number} params.highlightEnd - Character offset end
 * @param {string} params.readerDescription - What the reader said was wrong
 * @param {string} params.userId - Who flagged it
 * @param {string} params.authorId - Who owns the story
 * @param {boolean} params.isAuthor - Whether the flagger is the story author
 * @returns {object} { prosperoResponse, wasCorrection, correctedText, originalText, category, correctionId }
 */
async function investigatePassage(params) {
  const {
    storyId, chapterId, chapterNumber, highlightedText,
    highlightStart, highlightEnd, readerDescription,
    userId, authorId, isAuthor
  } = params;

  const startTime = Date.now();

  // Fetch context in parallel
  const [chapterResult, bibleResult, entitiesResult, ledgerResult, worldLedgerResult, codexResult, priorCorrectionsResult] = await Promise.all([
    supabaseAdmin
      .from('chapters')
      .select('content, title')
      .eq('id', chapterId)
      .single(),
    supabaseAdmin
      .from('story_bibles')
      .select('*')
      .eq('story_id', storyId)
      .single(),
    supabaseAdmin
      .from('chapter_entities')
      .select('entity_type, entity_name, fact, canonical_value, chapter_number')
      .eq('story_id', storyId)
      .order('chapter_number', { ascending: true }),
    // Character ledger — last entry for each chapter up to current
    supabaseAdmin
      .from('character_ledger_entries')
      .select('chapter_number, entry_data')
      .eq('story_id', storyId)
      .lte('chapter_number', chapterNumber)
      .order('chapter_number', { ascending: false })
      .limit(3),
    // World state ledger — last few entries
    supabaseAdmin
      .from('world_state_ledger')
      .select('chapter_number, entry_data')
      .eq('story_id', storyId)
      .lte('chapter_number', chapterNumber)
      .order('chapter_number', { ascending: false })
      .limit(3),
    // World codex — hard rules
    supabaseAdmin
      .from('world_codex')
      .select('codex_data')
      .eq('story_id', storyId)
      .maybeSingle(),
    // Prior corrections in this story — so Prospero knows about past fixes
    supabaseAdmin
      .from('reader_corrections')
      .select('chapter_number, highlighted_text, corrected_text, correction_category, was_corrected')
      .eq('story_id', storyId)
      .eq('was_corrected', true)
      .order('created_at', { ascending: false })
      .limit(10)
  ]);

  const chapter = chapterResult.data;
  const bible = bibleResult.data;
  const entities = entitiesResult.data || [];
  const ledgerEntries = ledgerResult.data || [];
  const worldLedger = worldLedgerResult.data || [];
  const codex = codexResult.data;
  const priorCorrections = priorCorrectionsResult.data || [];

  if (!chapter) {
    throw new Error(`Chapter ${chapterId} not found`);
  }

  // Build surrounding context (paragraph before and after the highlight)
  const surroundingContext = extractSurroundingContext(chapter.content, highlightStart, highlightEnd);

  // Build entity reference for relevant characters/locations
  const relevantEntities = buildRelevantEntityContext(entities, highlightedText, readerDescription);

  // Build bible reference
  const bibleReference = buildBibleReference(bible);

  // Build enriched context blocks
  const characterLedgerContext = buildCharacterLedgerContext(ledgerEntries);
  const worldContext = buildWorldContext(worldLedger, codex, highlightedText, readerDescription);
  const priorCorrectionsContext = buildPriorCorrectionsContext(priorCorrections);

  // Single Sonnet call: investigate + generate Prospero's response
  const prompt = buildInvestigationPrompt({
    highlightedText,
    surroundingContext,
    readerDescription,
    bibleReference,
    relevantEntities,
    characterLedgerContext,
    worldContext,
    priorCorrectionsContext,
    chapterNumber,
    chapterTitle: chapter.title
  });

  const response = await anthropic.messages.create({
    model: EDITOR_MODEL,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  });

  const inputTokens = response.usage?.input_tokens || 0;
  const outputTokens = response.usage?.output_tokens || 0;
  const rawResponse = response.content[0]?.text || '';

  // Parse the structured response
  let investigation;
  try {
    // Extract JSON from response (may be wrapped in markdown code blocks)
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    investigation = JSON.parse(jsonMatch[0]);
  } catch (parseErr) {
    console.error('❌ [Prospero Editor] Failed to parse investigation response:', parseErr.message);
    // Fallback: treat as no issue found
    investigation = {
      is_genuine_issue: false,
      prospero_response: "Hmm, let me look more closely... The tale appears sound to me. Read on — sometimes patterns reveal themselves in later chapters.",
      category: 'other',
      corrected_text: null
    };
  }

  const investigationTimeMs = Date.now() - startTime;

  // Determine if this is a correction (only authors can trigger actual text changes)
  const wasCorrection = investigation.is_genuine_issue === true && isAuthor;
  let correctedText = null;
  let originalText = null;

  if (wasCorrection && investigation.corrected_text) {
    correctedText = investigation.corrected_text;
    originalText = highlightedText;

    // Apply the correction to the chapter content
    const updatedContent = chapter.content.substring(0, highlightStart)
      + correctedText
      + chapter.content.substring(highlightEnd);

    await supabaseAdmin
      .from('chapters')
      .update({ content: updatedContent })
      .eq('id', chapterId);
  }

  // Log the correction
  const { data: correctionRecord } = await supabaseAdmin
    .from('reader_corrections')
    .insert({
      user_id: userId,
      author_id: authorId,
      story_id: storyId,
      chapter_id: chapterId,
      chapter_number: chapterNumber,
      highlighted_text: highlightedText,
      highlight_start: highlightStart,
      highlight_end: highlightEnd,
      reader_description: readerDescription,
      prospero_response: investigation.prospero_response,
      investigation_result: investigation,
      was_corrected: wasCorrection,
      original_text: originalText,
      corrected_text: correctedText,
      correction_category: investigation.category || 'other',
      interaction_type: investigation.interaction_type || (investigation.is_genuine_issue ? 'correction' : 'misunderstanding'),
      is_author: isAuthor,
      author_reviewed: isAuthor, // If author flagged it, it's already "reviewed"
      model_used: EDITOR_MODEL,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      investigation_time_ms: investigationTimeMs
    })
    .select('id')
    .single();

  // Update contribution stats
  await updateContributionStats(userId, storyId, wasCorrection, !investigation.is_genuine_issue, investigation.category);

  // Log API cost
  await logApiCost(userId, 'prospero_editor_investigation', inputTokens, outputTokens, {
    storyId,
    chapterNumber,
    wasCorrection,
    category: investigation.category,
    investigationTimeMs
  });

  console.log(`🔍 [Prospero Editor] Investigation complete: ${wasCorrection ? 'CORRECTED' : investigation.is_genuine_issue ? 'FLAGGED (non-author)' : 'NO ISSUE'} in ${investigationTimeMs}ms (${inputTokens}/${outputTokens} tokens)`);

  return {
    prosperoResponse: investigation.prospero_response,
    wasCorrection,
    correctedText,
    originalText,
    category: investigation.category,
    isGenuineIssue: investigation.is_genuine_issue,
    interactionType: investigation.interaction_type || (investigation.is_genuine_issue ? 'correction' : 'misunderstanding'),
    correctionId: correctionRecord?.id,
    investigationTimeMs
  };
}

/**
 * Extract ~500 chars of surrounding context around the highlighted passage.
 */
function extractSurroundingContext(content, start, end) {
  const contextPadding = 500;
  const contextStart = Math.max(0, start - contextPadding);
  const contextEnd = Math.min(content.length, end + contextPadding);

  let before = content.substring(contextStart, start);
  let after = content.substring(end, contextEnd);

  // Clean to nearest sentence boundary
  const firstSentenceBreak = before.indexOf('. ');
  if (firstSentenceBreak > 0) {
    before = before.substring(firstSentenceBreak + 2);
  }

  const lastSentenceBreak = after.lastIndexOf('. ');
  if (lastSentenceBreak > 0) {
    after = after.substring(0, lastSentenceBreak + 1);
  }

  return { before, highlighted: content.substring(start, end), after };
}

/**
 * Build relevant entity context by matching entity names against highlighted text and reader description.
 */
function buildRelevantEntityContext(entities, highlightedText, readerDescription) {
  if (!entities.length) return 'No entity data available yet.';

  const searchText = (highlightedText + ' ' + readerDescription).toLowerCase();

  // Find entities mentioned in the highlighted text or reader description
  const relevant = entities.filter(e =>
    searchText.includes(e.entity_name.toLowerCase()) ||
    (e.fact && searchText.includes(e.fact.toLowerCase().substring(0, 20)))
  );

  if (!relevant.length) {
    // Fall back to all character entities for this story
    const characters = entities.filter(e => e.entity_type === 'character');
    if (!characters.length) return 'No entity data available yet.';
    return characters.slice(0, 10).map(e =>
      `[Ch${e.chapter_number}] ${e.entity_name}: ${e.fact}${e.canonical_value ? ` (canonical: ${e.canonical_value})` : ''}`
    ).join('\n');
  }

  return relevant.map(e =>
    `[Ch${e.chapter_number}] ${e.entity_name} (${e.entity_type}): ${e.fact}${e.canonical_value ? ` (canonical: ${e.canonical_value})` : ''}`
  ).join('\n');
}

/**
 * Build a concise bible reference for investigation context.
 */
function buildBibleReference(bible) {
  if (!bible) return 'No story bible available.';

  const bibleData = bible.bible_data || bible;
  const sections = [];

  // Characters
  if (bibleData.characters) {
    const chars = Array.isArray(bibleData.characters) ? bibleData.characters : [bibleData.characters];
    chars.forEach(c => {
      if (c.name) {
        sections.push(`CHARACTER: ${c.name} — ${c.physical_description || ''} ${c.personality || ''} ${c.role || ''}`);
      }
    });
  }

  // Protagonist / antagonist
  if (bibleData.protagonist) {
    sections.push(`PROTAGONIST: ${bibleData.protagonist.name || 'Unknown'} — ${bibleData.protagonist.physical_description || ''}`);
  }
  if (bibleData.antagonist) {
    sections.push(`ANTAGONIST: ${bibleData.antagonist.name || 'Unknown'} — ${bibleData.antagonist.physical_description || ''}`);
  }

  // World rules
  if (bibleData.world_rules) {
    sections.push(`WORLD RULES: ${JSON.stringify(bibleData.world_rules).substring(0, 500)}`);
  }

  // Setting
  if (bibleData.setting) {
    sections.push(`SETTING: ${JSON.stringify(bibleData.setting).substring(0, 300)}`);
  }

  return sections.join('\n') || 'Bible exists but has no structured data.';
}

/**
 * Build character ledger context from recent chapter entries.
 */
function buildCharacterLedgerContext(ledgerEntries) {
  if (!ledgerEntries || !ledgerEntries.length) return '';

  const characterStates = [];
  ledgerEntries.forEach(entry => {
    if (!entry.entry_data) return;
    const data = entry.entry_data;

    // Extract key character state information
    if (data.characters && Array.isArray(data.characters)) {
      data.characters.forEach(char => {
        if (char.name) {
          const state = [];
          if (char.emotional_state) state.push(`emotional: ${char.emotional_state}`);
          if (char.current_goal) state.push(`goal: ${char.current_goal}`);
          if (char.key_relationships) state.push(`relationships: ${JSON.stringify(char.key_relationships).substring(0, 100)}`);

          if (state.length) {
            characterStates.push(`[Ch${entry.chapter_number}] ${char.name}: ${state.join(', ')}`);
          }
        }
      });
    }
  });

  if (!characterStates.length) return '';

  return `\nCHARACTER STATE (from recent chapters):\n${characterStates.slice(0, 10).join('\n')}\n`;
}

/**
 * Build world context from world ledger and codex, filtered by relevance.
 */
function buildWorldContext(worldLedger, codex, highlightedText, readerDescription) {
  const sections = [];
  const searchText = (highlightedText + ' ' + readerDescription).toLowerCase();

  // World codex — hard rules (filter for relevance)
  if (codex && codex.codex_data) {
    const codexData = codex.codex_data;
    const relevantRules = [];

    // Check for magic system mentions
    if (codexData.magic_system && (searchText.includes('magic') || searchText.includes('spell') || searchText.includes('power'))) {
      relevantRules.push(`Magic: ${JSON.stringify(codexData.magic_system).substring(0, 300)}`);
    }

    // Check for geography mentions
    if (codexData.geography && codexData.geography.length) {
      codexData.geography.forEach(place => {
        if (place.name && searchText.includes(place.name.toLowerCase())) {
          relevantRules.push(`${place.name}: ${place.description || ''}`);
        }
      });
    }

    // Check for timeline/historical events
    if (codexData.timeline && codexData.timeline.length) {
      codexData.timeline.forEach(event => {
        if (event.description && searchText.includes(event.description.toLowerCase().substring(0, 20))) {
          relevantRules.push(`Timeline: ${event.description.substring(0, 200)}`);
        }
      });
    }

    if (relevantRules.length) {
      sections.push(`WORLD RULES (codex):\n${relevantRules.join('\n')}`);
    }
  }

  // World state ledger — facts from recent chapters
  if (worldLedger && worldLedger.length) {
    const worldFacts = [];
    worldLedger.forEach(entry => {
      if (!entry.entry_data) return;
      const data = entry.entry_data;

      if (data.new_facts && Array.isArray(data.new_facts)) {
        data.new_facts.forEach(fact => {
          if (fact) worldFacts.push(`[Ch${entry.chapter_number}] ${fact}`);
        });
      }
    });

    if (worldFacts.length) {
      sections.push(`WORLD STATE (recent chapters):\n${worldFacts.slice(0, 8).join('\n')}`);
    }
  }

  return sections.length ? '\n' + sections.join('\n') + '\n' : '';
}

/**
 * Build prior corrections context — patterns to watch for.
 */
function buildPriorCorrectionsContext(corrections) {
  if (!corrections || !corrections.length) return '';

  const formatted = corrections.map(c =>
    `Ch${c.chapter_number}: "${c.highlighted_text.substring(0, 50)}${c.highlighted_text.length > 50 ? '...' : ''}" → "${c.corrected_text?.substring(0, 50) || 'N/A'}" [${c.correction_category}]`
  ).join('\n');

  return `\nPRIOR CORRECTIONS IN THIS STORY (patterns to watch for):\n${formatted}\n`;
}

/**
 * Build the investigation prompt for Sonnet.
 */
function buildInvestigationPrompt({ highlightedText, surroundingContext, readerDescription, bibleReference, relevantEntities, characterLedgerContext, worldContext, priorCorrectionsContext, chapterNumber, chapterTitle }) {
  return `You are investigating a passage in Chapter ${chapterNumber}${chapterTitle ? ` ("${chapterTitle}")` : ''} of a novel that a reader has flagged as potentially inconsistent.

HIGHLIGHTED PASSAGE:
"${highlightedText}"

SURROUNDING CONTEXT:
...${surroundingContext.before}[HIGHLIGHTED]${surroundingContext.highlighted}[/HIGHLIGHTED]${surroundingContext.after}...

READER'S CONCERN:
"${readerDescription}"

STORY BIBLE (canonical reference):
${bibleReference}

ENTITY LEDGER (facts established in prior chapters):
${relevantEntities}
${characterLedgerContext}${worldContext}${priorCorrectionsContext}
INSTRUCTIONS:
1. First, determine what the reader is doing:
   - CORRECTION: They believe the text is factually wrong or inconsistent with established story facts
   - CLARIFICATION: They're asking a question about terminology, world-building, character motivation, or meaning — NOT reporting an error
   - MISUNDERSTANDING: They think something is wrong, but the text is actually correct

2. If CORRECTION (genuine issue found): provide corrected_text that is a DROP-IN REPLACEMENT for the exact highlighted text shown above. The corrected_text will be spliced directly into the sentence at the exact position of the highlighted text — so it must fit grammatically and seamlessly into the surrounding words. Do NOT repeat words that already appear before or after the highlight. Change the minimum words necessary.

3. If MISUNDERSTANDING (reader thinks it's wrong but it's not): explain why the text is correct using an IN-WORLD explanation. Be warm, not condescending. Reference specific story events or established facts.

4. If CLARIFICATION (reader is asking, not reporting): answer their question helpfully and in-character. You're a storyteller explaining your craft, not defending an error. Be delighted they're curious — "Ah, a keen question!"

5. Categorize the issue type. Use "vocabulary" for word meaning questions, "lore_question" for world-building curiosity.

CRITICAL — corrected_text RULES:
- corrected_text replaces ONLY the highlighted text, nothing more
- It must read naturally when inserted between the words immediately before and after the highlight
- Match the story's prose style, voice, and literary register exactly — no clinical or robotic phrasing
- Example: if the surrounding text is "She'd noticed that [HIGHLIGHTED]in Chapter 3[/HIGHLIGHTED] the patterns..." and the fix removes the meta-reference, corrected_text should be something like "over the past few days" — NOT "She'd noticed that over the past few days" (that would duplicate the lead-in)

You are Prospero, the story's narrator-guide. Your response to the reader must be:
- In character: warm, slightly theatrical, but CONCISE
- 1-2 sentences maximum
- If correcting: express delight at the reader's sharp eye, never embarrassment
- If explaining: help the reader understand with a story reference, never condescending

Return ONLY valid JSON:
{
  "interaction_type": "correction|misunderstanding|clarification",
  "is_genuine_issue": true/false,
  "prospero_response": "Your 1-2 sentence in-character response to the reader",
  "category": "name_inconsistency|timeline_error|description_drift|world_rule|plot_thread|vocabulary|lore_question|other",
  "corrected_text": "Drop-in replacement for ONLY the highlighted text (null if not a correction)",
  "reasoning": "Brief internal reasoning about what you found (not shown to reader)"
}`;
}

/**
 * Update the reader's contribution stats (upsert).
 */
async function updateContributionStats(userId, storyId, wasCorrection, wasExplanation, category) {
  try {
    // Check if stats row exists
    const { data: existing } = await supabaseAdmin
      .from('reader_contribution_stats')
      .select('*')
      .eq('user_id', userId)
      .eq('story_id', storyId)
      .maybeSingle();

    if (existing) {
      const updates = {
        total_flags: existing.total_flags + 1,
        updated_at: new Date().toISOString()
      };

      if (wasCorrection) {
        updates.successful_catches = existing.successful_catches + 1;
        const categories = existing.categories_caught || {};
        categories[category] = (categories[category] || 0) + 1;
        updates.categories_caught = categories;
      }

      if (wasExplanation) {
        updates.explanations_received = existing.explanations_received + 1;
      }

      await supabaseAdmin
        .from('reader_contribution_stats')
        .update(updates)
        .eq('id', existing.id);
    } else {
      await supabaseAdmin
        .from('reader_contribution_stats')
        .insert({
          user_id: userId,
          story_id: storyId,
          total_flags: 1,
          successful_catches: wasCorrection ? 1 : 0,
          explanations_received: wasExplanation ? 1 : 0,
          categories_caught: wasCorrection ? { [category]: 1 } : {},
          updated_at: new Date().toISOString()
        });
    }
  } catch (err) {
    // Non-fatal — don't break the flow over stats
    console.error('⚠️ [Prospero Editor] Failed to update contribution stats:', err.message);
  }
}

/**
 * Check if a user has ever used Prospero's Editor (for feature discovery logic).
 * Returns true if user has any rows in reader_contribution_stats.
 */
async function hasUsedProsperosEditor(userId) {
  const { count } = await supabaseAdmin
    .from('reader_contribution_stats')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  return (count || 0) > 0;
}

/**
 * Get a user's correction patterns for generation prompt injection (Learning Loop Layer A).
 * Returns aggregated patterns across all their stories.
 */
async function getUserCorrectionPatterns(userId) {
  const { data: stats } = await supabaseAdmin
    .from('reader_contribution_stats')
    .select('successful_catches, categories_caught')
    .eq('user_id', userId);

  if (!stats || !stats.length) return null;

  const totalCatches = stats.reduce((sum, s) => sum + (s.successful_catches || 0), 0);
  if (totalCatches < 2) return null; // Not enough data to form patterns

  // Aggregate categories across all stories
  const allCategories = {};
  stats.forEach(s => {
    const cats = s.categories_caught || {};
    Object.entries(cats).forEach(([cat, count]) => {
      allCategories[cat] = (allCategories[cat] || 0) + count;
    });
  });

  // Sort by frequency
  const sorted = Object.entries(allCategories).sort((a, b) => b[1] - a[1]);

  return {
    totalCatches,
    topCategories: sorted.slice(0, 3),
    allCategories
  };
}

/**
 * Handle a reader's pushback when they disagree with Prospero's initial assessment.
 * Prospero reconsiders more carefully, but this is the FINAL word — no more rounds.
 *
 * @param {object} params
 * @param {string} params.correctionId - The original reader_corrections record
 * @param {string} params.pushbackText - What the reader said in disagreement
 * @param {string} params.userId
 * @returns {object} { prosperoResponse, wasCorrection, correctedText, reconsidered }
 */
async function handlePushback(params) {
  const { correctionId, pushbackText, userId } = params;
  const startTime = Date.now();

  // Fetch the original investigation record
  const { data: original } = await supabaseAdmin
    .from('reader_corrections')
    .select('*')
    .eq('id', correctionId)
    .single();

  if (!original) {
    throw new Error(`Correction record ${correctionId} not found`);
  }

  // Fetch enriched context for reconsideration
  const [chapterResult, bibleResult, entitiesResult, ledgerResult, worldLedgerResult, codexResult, priorCorrectionsResult] = await Promise.all([
    supabaseAdmin
      .from('chapters')
      .select('content, title')
      .eq('id', original.chapter_id)
      .single(),
    supabaseAdmin
      .from('story_bibles')
      .select('*')
      .eq('story_id', original.story_id)
      .single(),
    supabaseAdmin
      .from('chapter_entities')
      .select('entity_type, entity_name, fact, canonical_value, chapter_number')
      .eq('story_id', original.story_id)
      .order('chapter_number', { ascending: true }),
    supabaseAdmin
      .from('character_ledger_entries')
      .select('chapter_number, entry_data')
      .eq('story_id', original.story_id)
      .lte('chapter_number', original.chapter_number)
      .order('chapter_number', { ascending: false })
      .limit(3),
    supabaseAdmin
      .from('world_state_ledger')
      .select('chapter_number, entry_data')
      .eq('story_id', original.story_id)
      .lte('chapter_number', original.chapter_number)
      .order('chapter_number', { ascending: false })
      .limit(3),
    supabaseAdmin
      .from('world_codex')
      .select('codex_data')
      .eq('story_id', original.story_id)
      .maybeSingle(),
    supabaseAdmin
      .from('reader_corrections')
      .select('chapter_number, highlighted_text, corrected_text, correction_category, was_corrected')
      .eq('story_id', original.story_id)
      .eq('was_corrected', true)
      .order('created_at', { ascending: false })
      .limit(10)
  ]);

  const chapter = chapterResult.data;
  const bible = bibleResult.data;
  const entities = entitiesResult.data || [];
  const ledgerEntries = ledgerResult.data || [];
  const worldLedger = worldLedgerResult.data || [];
  const codex = codexResult.data;
  const priorCorrections = priorCorrectionsResult.data || [];

  const surroundingContext = extractSurroundingContext(
    chapter.content, original.highlight_start, original.highlight_end
  );
  const relevantEntities = buildRelevantEntityContext(entities, original.highlighted_text, pushbackText);
  const bibleReference = buildBibleReference(bible);
  const characterLedgerContext = buildCharacterLedgerContext(ledgerEntries);
  const worldContext = buildWorldContext(worldLedger, codex, original.highlighted_text, pushbackText);
  const priorCorrectionsContext = buildPriorCorrectionsContext(priorCorrections);

  const originalInteractionType = original.interaction_type || 'misunderstanding';

  // Build the reconsideration prompt — deeper thinking this time
  const prompt = `You are Prospero, narrator-guide of a novel. A reader flagged a passage and you gave an initial assessment. The reader is now PUSHING BACK on your assessment. You must reconsider MORE CAREFULLY this time.

HIGHLIGHTED PASSAGE:
"${original.highlighted_text}"

SURROUNDING CONTEXT:
...${surroundingContext.before}[HIGHLIGHTED]${surroundingContext.highlighted}[/HIGHLIGHTED]${surroundingContext.after}...

READER'S ORIGINAL CONCERN:
"${original.reader_description}"

YOUR INITIAL ASSESSMENT:
"${original.prospero_response}"
You said this was ${originalInteractionType === 'clarification' ? 'a clarification question' : original.investigation_result?.is_genuine_issue ? 'a genuine issue' : 'NOT an issue'}.

READER'S PUSHBACK:
"${pushbackText}"

STORY BIBLE (canonical reference):
${bibleReference}

ENTITY LEDGER (facts established in prior chapters):
${relevantEntities}
${characterLedgerContext}${worldContext}${priorCorrectionsContext}
INSTRUCTIONS:
${originalInteractionType === 'clarification'
  ? 'The reader asked for more information. Elaborate on your explanation helpfully and in-character. Answer follow-up questions with warmth.'
  : 'The reader disagrees with you. Take their argument seriously and reconsider with FRESH EYES. Look more carefully at the evidence. The reader may have noticed something you missed, OR your original assessment may have been correct.\n\n- If you NOW agree with the reader: provide corrected_text (same drop-in rules as before — replaces ONLY the highlighted text, fits seamlessly into surrounding words, matches the story\'s prose style).\n- If you STILL disagree: stand your ground warmly but firmly. This is your FINAL WORD.'
}

Either way, this is the last exchange. Your response should feel like a graceful closing — you're sending the reader back to the story.

Return ONLY valid JSON:
{
  "interaction_type": "${originalInteractionType === 'clarification' ? 'clarification' : 'correction|misunderstanding'}",
  "reconsidered": true/false (did you change your mind?),
  "is_genuine_issue": true/false,
  "prospero_response": "Your 1-2 sentence in-character response. If standing firm, end with something warm that sends them back to reading.",
  "category": "${original.correction_category || 'other'}",
  "corrected_text": "Drop-in replacement for ONLY the highlighted text (null if standing firm)",
  "reasoning": "Brief internal reasoning (not shown to reader)"
}`;

  const response = await anthropic.messages.create({
    model: EDITOR_MODEL,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  });

  const inputTokens = response.usage?.input_tokens || 0;
  const outputTokens = response.usage?.output_tokens || 0;
  const rawResponse = response.content[0]?.text || '';

  let reconsideration;
  try {
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    reconsideration = JSON.parse(jsonMatch[0]);
  } catch (parseErr) {
    console.error('❌ [Prospero Editor] Failed to parse pushback response:', parseErr.message);
    reconsideration = {
      reconsidered: false,
      is_genuine_issue: false,
      prospero_response: "Perhaps we see this passage through different lenses, dear reader. Let's leave this one on the page for now and find out what happens next!",
      category: original.correction_category || 'other',
      corrected_text: null
    };
  }

  const investigationTimeMs = Date.now() - startTime;

  // Determine if author + genuine issue = correction
  const isAuthor = original.is_author;
  const wasCorrection = reconsideration.is_genuine_issue === true && isAuthor && reconsideration.corrected_text;

  if (wasCorrection) {
    // Apply the correction to the chapter
    const updatedContent = chapter.content.substring(0, original.highlight_start)
      + reconsideration.corrected_text
      + chapter.content.substring(original.highlight_end);

    await supabaseAdmin
      .from('chapters')
      .update({ content: updatedContent })
      .eq('id', original.chapter_id);
  }

  // Update the original correction record with pushback info
  await supabaseAdmin
    .from('reader_corrections')
    .update({
      investigation_result: {
        ...original.investigation_result,
        pushback_text: pushbackText,
        pushback_response: reconsideration,
        reconsidered: reconsideration.reconsidered
      },
      was_corrected: wasCorrection || original.was_corrected,
      corrected_text: wasCorrection ? reconsideration.corrected_text : original.corrected_text
    })
    .eq('id', correctionId);

  // Log API cost
  await logApiCost(userId, 'prospero_editor_pushback', inputTokens, outputTokens, {
    storyId: original.story_id,
    chapterNumber: original.chapter_number,
    reconsidered: reconsideration.reconsidered,
    investigationTimeMs
  });

  console.log(`🔍 [Prospero Editor] Pushback handled: ${reconsideration.reconsidered ? 'RECONSIDERED' : 'STOOD FIRM'} in ${investigationTimeMs}ms`);

  return {
    prosperoResponse: reconsideration.prospero_response,
    wasCorrection: !!wasCorrection,
    correctedText: wasCorrection ? reconsideration.corrected_text : null,
    reconsidered: reconsideration.reconsidered,
    isGenuineIssue: reconsideration.is_genuine_issue,
    interactionType: reconsideration.interaction_type || originalInteractionType,
    investigationTimeMs
  };
}

module.exports = {
  investigatePassage,
  handlePushback,
  hasUsedProsperosEditor,
  getUserCorrectionPatterns
};
