/**
 * World Continuity System
 *
 * Mirrors the character ledger pattern (character-intelligence.js) for world state.
 * Tracks world facts, rules demonstrated, geography revealed, timeline progression,
 * and reader promises chapter-by-chapter.
 *
 * Three core functions:
 * 1. extractWorldStateLedger() — post-generation extraction (Haiku)
 * 2. buildWorldContextBlock() — pre-generation context assembly
 * 3. compressWorldLedgerEntry() — token budget management
 */

const { anthropic } = require('../config/ai-clients');
const { supabaseAdmin } = require('../config/supabase');

const HAIKU_PRICING = {
  INPUT_PER_MILLION: 1,
  OUTPUT_PER_MILLION: 5,
  MODEL: 'claude-haiku-4-5-20251001'
};

/**
 * Strip markdown code blocks from Claude response before JSON parsing
 */
function stripMarkdownCodeBlocks(text) {
  const stripped = text.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '');
  return stripped.trim();
}

/**
 * Calculate cost in USD for Haiku API calls
 */
function calculateHaikuCost(inputTokens, outputTokens) {
  return ((inputTokens * HAIKU_PRICING.INPUT_PER_MILLION) + (outputTokens * HAIKU_PRICING.OUTPUT_PER_MILLION)) / 1000000;
}

/**
 * Extract world state from a newly generated chapter.
 * Runs after chapter quality pass, parallel to character ledger extraction.
 *
 * @param {string} storyId
 * @param {number} chapterNumber
 * @param {string} chapterContent - Full chapter text
 * @param {string} userId - For cost tracking
 * @returns {Object|null} The ledger data, or null on failure
 */
