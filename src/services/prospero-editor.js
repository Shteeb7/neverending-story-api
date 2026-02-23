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

const EDITOR_MODEL = 'claude-haiku-4-5-20251001';

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
  const [chapterResult, bibleResult, entitiesResult] = await Promise.all([
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
      .order('chapter_number', { ascending: true })
  ]);

  const chapter = chapterResult.data;
  const bible = bibleResult.data;
  const entities = entitiesResult.data || [];

  if (!chapter) {
    throw new Error(`Chapter ${chapterId} not found`);
  }

  // Build surrounding context (paragraph before and after the highlight)
  const surroundingContext = extractSurroundingContext(chapter.content, highlightStart, highlightEnd);

  // Build entity reference for relevant characters/locations
  const relevantEntities = buildRelevantEntityContext(entities, highlightedText, readerDescription);

  // Build bible reference
  const bibleReference = buildBibleReference(bible);

  // Single Haiku call: investigate + generate Prospero's response
  const prompt = buildInvestigationPrompt({
    highlightedText,
    surroundingContext,
    readerDescription,
    bibleReference,
    relevantEntities,
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
 * Build the investigation prompt for Haiku.
 */
function buildInvestigationPrompt({ highlightedText, surroundingContext, readerDescription, bibleReference, relevantEntities, chapterNumber, chapterTitle }) {
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

INSTRUCTIONS:
1. Determine if the reader has found a genuine inconsistency with the story bible or previously established facts.
2. If YES (genuine issue): provide corrected_text that is a DROP-IN REPLACEMENT for the exact highlighted text shown above. The corrected_text will be spliced directly into the sentence at the exact position of the highlighted text — so it must fit grammatically and seamlessly into the surrounding words. Do NOT repeat words that already appear before or after the highlight. Change the minimum words necessary.
3. If NO (text is actually correct): explain why, using an IN-WORLD explanation (reference story events, not technical details). Set corrected_text to null.
4. Categorize the issue type.

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
  "is_genuine_issue": true/false,
  "prospero_response": "Your 1-2 sentence in-character response to the reader",
  "category": "name_inconsistency|timeline_error|description_drift|world_rule|plot_thread|other",
  "corrected_text": "Drop-in replacement for ONLY the highlighted text (null if no issue)",
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

module.exports = {
  investigatePassage,
  hasUsedProsperosEditor,
  getUserCorrectionPatterns
};
