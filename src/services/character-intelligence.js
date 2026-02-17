const { anthropic } = require('../config/ai-clients');
const { supabaseAdmin } = require('../config/supabase');

// Haiku 4.5 pricing for ledger extraction and compression (per million tokens)
const HAIKU_PRICING = {
  INPUT_PER_MILLION: 1,    // Claude Haiku 4.5 input pricing
  OUTPUT_PER_MILLION: 5,   // Claude Haiku 4.5 output pricing
  MODEL: 'claude-haiku-4-5-20251001'
};

// Sonnet 4.5 pricing for voice review and revision (per million tokens)
const SONNET_PRICING = {
  INPUT_PER_MILLION: 3,    // Claude Sonnet 4.5 input pricing
  OUTPUT_PER_MILLION: 15,  // Claude Sonnet 4.5 output pricing
  MODEL: 'claude-sonnet-4-5-20250929'
};

/**
 * Strip markdown code blocks from Claude response before JSON parsing
 */
function stripMarkdownCodeBlocks(text) {
  // Remove ```json ... ``` or ``` ... ``` wrappers if present
  const stripped = text.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '');
  return stripped.trim();
}

/**
 * Calculate cost in USD for Haiku API calls
 */
function calculateHaikuCost(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1_000_000) * HAIKU_PRICING.INPUT_PER_MILLION;
  const outputCost = (outputTokens / 1_000_000) * HAIKU_PRICING.OUTPUT_PER_MILLION;
  return inputCost + outputCost;
}

/**
 * Calculate cost in USD for Sonnet API calls
 */
function calculateSonnetCost(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1_000_000) * SONNET_PRICING.INPUT_PER_MILLION;
  const outputCost = (outputTokens / 1_000_000) * SONNET_PRICING.OUTPUT_PER_MILLION;
  return inputCost + outputCost;
}

/**
 * Log API cost to database for Haiku operations
 */