async function extractWorldStateLedger(storyId, chapterNumber, chapterContent, userId) {
  const startTime = Date.now();

  // Fetch world codex for reference
  const { data: codex } = await supabaseAdmin
    .from('world_codex')
    .select('codex_data')
    .eq('story_id', storyId)
    .maybeSingle();

  // Fetch previous ledger entries for context on what's already established
  const { data: previousEntries } = await supabaseAdmin
    .from('world_state_ledger')
    .select('chapter_number, ledger_data')
    .eq('story_id', storyId)
    .lt('chapter_number', chapterNumber)
    .order('chapter_number', { ascending: false })
    .limit(3);

  const previousFactsSummary = previousEntries && previousEntries.length > 0
    ? previousEntries.map(e => {
        const facts = e.ledger_data?.facts_established || [];
        return `Ch${e.chapter_number}: ${facts.map(f => f.fact).join('; ')}`;
      }).join('\n')
    : 'No previous world facts established yet.';

  const prompt = `You are tracking world-state consistency for a serialized novel. Your job: extract what THIS chapter reveals or demonstrates about the world.

${codex ? `<world_codex>
The structured rules of this world:
${JSON.stringify(codex.codex_data, null, 2)}
</world_codex>` : ''}

<previously_established>
${previousFactsSummary}
</previously_established>

<chapter_${chapterNumber}>
${chapterContent}
</chapter_${chapterNumber}>

Extract what this chapter adds to the reader's understanding of the world:

1. FACTS ESTABLISHED — New things the reader now knows about this world that weren't explicitly stated before.
   - Only include facts DEMONSTRATED or STATED in the text, not assumptions.
   - Category: magic_system, technology, geography, politics, social, biology, history, timeline, other
   - Immutable: true if this is bedrock fact, false if it could change

2. RULES DEMONSTRATED — Which world rules were SHOWN IN ACTION (not just mentioned)?
   - How was the rule invoked? What was the consequence?
   - Note if the demonstration was consistent with or contradicted the codex.

3. GEOGRAPHY REVEALED — New locations, spatial relationships, or travel details established.

4. TIMELINE PROGRESSION — How much time passed in this chapter? What's the rough position in the story's timeline?

5. READER PROMISES — Any implicit or explicit promises to the reader about future revelations?
   - "The locked room will be explained" / "The magic's true origin will be revealed"
   - Status: pending (new), advanced (progress made), fulfilled (resolved)

Be PRECISE. Only extract what the TEXT actually establishes. Do not infer or speculate.

Return ONLY valid JSON:
{
  "chapter": ${chapterNumber},
  "facts_established": [
    { "fact": "specific fact", "category": "category", "immutable": true }
  ],
  "rules_demonstrated": [
    { "rule": "rule name from codex or new rule", "how": "how it was shown", "outcome": "what happened", "consistent_with_codex": true }
  ],
  "geography_revealed": [
    { "location": "name", "details": "what was revealed", "connections": "spatial relationships" }
  ],
  "timeline_progression": {
    "time_elapsed": "how much time passed",
    "current_position": "rough position in overall timeline"
  },
  "reader_promises": [
    { "promise": "what was promised", "status": "pending", "planted_in": ${chapterNumber} }
  ]
}`;

  try {
    const response = await anthropic.messages.create({
      model: HAIKU_PRICING.MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = response.content[0].text;
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    // Parse response
    let parsed;
    try {
      parsed = JSON.parse(stripMarkdownCodeBlocks(responseText));
    } catch (parseErr) {
      console.error(`🌍 World ledger parse error for ch${chapterNumber}: ${parseErr.message}`);
      return null;
    }

    // Merge reader promises with previous entries (update status of existing promises)
    const allPreviousPromises = (previousEntries || [])
      .flatMap(e => e.ledger_data?.reader_promises || []);

    const newPromises = parsed.reader_promises || [];
    const mergedPromises = mergeReaderPromises(allPreviousPromises, newPromises, chapterNumber);
    parsed.reader_promises = mergedPromises;

    // Estimate token count for this entry
    const ledgerStr = JSON.stringify(parsed);
    const tokenEstimate = Math.ceil(ledgerStr.length / 4);

    // Upsert into world_state_ledger
    const { error: upsertError } = await supabaseAdmin
      .from('world_state_ledger')
      .upsert({
        story_id: storyId,
        chapter_number: chapterNumber,
        ledger_data: parsed,
        token_count: tokenEstimate
      }, { onConflict: 'story_id,chapter_number' });

    if (upsertError) {
      console.error(`🌍 World ledger DB error for ch${chapterNumber}: ${upsertError.message}`);
      return null;
    }

    const elapsed = Date.now() - startTime;
    const cost = calculateHaikuCost(inputTokens, outputTokens);
    console.log(`🌍 World ledger extracted for ch${chapterNumber}: ${parsed.facts_established?.length || 0} facts, ${parsed.rules_demonstrated?.length || 0} rules demonstrated, ${mergedPromises.filter(p => p.status === 'pending').length} pending promises (${elapsed}ms, $${cost.toFixed(4)})`);

    // Log cost
    try {
      await supabaseAdmin.from('api_costs').insert({
        user_id: userId,
        story_id: storyId,
        provider: 'anthropic',
        model: HAIKU_PRICING.MODEL,
        operation: 'world_ledger_extraction',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        cost: cost,
        metadata: {
          chapterNumber,
          facts_count: parsed.facts_established?.length || 0,
          rules_count: parsed.rules_demonstrated?.length || 0,
          promises_pending: mergedPromises.filter(p => p.status === 'pending').length,
          duration_ms: elapsed
        }
      });
    } catch (costErr) {
      // Non-fatal
    }

    return parsed;
  } catch (err) {
    console.error(`🌍 World ledger extraction failed for ch${chapterNumber}: ${err.message}`);
    return null;
  }
}

/**
 * Merge reader promises across chapters. Updates status of existing promises
 * and adds new ones. Deduplicates by promise text.
 */
function mergeReaderPromises(previousPromises, newPromises, currentChapter) {
  const promiseMap = new Map();

  // Add all previous promises
  for (const p of previousPromises) {
    promiseMap.set(p.promise, { ...p });
  }

  // Merge new promises (newer status wins)
  for (const p of newPromises) {
    const existing = promiseMap.get(p.promise);
    if (existing) {
      // Update status if it advanced
      if (p.status === 'fulfilled' || (p.status === 'advanced' && existing.status === 'pending')) {
        promiseMap.set(p.promise, { ...existing, status: p.status });
      }
    } else {
      promiseMap.set(p.promise, { ...p, planted_in: p.planted_in || currentChapter });
    }
  }

  return Array.from(promiseMap.values());
}

/**
 * Compress a world ledger entry into a brief text summary.
 * Used for older chapters (distance > 3) to save token budget.
 *
 * @param {Object} ledgerData - Full ledger_data from a world_state_ledger entry
 * @returns {string} Compressed text summary
 */
function compressWorldLedgerEntry(ledgerData) {
  const parts = [];

  // Compress facts
  const facts = ledgerData.facts_established || [];
  if (facts.length > 0) {
    parts.push(`Facts: ${facts.map(f => f.fact).join('; ')}`);
  }

  // Compress rules demonstrated
  const rules = ledgerData.rules_demonstrated || [];
  if (rules.length > 0) {
    parts.push(`Rules shown: ${rules.map(r => `${r.rule} (${r.outcome})`).join('; ')}`);
  }

  // Compress geography
  const geo = ledgerData.geography_revealed || [];
  if (geo.length > 0) {
    parts.push(`Locations: ${geo.map(g => `${g.location}: ${g.details}`).join('; ')}`);
  }

  // Timeline
  const timeline = ledgerData.timeline_progression;
  if (timeline) {
    parts.push(`Time: ${timeline.time_elapsed || 'unknown'} elapsed (${timeline.current_position || ''})`);
  }

  return parts.join(' | ') || 'No significant world changes.';
}

/**
 * Build the world context block for injection into a chapter generation prompt.
 * Replaces the old JSON.stringify(bible.world_rules) dump with structured,
 * chapter-relevant context including codex + accumulated world state.
 *
 * @param {string} storyId
 * @param {number} targetChapterNumber - The chapter about to be generated
 * @param {Object} chapterOutline - The outline for this chapter (title, events_summary, etc.)
 * @returns {string} XML block for injection into chapter prompt, or empty string
 */
async function buildWorldContextBlock(storyId, targetChapterNumber, chapterOutline) {
  try {
    // Fetch world codex
    const { data: codex } = await supabaseAdmin
      .from('world_codex')
      .select('codex_data, token_count')
      .eq('story_id', storyId)
      .maybeSingle();

    if (!codex) {
      return ''; // No codex — caller will fall back to old world_rules dump
    }

    // Fetch all previous world ledger entries
    const { data: ledgerEntries } = await supabaseAdmin
      .from('world_state_ledger')
      .select('*')
      .eq('story_id', storyId)
      .lt('chapter_number', targetChapterNumber)
      .order('chapter_number', { ascending: false });

    // Build codex section
    const codexData = codex.codex_data;
    const codexXml = buildCodexXml(codexData);

    // Build world state progression (with compression)
    let worldStateXml = '';
    if (ledgerEntries && ledgerEntries.length > 0) {
      const compressedEntries = [];

      for (const entry of ledgerEntries) {
        const distance = targetChapterNumber - entry.chapter_number;

        if (distance <= 3) {
          compressedEntries.push({
            chapter: entry.chapter_number,
            type: 'full',
            data: entry.ledger_data
          });
        } else {
          // Use compressed_summary if available, otherwise compress now
          const summary = entry.compressed_summary || compressWorldLedgerEntry(entry.ledger_data);

          // Save compressed_summary back if it wasn't stored
          if (!entry.compressed_summary) {
            await supabaseAdmin
              .from('world_state_ledger')
              .update({ compressed_summary: summary })
              .eq('id', entry.id);
          }

          compressedEntries.push({
            chapter: entry.chapter_number,
            type: 'compressed',
            summary: summary
          });
        }
      }

      worldStateXml = compressedEntries.map(entry => {
        if (entry.type === 'full') {
          return `  <chapter_${entry.chapter}_world>
${JSON.stringify(entry.data, null, 4)}
  </chapter_${entry.chapter}_world>`;
        } else {
          return `  <chapter_${entry.chapter}_world_summary>
${entry.summary}
  </chapter_${entry.chapter}_world_summary>`;
        }
      }).join('\n');
    }

    // Collect all pending reader promises
    const allPromises = (ledgerEntries || [])
      .flatMap(e => e.ledger_data?.reader_promises || [])
      .filter(p => p.status === 'pending' || p.status === 'advanced');

    // Deduplicate promises (keep most recent status)
    const promiseMap = new Map();
    for (const p of allPromises) {
      const existing = promiseMap.get(p.promise);
      if (!existing || p.status === 'advanced') {
        promiseMap.set(p.promise, p);
      }
    }
    const pendingPromises = Array.from(promiseMap.values());

    // Assemble the full world context block
    let block = `
<world_continuity>
  <instruction>
    These are the RULES and ESTABLISHED FACTS of this story's world.
    They are NON-NEGOTIABLE unless the plot explicitly establishes a rule change.
    A chapter that contradicts an established world rule or fact is a FAILED chapter.

    Use this world context to ensure:
    1. World systems (magic, technology, politics, etc.) operate consistently
    2. Geography and spatial relationships are respected
    3. Timeline progresses logically
    4. Facts established in earlier chapters are honored, not contradicted
    5. Reader promises are advanced toward fulfillment, not forgotten
  </instruction>

  <world_codex>
${codexXml}
  </world_codex>`;

    if (worldStateXml) {
      block += `

  <world_state_progression>
    What has been established in prior chapters — these facts are NOW PART OF THE STORY:
${worldStateXml}
  </world_state_progression>`;
    }

    if (pendingPromises.length > 0) {
      block += `

  <reader_promises>
    The following promises have been planted for the reader. Advance or fulfill them when narratively appropriate:
${pendingPromises.map(p => `    - ${p.promise} (planted ch${p.planted_in}, status: ${p.status})`).join('\n')}
  </reader_promises>`;
    }

    block += `
</world_continuity>`;

    // Token budget guard
    const MAX_WORLD_TOKENS = 5000;
    const estimatedTokens = Math.ceil(block.length / 4);

    if (estimatedTokens > MAX_WORLD_TOKENS) {
      console.log(`⚠️ World context block exceeds budget (${estimatedTokens} est. tokens > ${MAX_WORLD_TOKENS}). Compressing older entries.`);
      // Rebuild with tighter compression: only keep last 2 chapters as full
      return await buildWorldContextBlockTight(storyId, targetChapterNumber, codex, ledgerEntries, pendingPromises);
    }

    return block;
  } catch (err) {
    console.error(`🌍 buildWorldContextBlock failed: ${err.message}`);
    return '';
  }
}

/**
 * Tighter version of buildWorldContextBlock — only keeps last 2 chapters full.
 * Called when the standard version exceeds token budget.
 */
async function buildWorldContextBlockTight(storyId, targetChapterNumber, codex, ledgerEntries, pendingPromises) {
  const codexXml = buildCodexXml(codex.codex_data);

  const worldStateXml = (ledgerEntries || []).map(entry => {
    const distance = targetChapterNumber - entry.chapter_number;
    if (distance <= 2) {
      return `  <chapter_${entry.chapter_number}_world>
${JSON.stringify(entry.ledger_data, null, 4)}
  </chapter_${entry.chapter_number}_world>`;
    } else {
      const summary = entry.compressed_summary || compressWorldLedgerEntry(entry.ledger_data);
      return `  <chapter_${entry.chapter_number}_world_summary>
${summary}
  </chapter_${entry.chapter_number}_world_summary>`;
    }
  }).join('\n');

  let block = `
<world_continuity>
  <instruction>
    These are the RULES and ESTABLISHED FACTS of this story's world. NON-NEGOTIABLE.
    A chapter that contradicts an established world rule or fact is a FAILED chapter.
  </instruction>

  <world_codex>
${codexXml}
  </world_codex>

  <world_state_progression>
${worldStateXml}
  </world_state_progression>`;

  if (pendingPromises.length > 0) {
    block += `

  <reader_promises>
${pendingPromises.map(p => `    - ${p.promise} (planted ch${p.planted_in}, status: ${p.status})`).join('\n')}
  </reader_promises>`;
  }

  block += `
</world_continuity>`;

  return block;
}

/**
 * Format codex data as readable XML for prompt injection.
 */
function buildCodexXml(codexData) {
  const parts = [];

  // Systems (magic, technology, etc.)
  const systems = codexData.systems || [];
  if (systems.length > 0) {
    parts.push('    <systems>');
    for (const system of systems) {
      parts.push(`      <system name="${system.name}">`);
      for (const rule of (system.rules || [])) {
        parts.push(`        <rule scope="${rule.scope || 'general'}" immutable="${rule.immutable !== false}">`);
        parts.push(`          ${rule.rule}`);
        if (rule.cost) parts.push(`          Cost: ${rule.cost}`);
        if (rule.exceptions) parts.push(`          Exceptions: ${rule.exceptions}`);
        parts.push(`        </rule>`);
      }
      parts.push(`      </system>`);
    }
    parts.push('    </systems>');
  }

  // Factions
  const factions = codexData.factions || [];
  if (factions.length > 0) {
    parts.push('    <factions>');
    for (const faction of factions) {
      const rels = faction.relationships ? Object.entries(faction.relationships).map(([k, v]) => `${k}: ${v}`).join(', ') : '';
      parts.push(`      <faction name="${faction.name}" goals="${faction.goals}" methods="${faction.methods}"${rels ? ` relationships="${rels}"` : ''} />`);
    }
    parts.push('    </factions>');
  }

  // Geography
  const geography = codexData.geography || [];
  if (geography.length > 0) {
    parts.push('    <geography>');
    for (const loc of geography) {
      parts.push(`      <location name="${loc.name}" facts="${(loc.facts || []).join('; ')}" connections="${(loc.connections || []).join('; ')}" />`);
    }
    parts.push('    </geography>');
  }

  // Established facts
  const facts = codexData.established_facts || [];
  if (facts.length > 0) {
    parts.push('    <established_facts>');
    for (const fact of facts) {
      parts.push(`      <fact category="${fact.category || 'general'}" immutable="${fact.immutable !== false}">${fact.fact}</fact>`);
    }
    parts.push('    </established_facts>');
  }

  // Timeline anchors
  const anchors = codexData.timeline_anchors || [];
  if (anchors.length > 0) {
    parts.push('    <timeline_anchors>');
    for (const anchor of anchors) {
      parts.push(`      <anchor when="${anchor.when}" significance="${anchor.significance}">${anchor.event}</anchor>`);
    }
    parts.push('    </timeline_anchors>');
  }

  return parts.join('\n');
}

module.exports = {
  extractWorldStateLedger,
  buildWorldContextBlock,
  compressWorldLedgerEntry,
  mergeReaderPromises,
  buildCodexXml
};
