const { anthropic } = require('../config/ai-clients');
const { supabaseAdmin } = require('../config/supabase');
const { storyLog } = require('./story-logger');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Calculate cost for Haiku API call
 * Haiku pricing: $0.40/M input, $2/M output
 */
function calculateHaikuCost(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1_000_000) * 0.40;
  const outputCost = (outputTokens / 1_000_000) * 2.00;
  return inputCost + outputCost;
}

/**
 * Refresh bible after a batch of chapters completes
 * Extracts new facts established during generation and appends to bible
 *
 * @param {string} storyId
 * @param {number[]} batchChapterNumbers - e.g., [1, 2, 3]
 * @param {string} userId - for cost tracking
 * @returns {Object} { success: boolean, addendum: object }
 */
async function refreshBible(storyId, batchChapterNumbers, userId) {
  const startTime = Date.now();
  const batchNumber = Math.ceil(batchChapterNumbers[batchChapterNumbers.length - 1] / 3);

  try {
    // Fetch current bible
    const { data: bible, error: bibleError } = await supabaseAdmin
      .from('story_bibles')
      .select('*')
      .eq('story_id', storyId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (bibleError || !bible) {
      throw new Error(`Bible not found: ${bibleError?.message || 'No bible returned'}`);
    }

    // Check if this batch has already been processed (idempotency)
    const existingAddenda = bible.content?.batch_addenda || [];
    const alreadyProcessed = existingAddenda.some(a =>
      a.batch_number === batchNumber ||
      (a.chapters_covered && JSON.stringify(a.chapters_covered) === JSON.stringify(batchChapterNumbers))
    );

    if (alreadyProcessed) {
      console.log(`📚 [${bible.title}] Bible refresh: Batch ${batchNumber} already processed, skipping`);
      return { success: true, addendum: null, skipped: true };
    }

    // Fetch chapters from this batch
    const { data: chapters, error: chaptersError } = await supabaseAdmin
      .from('chapters')
      .select('chapter_number, title, content, metadata')
      .eq('story_id', storyId)
      .in('chapter_number', batchChapterNumbers)
      .order('chapter_number', { ascending: true });

    if (chaptersError || !chapters || chapters.length === 0) {
      throw new Error(`Failed to fetch chapters: ${chaptersError?.message || 'No chapters found'}`);
    }

    // Fetch world state ledger for these chapters
    const { data: worldLedger } = await supabaseAdmin
      .from('world_state_ledger')
      .select('*')
      .eq('story_id', storyId)
      .in('chapter_number', batchChapterNumbers)
      .order('chapter_number', { ascending: true });

    // Fetch character ledger for these chapters
    const { data: characterLedger } = await supabaseAdmin
      .from('character_ledger')
      .select('*')
      .eq('story_id', storyId)
      .in('chapter_number', batchChapterNumbers)
      .order('chapter_number', { ascending: true });

    // Build context blocks
    const chaptersContext = chapters.map(ch => `
Chapter ${ch.chapter_number}: ${ch.title}
Key events: ${(ch.metadata?.key_events || []).join('; ')}
Content excerpt (first 500 chars): ${ch.content.substring(0, 500)}...
`).join('\n\n');

    const worldContext = worldLedger && worldLedger.length > 0
      ? worldLedger.map(entry => `Ch${entry.chapter_number}: ${JSON.stringify(entry.world_state_snapshot || entry.content)}`).join('\n')
      : 'No world ledger entries';

    const characterContext = characterLedger && characterLedger.length > 0
      ? characterLedger.map(entry => `Ch${entry.chapter_number}: ${JSON.stringify(entry.character_states || entry.content)}`).join('\n')
      : 'No character ledger entries';

    // Call Haiku to extract new facts
    const prompt = `You are a story bible editor. Three new chapters have been written. Your job is to identify NEW facts established in these chapters that are NOT already in the original bible.

DO NOT repeat what's already in the bible. Only extract NEWLY established information:

1. NEW CHARACTERS: Any characters introduced in these chapters that aren't in the original bible (name, role, relationship to existing characters, key traits)
2. NEW LOCATIONS: Any locations described for the first time (name, description, significance)
3. NEW WORLD FACTS: Any world rules demonstrated, clarified, or expanded (how magic/technology/systems actually work in practice vs. theory)
4. RELATIONSHIP CHANGES: Any significant shifts in character relationships (alliances formed, betrayals, revelations that change dynamics)
5. TIMELINE EVENTS: Key events that occurred and their consequences (what happened, who was affected, what changed)
6. PROMISES MADE: Foreshadowing, unresolved questions, or narrative threads opened that need to be addressed later

<original_bible>
${JSON.stringify(bible.content, null, 2)}
</original_bible>

<chapters>
${chaptersContext}
</chapters>

<world_ledger>
${worldContext}
</world_ledger>

<character_ledger>
${characterContext}
</character_ledger>

Return ONLY valid JSON in this exact structure:
{
  "batch_number": ${batchNumber},
  "chapters_covered": [${batchChapterNumbers.join(', ')}],
  "new_characters": [
    { "name": "...", "role": "...", "first_appearance": "Ch X", "key_traits": "..." }
  ],
  "new_locations": [
    { "name": "...", "description": "...", "first_appearance": "Ch X" }
  ],
  "new_world_facts": [
    { "description": "...", "established_in": "Ch X" }
  ],
  "relationship_changes": [
    { "characters": ["A", "B"], "change": "...", "chapter": "Ch X" }
  ],
  "timeline_events": [
    { "event": "...", "chapter": "Ch X", "consequences": "..." }
  ],
  "promises_made": [
    { "thread": "...", "chapter": "Ch X", "resolution_needed": "..." }
  ]
}`;

    const response = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const duration = Date.now() - startTime;

    // Log API cost
    const cost = calculateHaikuCost(inputTokens, outputTokens);
    await supabaseAdmin
      .from('api_costs')
      .insert({
        user_id: userId,
        story_id: storyId,
        provider: 'claude',
        model: HAIKU_MODEL,
        operation: 'bible_refresh',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        cost,
        metadata: { batch_number: batchNumber, chapters: batchChapterNumbers }
      });

    // Parse response
    let jsonText = response.content[0].text.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
    }

    const addendum = JSON.parse(jsonText);

    // Append to bible
    existingAddenda.push(addendum);

    await supabaseAdmin
      .from('story_bibles')
      .update({
        content: { ...bible.content, batch_addenda: existingAddenda },
        updated_at: new Date().toISOString()
      })
      .eq('id', bible.id);

    const newChars = addendum.new_characters?.length || 0;
    const newLocs = addendum.new_locations?.length || 0;
    const newFacts = addendum.new_world_facts?.length || 0;

    storyLog(
      storyId,
      bible.title,
      `📚 [${bible.title}] Bible refresh after batch ${batchNumber}: ${newChars} new characters, ${newLocs} locations, ${newFacts} world facts (${duration}ms)`
    );

    return { success: true, addendum, inputTokens, outputTokens, duration };
  } catch (error) {
    storyLog(
      storyId,
      'Unknown',
      `❌ Bible refresh failed for batch ${batchNumber}: ${error.message}`
    );
    throw error;
  }
}