async function logHaikuCost(userId, storyId, operation, inputTokens, outputTokens, metadata = {}) {
  const totalTokens = inputTokens + outputTokens;
  const cost = calculateHaikuCost(inputTokens, outputTokens);

  try {
    await supabaseAdmin
      .from('api_costs')
      .insert({
        user_id: userId,
        story_id: storyId,
        provider: 'claude',
        model: HAIKU_PRICING.MODEL,
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
 * Log API cost to database for Sonnet operations
 */
async function logApiCost(userId, storyId, operation, inputTokens, outputTokens, metadata = {}) {
  const totalTokens = inputTokens + outputTokens;
  const cost = calculateSonnetCost(inputTokens, outputTokens);

  try {
    await supabaseAdmin
      .from('api_costs')
      .insert({
        user_id: userId,
        story_id: storyId,
        provider: 'claude',
        model: SONNET_PRICING.MODEL,
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
 * Extract character relationship ledger from a newly generated chapter
 * Uses Claude Haiku to create structured JSON tracking each character's subjective experience
 *
 * @param {string} storyId - UUID of the story
 * @param {number} chapterNumber - Chapter number (1-12)
 * @param {string} chapterContent - The full text of the chapter
 * @param {string} userId - UUID of the user (for cost logging)
 * @returns {Promise<Object>} The saved ledger entry
 */
async function extractCharacterLedger(storyId, chapterNumber, chapterContent, userId) {
  try {
    // Fetch story bible for character list
    const { data: bible, error: bibleError } = await supabaseAdmin
      .from('story_bibles')
      .select('*')
      .eq('story_id', storyId)
      .single();

    if (bibleError || !bible) {
      throw new Error(`Story bible not found: ${bibleError?.message || 'No bible returned'}`);
    }

    // Fetch previous ledger entries for callback_bank continuity
    const { data: previousEntries } = await supabaseAdmin
      .from('character_ledger_entries')
      .select('*')
      .eq('story_id', storyId)
      .order('chapter_number', { ascending: false });

    // Build callback bank from previous entries (most recent first)
    let previousCallbacksBlock = '';
    let accumulatedCallbacks = [];

    if (previousEntries && previousEntries.length > 0) {
      // Get callback_bank from most recent entry
      const mostRecentEntry = previousEntries[0];
      if (mostRecentEntry.callback_bank && Array.isArray(mostRecentEntry.callback_bank)) {
        accumulatedCallbacks = mostRecentEntry.callback_bank;
        previousCallbacksBlock = `
<previous_callbacks>
${JSON.stringify(accumulatedCallbacks, null, 2)}
</previous_callbacks>`;
      }
    }

    // Build extraction prompt
    const extractionPrompt = `You are extracting character relationship data from a chapter of a novel.

<story_bible>
<protagonist>
  <name>${bible.characters.protagonist.name}</name>
  <personality>${bible.characters.protagonist.personality}</personality>
  <goals>${bible.characters.protagonist.goals}</goals>
  <fears>${bible.characters.protagonist.fears}</fears>
</protagonist>

<antagonist>
  <name>${bible.characters.antagonist.name}</name>
  <motivation>${bible.characters.antagonist.motivation}</motivation>
</antagonist>

<supporting_characters>
${bible.characters.supporting?.map(sc => `  <character name="${sc.name}" role="${sc.role}">${sc.personality}</character>`).join('\n') || '  None'}
</supporting_characters>
</story_bible>
${previousCallbacksBlock}

<chapter_content>
${chapterContent}
</chapter_content>

Extract a structured ledger entry for this chapter. For EACH major character who appears or is referenced:

1. emotional_state — How are they feeling RIGHT NOW at the end of this chapter? ${chapterNumber > 1 ? 'Reference how this has changed from previous chapters.' : ''}
2. chapter_experience — What happened TO them this chapter, from THEIR perspective (not the narrator's).
3. new_knowledge — What do they now know that they didn't before? Be specific.
4. private_thoughts — What are they thinking that they haven't said out loud?
5. relationship_shifts — For each significant relationship, note: direction (strengthening/deteriorating/complicated/stable), detail (specific to THIS chapter's events), and any unresolved tensions.

Also identify:
- group_dynamics: overall tension level, power balance shifts, unspoken things
- callback_bank updates: new moments worth calling back to later, status updates on existing callbacks (used/expired/still ripe)

Return ONLY valid JSON matching this structure:
{
  "chapter": ${chapterNumber},
  "chapter_title": "string",
  "characters": {
    "CharacterName": {
      "emotional_state": "string - how they feel right now",
      "chapter_experience": "string - what happened to them from their POV",
      "new_knowledge": ["string", "string"],
      "private_thoughts": "string - what they're thinking but not saying",
      "relationship_shifts": {
        "OtherCharacterName": {
          "direction": "strengthening|deteriorating|complicated|stable",
          "detail": "string - specific to this chapter",
          "unresolved": "string - tensions not yet addressed (optional)"
        }
      }
    }
  },
  "group_dynamics": {
    "overall_tension": "string - rising/falling/stable",
    "power_balance": "string - who has information/influence",
    "unspoken_things": ["string", "string"]
  },
  "callback_bank": [
    {
      "source_chapter": number,
      "moment": "string - specific moment worth revisiting",
      "status": "ripe|used|expired",
      "context": "string - when/how this could land effectively"
    }
  ]
}

IMPORTANT: Focus on SUBJECTIVE experience, not plot summary. We need to know how characters FEEL, not just what happened.`;

    // Call Claude Haiku for extraction
    const response = await anthropic.messages.create({
      model: HAIKU_PRICING.MODEL,
      max_tokens: 64000,
      messages: [{ role: 'user', content: extractionPrompt }]
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    // Log API cost
    await logHaikuCost(userId, storyId, 'ledger_extraction', inputTokens, outputTokens, {
      chapterNumber,
      characters_extracted: bible.characters.supporting?.length + 2 || 2
    });

    const responseText = response.content[0].text;
    const cleanedResponse = stripMarkdownCodeBlocks(responseText);
    const ledgerData = JSON.parse(cleanedResponse);

    // Smart merge: deduplicate by (source_chapter + moment), keeping newest status
    const newCallbacks = ledgerData.callback_bank || [];
    const callbackMap = new Map();

    // Add accumulated callbacks first
    for (const cb of accumulatedCallbacks) {
      const key = `${cb.source_chapter}::${cb.moment}`;
      callbackMap.set(key, cb);
    }

    // Overwrite with new callbacks (newer status wins)
    for (const cb of newCallbacks) {
      const key = `${cb.source_chapter}::${cb.moment}`;
      callbackMap.set(key, cb);
    }

    // Prune: remove callbacks marked "used" or "expired" that are 3+ chapters old
    const mergedCallbacks = Array.from(callbackMap.values()).filter(cb => {
      if (cb.status === 'used' || cb.status === 'expired') {
        return (chapterNumber - cb.source_chapter) < 3; // Keep recent used/expired for context
      }
      return true; // Keep all "ripe" callbacks
    });

    // Calculate approximate token count
    const tokenCount = Math.ceil(JSON.stringify(ledgerData).length / 4);

    // Insert ledger entry into database
    const { data: savedEntry, error: insertError } = await supabaseAdmin
      .from('character_ledger_entries')
      .insert({
        story_id: storyId,
        chapter_number: chapterNumber,
        ledger_data: ledgerData,
        callback_bank: mergedCallbacks,
        token_count: tokenCount
      })
      .select()
      .single();

    if (insertError) {
      throw new Error(`Failed to save ledger entry: ${insertError.message}`);
    }

    return savedEntry;
  } catch (error) {
    // Don't throw - ledger extraction is an enhancement, not a blocker
    console.error(`⚠️ Character ledger extraction failed for chapter ${chapterNumber}: ${error.message}`);
    return null;
  }
}

/**
 * Build character continuity XML block for injection into chapter generation prompt
 * Fetches all previous ledger entries and formats them with compression strategy
 *
 * @param {string} storyId - UUID of the story
 * @param {number} targetChapterNumber - Chapter being generated
 * @returns {Promise<string>} XML block string (or empty string if no ledger exists)
 */
async function buildCharacterContinuityBlock(storyId, targetChapterNumber) {
  try {
    // Fetch all ledger entries for this story, ordered by chapter_number DESC
    const { data: ledgerEntries, error: fetchError } = await supabaseAdmin
      .from('character_ledger_entries')
      .select('*')
      .eq('story_id', storyId)
      .order('chapter_number', { ascending: false });

    if (fetchError) {
      console.error(`⚠️ Failed to fetch ledger entries: ${fetchError.message}`);
      return '';
    }

    if (!ledgerEntries || ledgerEntries.length === 0) {
      // No ledger entries yet (generating chapter 1)
      return '';
    }

    // Apply compression strategy
    const compressedEntries = [];

    for (const entry of ledgerEntries) {
      const chapterDistance = targetChapterNumber - entry.chapter_number;

      if (chapterDistance <= 3) {
        // Recent chapters: use full ledger_data
        compressedEntries.push({
          chapter: entry.chapter_number,
          type: 'full',
          data: entry.ledger_data
        });
      } else {
        // Older chapters: use compressed_summary if available, otherwise compress on the fly
        if (entry.compressed_summary) {
          compressedEntries.push({
            chapter: entry.chapter_number,
            type: 'compressed',
            summary: entry.compressed_summary
          });
        } else {
          // Compress on the fly and save back
          const compressed = await compressLedgerEntry(entry.ledger_data);

          // Update the entry with compressed_summary
          await supabaseAdmin
            .from('character_ledger_entries')
            .update({ compressed_summary: compressed })
            .eq('id', entry.id);

          compressedEntries.push({
            chapter: entry.chapter_number,
            type: 'compressed',
            summary: compressed
          });
        }
      }
    }

    // Get most recent callback_bank (from first entry, since ordered DESC)
    const mostRecentEntry = ledgerEntries[0];
    const callbackBank = mostRecentEntry.callback_bank || [];

    // Build XML block
    let xmlBlock = `

<character_continuity>
  <instruction>
    The following is a chapter-by-chapter record of how each character has EXPERIENCED
    the story from their own perspective. Use this to ensure:
    1. Characters reference shared history naturally (inside jokes, past events, callbacks)
    2. Emotional arcs are continuous (don't reset a character's emotional state between chapters)
    3. Unresolved tensions build rather than disappear
    4. Private knowledge stays private until dramatically revealed
    5. Relationship dynamics reflect accumulated experience, not just initial descriptions

    The callback_bank contains specific moments worth revisiting. Use them when they
    would land naturally — don't force them, but don't waste them either.
  </instruction>
`;

    // Add each compressed entry (most recent first)
    for (const entry of compressedEntries) {
      if (entry.type === 'full') {
        xmlBlock += `
  <chapter_${entry.chapter}_ledger>
${JSON.stringify(entry.data, null, 4)}
  </chapter_${entry.chapter}_ledger>
`;
      } else {
        xmlBlock += `
  <chapter_${entry.chapter}_summary>
${entry.summary}
  </chapter_${entry.chapter}_summary>
`;
      }
    }

    // Add callback bank
    if (callbackBank.length > 0) {
      xmlBlock += `
  <callback_bank>
${JSON.stringify(callbackBank, null, 4)}
  </callback_bank>
`;
    }

    xmlBlock += `
</character_continuity>`;

    // Token budget guard: if block exceeds budget, compress more aggressively
    const MAX_CONTINUITY_TOKENS = 5000;
    const estimatedTokens = Math.ceil(xmlBlock.length / 4);

    if (estimatedTokens > MAX_CONTINUITY_TOKENS) {
      console.log(`⚠️ Character continuity block exceeds budget (${estimatedTokens} est. tokens > ${MAX_CONTINUITY_TOKENS}). Compressing oldest full entries.`);

      // Find the oldest full entries and compress them
      // Rebuild with tighter compression: only keep last 2 chapters as full instead of 3
      // This is a graceful degradation — we lose some detail on older chapters but stay within budget
      const tighterEntries = [];
      for (const entry of compressedEntries) {
        const chapterDistance = targetChapterNumber - entry.chapter;
        if (chapterDistance <= 2 && entry.type === 'full') {
          tighterEntries.push(entry);
        } else if (entry.type === 'compressed') {
          tighterEntries.push(entry);
        } else {
          // Was full but now needs compression
          const compressed = await compressLedgerEntry(entry.data);
          tighterEntries.push({ chapter: entry.chapter, type: 'compressed', summary: compressed });
        }
      }

      // Rebuild the XML block with tighter entries
      xmlBlock = `

<character_continuity>
  <instruction>
    The following is a chapter-by-chapter record of how each character has EXPERIENCED
    the story from their own perspective. Use this to ensure:
    1. Characters reference shared history naturally (inside jokes, past events, callbacks)
    2. Emotional arcs are continuous (don't reset a character's emotional state between chapters)
    3. Unresolved tensions build rather than disappear
    4. Private knowledge stays private until dramatically revealed
    5. Relationship dynamics reflect accumulated experience, not just initial descriptions

    The callback_bank contains specific moments worth revisiting. Use them when they
    would land naturally — don't force them, but don't waste them either.
  </instruction>
`;

      for (const entry of tighterEntries) {
        if (entry.type === 'full') {
          xmlBlock += `
  <chapter_${entry.chapter}_ledger>
${JSON.stringify(entry.data, null, 4)}
  </chapter_${entry.chapter}_ledger>
`;
        } else {
          xmlBlock += `
  <chapter_${entry.chapter}_summary>
${entry.summary}
  </chapter_${entry.chapter}_summary>
`;
        }
      }

      if (callbackBank.length > 0) {
        xmlBlock += `
  <callback_bank>
${JSON.stringify(callbackBank, null, 4)}
  </callback_bank>
`;
      }

      xmlBlock += `
</character_continuity>`;
    }

    return xmlBlock;
  } catch (error) {
    console.error(`⚠️ Failed to build character continuity block: ${error.message}`);
    return '';
  }
}

/**
 * Compress a full ledger entry into a text summary (~100-150 words)
 * Preserves key relationship states, active callbacks, and major unresolved tensions
 *
 * @param {Object} ledgerData - Full ledger JSON
 * @param {string} [userId] - Optional UUID of the user (for cost logging)
 * @param {string} [storyId] - Optional UUID of the story (for cost logging)
 * @returns {Promise<string>} Compressed text summary
 */
async function compressLedgerEntry(ledgerData, userId = null, storyId = null) {
  try {
    const compressionPrompt = `Compress this character relationship ledger into a concise summary (100-150 words).

<ledger_to_compress>
${JSON.stringify(ledgerData, null, 2)}
</ledger_to_compress>

PRESERVE:
- Key relationship states (who trusts whom, who suspects whom, who's growing closer/distant)
- Active callbacks that are still "ripe" for use
- Major unresolved tensions

DROP:
- Detailed dialogue suggestions
- Expired callbacks
- Redundant emotional state descriptions

Return ONLY the compressed text summary, no JSON formatting.`;

    const response = await anthropic.messages.create({
      model: HAIKU_PRICING.MODEL,
      max_tokens: 64000,
      messages: [{ role: 'user', content: compressionPrompt }]
    });

    // Log API cost if userId and storyId are provided
    if (userId && storyId) {
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      await logHaikuCost(userId, storyId, 'ledger_compression', inputTokens, outputTokens, {
        chapter: ledgerData.chapter
      });
    }

    return response.content[0].text.trim();
  } catch (error) {
    console.error(`⚠️ Ledger compression failed: ${error.message}`);
    // Fallback: return a simple summary of the chapter number
    return `Chapter ${ledgerData.chapter}: ${ledgerData.chapter_title || 'No title'} - relationship data compressed`;
  }
}

/**
 * Review character voices against accumulated ledger history
 * Uses Claude Sonnet to check dialogue authenticity, character consistency, and missed callbacks
 *
 * @param {string} storyId - UUID of the story
 * @param {number} chapterNumber - Chapter number being reviewed
 * @param {string} chapterContent - The full text of the chapter
 * @param {string} userId - UUID of the user (for cost logging)
 * @returns {Promise<Object>} The voice review data
 */
async function reviewCharacterVoices(storyId, chapterNumber, chapterContent, userId) {
  try {
    // Fetch ALL character ledger entries for this story (ordered DESC for recency)
    const { data: ledgerEntries, error: ledgerError } = await supabaseAdmin
      .from('character_ledger_entries')
      .select('*')
      .eq('story_id', storyId)
      .order('chapter_number', { ascending: false });

    if (ledgerError) {
      throw new Error(`Failed to fetch ledger entries: ${ledgerError.message}`);
    }

    // If no ledger entries yet (shouldn't happen, but be safe), skip review
    if (!ledgerEntries || ledgerEntries.length === 0) {
      console.log('⚠️ No ledger entries found — skipping voice review');
      return null;
    }

    // Fetch story bible for character reference
    const { data: bible, error: bibleError } = await supabaseAdmin
      .from('story_bibles')
      .select('*')
      .eq('story_id', storyId)
      .single();

    if (bibleError || !bible) {
      throw new Error(`Story bible not found: ${bibleError?.message || 'No bible returned'}`);
    }

    // Build full ledger history as XML (reuse the same format as continuity block)
    let ledgerHistoryBlock = '<character_continuity>\n';

    for (const entry of ledgerEntries) {
      ledgerHistoryBlock += `  <chapter_${entry.chapter_number}_ledger>\n`;
      ledgerHistoryBlock += JSON.stringify(entry.ledger_data, null, 4);
      ledgerHistoryBlock += `\n  </chapter_${entry.chapter_number}_ledger>\n`;
    }

    // Add callback bank from most recent entry
    const mostRecentEntry = ledgerEntries[0];
    if (mostRecentEntry.callback_bank && Array.isArray(mostRecentEntry.callback_bank)) {
      ledgerHistoryBlock += '  <callback_bank>\n';
      ledgerHistoryBlock += JSON.stringify(mostRecentEntry.callback_bank, null, 4);
      ledgerHistoryBlock += '\n  </callback_bank>\n';
    }

    ledgerHistoryBlock += '</character_continuity>';

    // Build voice review prompt
    const reviewPrompt = `You are a character authenticity reviewer for a novel-in-progress.

${ledgerHistoryBlock}

<new_chapter>
${chapterContent}
</new_chapter>

<story_context>
<protagonist>
  <name>${bible.characters.protagonist.name}</name>
  <personality>${bible.characters.protagonist.personality}</personality>
</protagonist>

<antagonist>
  <name>${bible.characters.antagonist.name}</name>
  <motivation>${bible.characters.antagonist.motivation}</motivation>
</antagonist>

<supporting_characters>
${bible.characters.supporting?.map(sc => `  <character name="${sc.name}" role="${sc.role}">${sc.personality}</character>`).join('\n') || '  None'}
</supporting_characters>
</story_context>

Review this chapter for character authenticity. For each major character:

1. Does their dialogue match their current emotional state (per the ledger)?
2. Are there moments where a character acts inconsistently with their established arc?
3. Are there natural opportunities to callback earlier moments that were missed?
4. Do relationship dynamics feel appropriate given accumulated history?

Rate each character's authenticity 0.0-1.0. Flag specific dialogue lines or moments that feel off, with concrete suggestions for fixes. Identify callback opportunities that would add depth.

Be surgical — only flag things that would genuinely improve the chapter. A score of 0.85+ means "good, minor notes." Below 0.8 means "this needs revision."

Return ONLY valid JSON matching this structure:
{
  "chapter_reviewed": ${chapterNumber},
  "voice_checks": [
    {
      "character": "CharacterName",
      "authenticity_score": 0.85,
      "flags": [
        {
          "type": "tone_inconsistency|behavior_inconsistency|dialogue_issue",
          "location": "paragraph X, dialogue line 'quote'",
          "issue": "specific problem description",
          "suggestion": "specific fix suggestion"
        }
      ],
      "missed_callbacks": [
        {
          "callback": "specific moment from earlier chapter",
          "opportunity": "where and how this could be naturally referenced"
        }
      ]
    }
  ],
  "relationship_dynamics": {
    "character1_character2_dynamic": "assessment",
    "group_cohesion": "assessment"
  },
  "overall_assessment": "brief summary"
}`;

    // Call Claude Sonnet for voice review
    const response = await anthropic.messages.create({
      model: SONNET_PRICING.MODEL,
      max_tokens: 64000,
      messages: [{ role: 'user', content: reviewPrompt }]
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const responseText = response.content[0].text;

    // Log API cost
    await logApiCost(userId, storyId, 'voice_review', inputTokens, outputTokens, {
      chapterNumber,
      characters_reviewed: bible.characters.supporting?.length + 2 || 2
    });

    // Parse the response
    const cleanedResponse = stripMarkdownCodeBlocks(responseText);
    const reviewData = JSON.parse(cleanedResponse);

    // Count total flags across all characters
    const flagsCount = reviewData.voice_checks?.reduce((sum, check) => {
      return sum + (check.flags?.length || 0) + (check.missed_callbacks?.length || 0);
    }, 0) || 0;

    // Save to database
    const { data: savedReview, error: insertError } = await supabaseAdmin
      .from('character_voice_reviews')
      .insert({
        story_id: storyId,
        chapter_number: chapterNumber,
        review_data: reviewData,
        flags_count: flagsCount,
        revision_applied: false
      })
      .select()
      .single();

    if (insertError) {
      throw new Error(`Failed to save voice review: ${insertError.message}`);
    }

    return reviewData;
  } catch (error) {
    console.error(`⚠️ Voice review failed: ${error.message}`);
    throw error; // Re-throw so the caller can handle it
  }
}

/**
 * Apply surgical revisions to chapter based on voice review flags
 * Only fires if any character has authenticity_score < 0.8 or missed callbacks with natural opportunities
 *
 * @param {string} storyId - UUID of the story
 * @param {number} chapterNumber - Chapter number being revised
 * @param {string} chapterContent - The current chapter content
 * @param {Object} reviewData - The voice review data
 * @param {string} userId - UUID of the user (for cost logging)
 * @returns {Promise<string|null>} Revised chapter content, or null if no revision needed
 */
async function applyVoiceRevisions(storyId, chapterNumber, chapterContent, reviewData, userId) {
  try {
    // Extract actionable flags: any character with score < 0.8 OR missed callbacks
    const actionableIssues = [];

    for (const check of reviewData.voice_checks || []) {
      const needsRevision = check.authenticity_score < 0.8;
      const hasMissedCallbacks = check.missed_callbacks && check.missed_callbacks.length > 0;

      if (needsRevision || hasMissedCallbacks) {
        actionableIssues.push({
          character: check.character,
          score: check.authenticity_score,
          flags: check.flags || [],
          missed_callbacks: check.missed_callbacks || []
        });
      }
    }

    // If no actionable issues, return null (no revision needed)
    if (actionableIssues.length === 0) {
      return null;
    }

    // Build surgical revision prompt
    const issuesDescription = actionableIssues.map(issue => {
      let desc = `\n<character name="${issue.character}" authenticity_score="${issue.score}">`;

      if (issue.flags.length > 0) {
        desc += '\n  <flags>';
        for (const flag of issue.flags) {
          desc += `\n    <flag type="${flag.type}">`;
          desc += `\n      <location>${flag.location}</location>`;
          desc += `\n      <issue>${flag.issue}</issue>`;
          desc += `\n      <suggestion>${flag.suggestion}</suggestion>`;
          desc += '\n    </flag>';
        }
        desc += '\n  </flags>';
      }

      if (issue.missed_callbacks.length > 0) {
        desc += '\n  <missed_callbacks>';
        for (const callback of issue.missed_callbacks) {
          desc += '\n    <callback>';
          desc += `\n      <moment>${callback.callback}</moment>`;
          desc += `\n      <opportunity>${callback.opportunity}</opportunity>`;
          desc += '\n    </callback>';
        }
        desc += '\n  </missed_callbacks>';
      }

      desc += '\n</character>';
      return desc;
    }).join('\n');

    const revisionPrompt = `You are revising a chapter based on character voice review feedback.

<current_chapter>
${chapterContent}
</current_chapter>

<issues_to_address>
${issuesDescription}
</issues_to_address>

INSTRUCTIONS:
- Revise ONLY the flagged items listed above
- Do NOT rewrite the chapter from scratch
- Make surgical changes: fix specific dialogue lines, add specific callback moments, adjust character behavior where flagged
- Preserve all plot events, pacing, and non-flagged content exactly as-is
- Return the COMPLETE revised chapter text (with your targeted fixes incorporated)

Return ONLY the revised chapter text. No JSON, no commentary, just the full chapter content with your surgical fixes applied.`;

    // Call Claude Sonnet for surgical revision
    const response = await anthropic.messages.create({
      model: SONNET_PRICING.MODEL,
      max_tokens: 64000,
      messages: [{ role: 'user', content: revisionPrompt }]
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const revisedContent = response.content[0].text.trim();

    // Log API cost
    await logApiCost(userId, storyId, 'voice_revision', inputTokens, outputTokens, {
      chapterNumber,
      characters_revised: actionableIssues.length,
      flags_count: actionableIssues.reduce((sum, i) => sum + i.flags.length + i.missed_callbacks.length, 0)
    });

    // First fetch current metadata
    const { data: currentChapter } = await supabaseAdmin
      .from('chapters')
      .select('metadata')
      .eq('story_id', storyId)
      .eq('chapter_number', chapterNumber)
      .single();

    const updatedMetadata = {
      ...(currentChapter?.metadata || {}),
      voice_revision: true
    };

    // Update chapter with revised content and merged metadata
    const { error: updateError } = await supabaseAdmin
      .from('chapters')
      .update({
        content: revisedContent,
        metadata: updatedMetadata
      })
      .eq('story_id', storyId)
      .eq('chapter_number', chapterNumber);

    if (updateError) {
      throw new Error(`Failed to update chapter with revised content: ${updateError.message}`);
    }

    // Update voice review record to mark revision as applied
    const { error: reviewUpdateError } = await supabaseAdmin
      .from('character_voice_reviews')
      .update({ revision_applied: true })
      .eq('story_id', storyId)
      .eq('chapter_number', chapterNumber);

    if (reviewUpdateError) {
      console.error(`⚠️ Failed to update voice review record: ${reviewUpdateError.message}`);
      // Non-critical, continue
    }

    return revisedContent;
  } catch (error) {
    console.error(`⚠️ Voice revision failed: ${error.message}`);
    throw error; // Re-throw so the caller can handle it
  }
}

module.exports = {
  extractCharacterLedger,
  buildCharacterContinuityBlock,
  compressLedgerEntry,
  reviewCharacterVoices,
  applyVoiceRevisions
};