/**
 * Enrich arc after a batch of chapters completes
 * Compares planned vs. actual events, annotates upcoming chapters
 *
 * @param {string} storyId
 * @param {number[]} completedBatchChapterNumbers - e.g., [1, 2, 3]
 * @param {string} userId - for cost tracking
 * @returns {Object} { success: boolean, enrichmentNotes: object, deviations: array }
 */
async function enrichArc(storyId, completedBatchChapterNumbers, userId) {
  const startTime = Date.now();
  const batchNumber = Math.ceil(completedBatchChapterNumbers[completedBatchChapterNumbers.length - 1] / 3);

  try {
    // Fetch story arc
    const { data: arc, error: arcError } = await supabaseAdmin
      .from('story_arcs')
      .select('*')
      .eq('story_id', storyId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (arcError || !arc) {
      throw new Error(`Arc not found: ${arcError?.message || 'No arc returned'}`);
    }

    // Check if this batch has already been enriched (idempotency)
    const enrichmentHistory = arc.outline?.enrichment_history || [];
    const alreadyEnriched = enrichmentHistory.some(entry =>
      JSON.stringify(entry.batch_reviewed) === JSON.stringify(completedBatchChapterNumbers)
    );

    if (alreadyEnriched) {
      console.log(`🔄 Arc enrichment: Batch ${batchNumber} already processed, skipping`);
      return { success: true, enrichmentNotes: {}, deviations: [], skipped: true };
    }

    // Fetch completed chapters
    const { data: completedChapters, error: chaptersError } = await supabaseAdmin
      .from('chapters')
      .select('chapter_number, title, content, metadata')
      .eq('story_id', storyId)
      .in('chapter_number', completedBatchChapterNumbers)
      .order('chapter_number', { ascending: true });

    if (chaptersError || !completedChapters || completedChapters.length === 0) {
      throw new Error(`Failed to fetch chapters: ${chaptersError?.message}`);
    }

    // Fetch story and bible for title
    const { data: story } = await supabaseAdmin
      .from('stories')
      .select('title')
      .eq('id', storyId)
      .single();

    const storyTitle = story?.title || 'Untitled';

    // Build context blocks
    const completedChaptersArcPlan = arc.outline.chapters
      .filter(ch => completedBatchChapterNumbers.includes(ch.chapter_number))
      .map(ch => `Chapter ${ch.chapter_number}: ${ch.title}
Events planned: ${ch.events_summary}
Key revelations planned: ${(ch.key_revelations || []).join('; ')}
Character focus: ${ch.character_focus}
`).join('\n\n');

    const whatActuallyHappened = completedChapters.map(ch => `Chapter ${ch.chapter_number}: ${ch.title}
Key events (actual): ${(ch.metadata?.key_events || []).join('; ')}
Character development (actual): ${ch.metadata?.character_development || 'N/A'}
`).join('\n\n');

    const upcomingChapterOutlines = arc.outline.chapters
      .filter(ch => ch.chapter_number > completedBatchChapterNumbers[completedBatchChapterNumbers.length - 1])
      .map(ch => `Chapter ${ch.chapter_number}: ${ch.title}
Events planned: ${ch.events_summary}
Character focus: ${ch.character_focus}
Tension level: ${ch.tension_level}
`).join('\n\n');

    // Fetch bible for timeline (if exists)
    const { data: bible } = await supabaseAdmin
      .from('story_bibles')
      .select('content')
      .eq('story_id', storyId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const bibleTimeline = bible?.content?.timeline
      ? JSON.stringify(bible.content.timeline, null, 2)
      : 'No timeline in bible';

    // Call Haiku for arc enrichment
    const prompt = `You are a story arc editor. A batch of chapters has been written. Compare what the arc outline PLANNED for these chapters vs. what ACTUALLY happened, then provide adjustment notes for upcoming chapters.

<completed_chapters_arc_plan>
${completedChaptersArcPlan}
</completed_chapters_arc_plan>

<what_actually_happened>
${whatActuallyHappened}
</what_actually_happened>

<upcoming_chapter_outlines>
${upcomingChapterOutlines}
</upcoming_chapter_outlines>

<current_bible_timeline>
${bibleTimeline}
</current_bible_timeline>

For each upcoming chapter, provide enrichment notes ONLY if something from the completed batch affects it. Don't annotate chapters that don't need adjustment.

Enrichment notes should be specific: "In Ch3, the protagonist already discovered X, so Ch7's planned reveal of X should be adjusted to a deeper implication of X" — NOT vague like "consider adjusting."

Also flag any cases where the bible timeline and the arc outline give conflicting signals about upcoming events (bible-to-arc reconciliation).

Return ONLY valid JSON in this exact structure:
{
  "batch_reviewed": [${completedBatchChapterNumbers.join(', ')}],
  "deviations": [
    { "chapter": 2, "planned": "X was supposed to happen", "actual": "Y happened instead", "impact": "Affects Ch 7 and 9" }
  ],
  "enrichment_notes": {
    "4": "Specific note for chapter 4 based on what happened in batch 1",
    "7": "Specific note for chapter 7..."
  },
  "bible_arc_conflicts": [
    { "description": "Bible timeline says X happens in Ch6, but arc moved it to Ch5", "recommendation": "Constraint extractor should use arc timing, not bible timing" }
  ]
}`;

    const response = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const duration = Date.now() - startTime;

    // Log API cost
    const cost = calculateHaikuCost(inputTokens, outputTokens);
    await supabaseAdmin
      .from('api_costs')
      .insert({
        user_id: userId,
        story_id: storyId,
        provider: 'claude',
        model: HAIKU_MODEL,
        operation: 'arc_enrichment',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        cost,
        metadata: { batch_number: batchNumber, chapters: completedBatchChapterNumbers }
      });

    // Parse response
    let jsonText = response.content[0].text.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
    }

    const enrichmentResult = JSON.parse(jsonText);

    // Update arc outline with enrichment notes
    const updatedChapters = arc.outline.chapters.map(ch => {
      const note = enrichmentResult.enrichment_notes[String(ch.chapter_number)];
      if (note) {
        return { ...ch, enrichment_notes: note };
      }
      return ch;
    });

    // Add to enrichment history
    enrichmentHistory.push({
      batch_reviewed: completedBatchChapterNumbers,
      deviations: enrichmentResult.deviations || [],
      bible_arc_conflicts: enrichmentResult.bible_arc_conflicts || [],
      timestamp: new Date().toISOString()
    });

    await supabaseAdmin
      .from('story_arcs')
      .update({
        outline: {
          ...arc.outline,
          chapters: updatedChapters,
          enrichment_history: enrichmentHistory
        }
      })
      .eq('id', arc.id);

    const deviationCount = (enrichmentResult.deviations || []).length;
    const enrichmentCount = Object.keys(enrichmentResult.enrichment_notes || {}).length;

    storyLog(
      storyId,
      storyTitle,
      `🔄 [${storyTitle}] Arc enrichment after batch ${batchNumber}: ${deviationCount} deviations found, ${enrichmentCount} chapters annotated (${duration}ms)`
    );

    // Log bible-arc conflicts if any
    if (enrichmentResult.bible_arc_conflicts && enrichmentResult.bible_arc_conflicts.length > 0) {
      enrichmentResult.bible_arc_conflicts.forEach(conflict => {
        storyLog(storyId, storyTitle, `⚠️ [${storyTitle}] Bible-arc conflict: ${conflict.description}`);
      });
    }

    return {
      success: true,
      enrichmentNotes: enrichmentResult.enrichment_notes,
      deviations: enrichmentResult.deviations,
      bibleArcConflicts: enrichmentResult.bible_arc_conflicts,
      inputTokens,
      outputTokens,
      duration
    };
  } catch (error) {
    storyLog(
      storyId,
      'Unknown',
      `❌ Arc enrichment failed for batch ${batchNumber}: ${error.message}`
    );
    throw error;
  }
}

module.exports = {
  refreshBible,
  enrichArc
};
