const { anthropic } = require('../config/ai-clients');
const { supabaseAdmin } = require('../config/supabase');
const { reportToPeggy } = require('../middleware/peggy-error-reporter');
const { storyLog, getStoryLogs, clearStoryLogs } = require('./story-logger');
const crypto = require('crypto');

/**
 * Map categorical age range to literal age range for prompts
 * @param {string} ageCategory - 'child', 'teen', 'young-adult', or 'adult'
 * @returns {string} Literal age range like '8-12', '13-17', etc.
 */
function mapAgeRange(ageCategory) {
  const ageMap = {
    'child': '8-12',
    'teen': '13-17',
    'young-adult': '18-25',
    'adult': '25+'
  };

  // If input is null/undefined, default to adult
  if (!ageCategory) {
    return ageMap['adult'];
  }

  // If it's already a literal range (e.g., "8-12" or "25+"), return as-is
  // Check for pattern: digits-digits or digits+
  if (/^\d+-\d+$/.test(ageCategory) || /^\d+\+$/.test(ageCategory)) {
    return ageCategory;
  }

  // Map category to range, default to adult
  return ageMap[ageCategory] || ageMap['adult'];
}

/**
 * Scan chapter content for prose craft violations
 * @param {string} chapterContent - The generated chapter text
 * @returns {object} { passed: boolean, violations: string[] }
 */
function scanForProseViolations(chapterContent) {
  const violations = [];

  // 1. Count em dashes (—)
  const emDashCount = (chapterContent.match(/—/g) || []).length;
  if (emDashCount > 15) {
    violations.push(`Em dashes: ${emDashCount} (limit: 15)`);
  }

  // 2. Count "Not X, but Y" and "Not X — Y" patterns
  const notButPattern = /Not [a-zA-Z]+(?:,| —) (?:but|just) /gi;
  const notButMatches = (chapterContent.match(notButPattern) || []).length;
  if (notButMatches > 2) {
    violations.push(`"Not X, but Y" constructions: ${notButMatches} (limit: 2)`);
  }

  // 3. Count "something in" (case insensitive)
  const somethingInPattern = /something in (?:his|her|their|my|your) /gi;
  const somethingInMatches = (chapterContent.match(somethingInPattern) || []).length;
  if (somethingInMatches > 2) {
    violations.push(`"Something in [X]" constructions: ${somethingInMatches} (limit: 2)`);
  }

  // 4. Count "the kind of" (case insensitive)
  const kindOfPattern = /the kind of/gi;
  const kindOfMatches = (chapterContent.match(kindOfPattern) || []).length;
  if (kindOfMatches > 2) {
    violations.push(`"The kind of" constructions: ${kindOfMatches} (limit: 2)`);
  }

  return {
    passed: violations.length === 0,
    violations
  };
}

// Model and pricing configuration
// Model is read from environment so it can be changed without redeployment
const GENERATION_MODEL = process.env.CLAUDE_GENERATION_MODEL || 'claude-opus-4-6';

// Claude Opus 4.6 pricing (per million tokens) — as of Feb 2026
// IMPORTANT: Update these if you change the model
const PRICING = {
  INPUT_PER_MILLION: 5,    // was 15 (WRONG — that was Opus 4.5 pricing)
  OUTPUT_PER_MILLION: 25,  // was 75 (WRONG — that was Opus 4.5 pricing)
  MODEL: GENERATION_MODEL
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
/**
 * Attempt to repair common JSON issues (truncation, unclosed strings, etc.)
 */
function attemptJsonRepair(jsonString) {
  let repaired = jsonString;

  // 1. Remove any trailing content after the last complete top-level closing brace
  // Find the last } that could be the root object close
  let braceDepth = 0;
  let lastValidClose = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < repaired.length; i++) {
    if (escapeNext) { escapeNext = false; continue; }
    if (repaired[i] === '\\') { escapeNext = true; continue; }
    if (repaired[i] === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (repaired[i] === '{') braceDepth++;
    if (repaired[i] === '}') {
      braceDepth--;
      if (braceDepth === 0) { lastValidClose = i; break; }
    }
  }

  if (lastValidClose > 0 && lastValidClose < repaired.length - 1) {
    console.log(`🔧 JSON repair: Truncating ${repaired.length - lastValidClose - 1} chars after root close`);
    repaired = repaired.substring(0, lastValidClose + 1);
  }

  // 2. If braces never balanced, try to close open structures
  if (lastValidClose === -1) {
    // Count unclosed braces and brackets
    braceDepth = 0;
    let bracketDepth = 0;
    inString = false;
    escapeNext = false;

    for (let i = 0; i < repaired.length; i++) {
      if (escapeNext) { escapeNext = false; continue; }
      if (repaired[i] === '\\') { escapeNext = true; continue; }
      if (repaired[i] === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (repaired[i] === '{') braceDepth++;
      if (repaired[i] === '}') braceDepth--;
      if (repaired[i] === '[') bracketDepth++;
      if (repaired[i] === ']') bracketDepth--;
    }

    // If we're inside a string, close it
    if (inString) {
      console.log('🔧 JSON repair: Closing unclosed string');
      repaired += '"';
    }

    // Close any open brackets and braces
    for (let i = 0; i < bracketDepth; i++) repaired += ']';
    for (let i = 0; i < braceDepth; i++) repaired += '}';

    if (braceDepth > 0 || bracketDepth > 0) {
      console.log(`🔧 JSON repair: Closed ${bracketDepth} brackets and ${braceDepth} braces`);
    }
  }

  // 3. Fix trailing commas before } or ]
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  return repaired;
}

function parseAndValidateJSON(jsonString, requiredFields = []) {
  let parsed;
  let extractedContent = null;
  let originalError = null;

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
    originalError = e;
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
      extractedContent = codeBlockMatch[1].trim();
      console.log(`   Attempting to parse extracted content (${extractedContent.length} chars)...`);

      try {
        parsed = JSON.parse(extractedContent);
        console.log('   ✅ Markdown extraction and parse succeeded');
      } catch (e2) {
        console.log(`   ❌ Failed to parse extracted JSON: ${e2.message}`);
        // Don't throw yet - will try repair next
      }
    }

    // Step 5: If both attempts failed, try JSON repair
    if (!parsed) {
      const contentToRepair = extractedContent || trimmed;
      console.log('🔧 Attempting JSON repair...');
      const repaired = attemptJsonRepair(contentToRepair);

      try {
        parsed = JSON.parse(repaired);
        console.log('✅ JSON repair succeeded!');
      } catch (repairError) {
        console.error('❌ JSON repair also failed:', repairError.message);
        // NOW throw the original error
        throw new Error(`Failed to parse JSON even after repair: ${originalError.message}`);
      }
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
async function callClaudeWithRetry(messages, maxTokens, metadata = {}) {
  const maxAttempts = 4;
  let lastError;
  const delays = [2000, 10000, 30000]; // More aggressive backoff: 2s, 10s, 30s
  const storyTitle = metadata.storyTitle || 'Unknown';

  for (let i = 0; i < maxAttempts; i++) {
    try {
      // Wait before retry (except first attempt)
      if (i > 0 && delays[i - 1]) {
        const waitSeconds = (delays[i - 1] / 1000).toFixed(0);
        if (error.status === 429 || error.type === 'rate_limit_error') {
          console.log(`⏳ [${storyTitle}] Rate limited, waiting ${waitSeconds}s before retry...`);
        }
        await new Promise(resolve => setTimeout(resolve, delays[i - 1]));
      }

      // Calculate prompt length
      const promptLength = JSON.stringify(messages).length;
      console.log(`🤖 [${storyTitle}] Claude API call → (${promptLength.toLocaleString()} chars)`);

      const apiStartTime = Date.now();
      const response = await anthropic.messages.create({
        model: PRICING.MODEL,
        max_tokens: maxTokens,
        messages
      });

      const apiDuration = ((Date.now() - apiStartTime) / 1000).toFixed(1);
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const cost = calculateCost(inputTokens, outputTokens);
      const responseLength = response.content[0].text.length;

      console.log(`🤖 [${storyTitle}] Claude API responded ← (${responseLength.toLocaleString()} chars, ${apiDuration}s)`);

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
        error.status === 429 ||
        error.type === 'overloaded_error' ||
        error.type === 'rate_limit_error' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNRESET';

      if (!shouldRetry || i === maxAttempts - 1) {
        throw error;
      }

      console.log(`⚠️ [${storyTitle}] Claude API retry ${i + 1}/${maxAttempts} — reason: ${error.message}`);
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
 * Clear recovery lock after generation completes or fails
 */
async function clearRecoveryLock(storyId) {
  const { data: story } = await supabaseAdmin
    .from('stories')
    .select('generation_progress')
    .eq('id', storyId)
    .single();

  if (story?.generation_progress) {
    const progress = { ...story.generation_progress };
    delete progress.recovery_started;  // Remove the lock

    await supabaseAdmin
      .from('stories')
      .update({ generation_progress: progress })
      .eq('id', storyId);
  }
}

/**
 * Retry a generation step with backoff and progress tracking
 */
async function retryGenerationStep(stepName, storyId, storyTitle, stepFn, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await stepFn();
    } catch (error) {
      const isLastAttempt = attempt > maxRetries;
      storyLog(storyId, storyTitle, `🔄 [${storyTitle}] Retrying step "${stepName}" — attempt ${attempt}/${maxRetries + 1}: ${error.message}`);

      // Update progress with retry info
      const { data: story } = await supabaseAdmin
        .from('stories')
        .select('generation_progress')
        .eq('id', storyId)
        .single();

      const progress = story?.generation_progress || {};
      const previousError = progress.last_error;

      progress.last_error = error.message;
      progress.last_error_at = new Date().toISOString();
      progress.retry_count = (progress.retry_count || 0) + 1;
      progress.last_retry = new Date().toISOString();
      progress.last_updated = new Date().toISOString();

      // CIRCUIT BREAKER: Same-error detection
      // If error is identical to previous error, it's a code bug not a transient failure
      if (attempt > 1 && previousError === error.message) {
        storyLog(storyId, storyTitle, `🛑 [${storyTitle}] Same error repeated — this is a code bug, not a transient failure. Stopping.`);
        progress.current_step = 'permanently_failed';
        progress.permanently_failed_at = new Date().toISOString();
        progress.repeated_error = true;
        progress.error_logs = getStoryLogs(storyId);

        await supabaseAdmin
          .from('stories')
          .update({
            generation_progress: progress,
            status: 'error',
            error_message: `${stepName} failed with repeated error (code bug, not transient): ${error.message}`
          })
          .eq('id', storyId);

        // Peggy: Report code bugs immediately
        reportToPeggy({
          source: `generation:${stepName}`,
          category: 'generation',
          severity: 'critical',
          errorMessage: `Repeated error (code bug): ${error.message}`,
          stackTrace: error.stack,
          storyId,
          storyTitle,
          context: { step: stepName, attempt, retry_count: progress.retry_count }
        }).catch(() => {}); // fire and forget

        throw error; // Stop immediately, don't continue retrying
      }

      if (isLastAttempt) {
        progress.current_step = 'generation_failed';
        progress.error = error.message;
        progress.error_logs = getStoryLogs(storyId);

        await supabaseAdmin
          .from('stories')
          .update({
            generation_progress: progress,
            status: 'error',
            error_message: `${stepName} failed after ${maxRetries + 1} attempts: ${error.message}`
          })
          .eq('id', storyId);

        storyLog(storyId, storyTitle, `❌ [${storyTitle}] Step "${stepName}" failed after ${maxRetries + 1} attempts`);

        // Peggy: Report exhausted retries
        reportToPeggy({
          source: `generation:${stepName}`,
          category: 'generation',
          severity: 'high',
          errorMessage: `${stepName} failed after ${maxRetries + 1} attempts: ${error.message}`,
          stackTrace: error.stack,
          storyId,
          storyTitle,
          context: { step: stepName, max_retries: maxRetries + 1 }
        }).catch(() => {});

        throw error;
      }

      // Update progress and wait before retry
      await supabaseAdmin
        .from('stories')
        .update({ generation_progress: progress })
        .eq('id', storyId);

      const backoffMs = attempt * 15000; // 15s, 30s
      storyLog(storyId, storyTitle, `⏳ [${storyTitle}] Waiting ${backoffMs/1000}s before retry...`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
}

/**
 * Generate 3 story premises from user preferences
 * @param {string} userId - User ID
 * @param {object} preferences - User preferences
 * @param {array} excludePremises - Optional array of premises to avoid repeating
 */
async function generatePremises(userId, preferences, excludePremises = []) {
  // Extract preferences with correct field names from normalization
  const {
    genres = [],
    themes = [],
    mood = 'varied',
    dislikedElements = [],
    characterTypes = 'varied',
    name = 'Reader',
    ageRange: rawAgeRange = 'adult'
  } = preferences;

  // Map categorical age to literal range for prompts
  const ageRange = mapAgeRange(rawAgeRange);

  // Fetch discovery tolerance, reading level, and emotional drivers from user_preferences
  const { data: userPrefs } = await supabaseAdmin
    .from('user_preferences')
    .select('discovery_tolerance, reading_level, preferences')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const discoveryTolerance = userPrefs?.discovery_tolerance ?? 0.5;
  const readingLevel = userPrefs?.reading_level || userPrefs?.preferences?.readingLevel || 'adult';
  const emotionalDrivers = userPrefs?.preferences?.emotionalDrivers || userPrefs?.preferences?.emotional_drivers || [];
  const belovedStories = userPrefs?.preferences?.belovedStories || userPrefs?.preferences?.beloved_stories || [];

  // Fetch learned writing preferences (populated after 2+ completed books)
  const writingPrefs = await getUserWritingPreferences(userId);
  let learnedPreferencesBlock = '';
  if (writingPrefs && writingPrefs.stories_analyzed >= 2 && writingPrefs.confidence_score >= 0.5) {
    console.log(`📚 Injecting learned preferences into premise generation (confidence: ${writingPrefs.confidence_score}, ${writingPrefs.stories_analyzed} books analyzed)`);
    const customInstructions = writingPrefs.custom_instructions?.length
      ? writingPrefs.custom_instructions.map(i => `  - ${i}`).join('\n')
      : '  None yet';
    const avoidPatterns = writingPrefs.avoid_patterns?.length
      ? writingPrefs.avoid_patterns.map(p => `  - ${p}`).join('\n')
      : '  None yet';
    learnedPreferencesBlock = `
LEARNED READER PATTERNS (from ${writingPrefs.stories_analyzed} completed books):
What this reader consistently responds well to:
${customInstructions}

What this reader consistently dislikes in practice (not just stated preferences — observed from feedback):
${avoidPatterns}

Pacing tendency: ${writingPrefs.preferred_pacing?.summary || 'No data yet'}
Dialogue preference: ${writingPrefs.preferred_dialogue_style?.summary || 'No data yet'}

Use these patterns to inform premise selection — premises should lean toward what they've PROVEN to enjoy, not just what they say they like.
`;
  }

  // Fetch cross-book feedback summary (patterns across ALL previous stories)
  let crossBookFeedbackBlock = '';
  const { data: allFeedback } = await supabaseAdmin
    .from('story_feedback')
    .select('checkpoint, pacing_feedback, tone_feedback, character_feedback, checkpoint_corrections')
    .eq('user_id', userId)
    .not('response', 'eq', 'skipped')
    .order('created_at', { ascending: true });

  if (allFeedback && allFeedback.length >= 3) {
    // Summarize patterns across all feedback
    const pacingCounts = {};
    const toneCounts = {};
    const characterCounts = {};
    const voiceNotes = [];

    allFeedback.forEach(fb => {
      if (fb.pacing_feedback) pacingCounts[fb.pacing_feedback] = (pacingCounts[fb.pacing_feedback] || 0) + 1;
      if (fb.tone_feedback) toneCounts[fb.tone_feedback] = (toneCounts[fb.tone_feedback] || 0) + 1;
      if (fb.character_feedback) characterCounts[fb.character_feedback] = (characterCounts[fb.character_feedback] || 0) + 1;
      if (fb.checkpoint_corrections) {
        if (fb.checkpoint_corrections.pacing_note) voiceNotes.push(`Pacing: ${fb.checkpoint_corrections.pacing_note}`);
        if (fb.checkpoint_corrections.tone_note) voiceNotes.push(`Tone: ${fb.checkpoint_corrections.tone_note}`);
        if (fb.checkpoint_corrections.style_note) voiceNotes.push(`Style: ${fb.checkpoint_corrections.style_note}`);
      }
    });

    const formatCounts = (counts) => Object.entries(counts).map(([k, v]) => `${k} (${v}x)`).join(', ');
    const hasDimensionData = Object.keys(pacingCounts).length > 0 || Object.keys(toneCounts).length > 0;
    const hasVoiceData = voiceNotes.length > 0;

    if (hasDimensionData || hasVoiceData) {
      console.log(`📊 Including cross-book feedback in premises (${allFeedback.length} feedback points)`);
      crossBookFeedbackBlock = `
CROSS-BOOK FEEDBACK PATTERNS (${allFeedback.length} checkpoints across all stories):
${Object.keys(pacingCounts).length > 0 ? `Pacing feedback: ${formatCounts(pacingCounts)}` : ''}
${Object.keys(toneCounts).length > 0 ? `Tone feedback: ${formatCounts(toneCounts)}` : ''}
${Object.keys(characterCounts).length > 0 ? `Character feedback: ${formatCounts(characterCounts)}` : ''}
${hasVoiceData ? `\nVoice interview notes (most recent):\n${voiceNotes.slice(-6).map(n => `  - ${n}`).join('\n')}` : ''}

Weight premises toward what this reader's ACTUAL feedback reveals, not just their stated preferences. If they consistently say pacing is "slow", lean toward action-driven premises. If they consistently say tone is "serious", lean toward premises with more levity built in.
`;
    }
  }

  // Fetch reading history to avoid repetition
  const { data: readHistory } = await supabaseAdmin
    .from('stories')
    .select('title, genre, premise_tier')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

  const previousTitles = (readHistory || []).map(s => s.title).filter(Boolean);
  const previousGenres = (readHistory || []).map(s => s.genre).filter(Boolean);

  // Fetch ALL previously offered premise titles (selected or not) to prevent
  // Claude from regenerating identical titles across sessions
  const { data: allPremiseSets } = await supabaseAdmin
    .from('story_premises')
    .select('premises')
    .eq('user_id', userId)
    .order('generated_at', { ascending: false })
    .limit(10);

  const previouslyOfferedTitles = [];
  if (allPremiseSets) {
    for (const set of allPremiseSets) {
      if (Array.isArray(set.premises)) {
        for (const p of set.premises) {
          if (p.title && !previousTitles.includes(p.title)) {
            previouslyOfferedTitles.push(p.title);
          }
        }
      }
    }
  }
  if (previouslyOfferedTitles.length > 0) {
    console.log(`🔄 Found ${previouslyOfferedTitles.length} previously offered (unselected) premise titles to exclude`);
  }

  console.log('📊 Generating premises with three-tier framework:');
  console.log(`   Genres: ${genres.join(', ') || 'None specified'}`);
  console.log(`   Themes: ${themes.join(', ') || 'None specified'}`);
  console.log(`   Mood: ${mood}`);
  console.log(`   Character Types: ${characterTypes}`);
  console.log(`   Disliked: ${dislikedElements.join(', ') || 'None specified'}`);
  console.log(`   Age Range: ${rawAgeRange} → ${ageRange}`);
  console.log(`   Discovery Tolerance: ${discoveryTolerance.toFixed(2)}`);
  console.log(`   Emotional Drivers: ${emotionalDrivers.join(', ') || 'Not yet identified'}`);
  console.log(`   Previous Stories: ${previousTitles.length} titles`);

  // Check if this is a returning user with direction preferences OR has a specific story request
  const isReturningUser = preferences.isReturningUser === true;
  const storyDirection = preferences.storyDirection || 'comfort';
  const moodShift = preferences.moodShift;
  const explicitRequest = preferences.explicitRequest;
  const newInterests = preferences.newInterests || [];
  const previousStoryTitles = preferences.previousStoryTitles || previousTitles;
  const hasDirectedRequest = isReturningUser || (explicitRequest && storyDirection === 'specific');

  if (hasDirectedRequest) {
    console.log('🔄 DIRECTED REQUEST MODE:');
    console.log(`   Direction: ${storyDirection}`);
    console.log(`   Mood Shift: ${moodShift || 'none specified'}`);
    console.log(`   Explicit Request: ${explicitRequest || 'none'}`);
    console.log(`   New Interests: ${newInterests.join(', ') || 'none'}`);
    console.log(`   Previous Story Titles: ${previousStoryTitles.join(', ')}`);
    console.log(`   Source: ${isReturningUser ? 'returning_user' : 'premise_rejection/onboarding'}`);
  }

  // Build the three-tier premise prompt
  const genreList = genres.length > 0 ? genres.join(', ') : 'varied';
  const themeList = themes.length > 0 ? themes.join(', ') : 'varied';
  const avoidList = dislikedElements.length > 0 ? dislikedElements.join(', ') : 'none specified';
  const driverList = emotionalDrivers.length > 0 ? emotionalDrivers.join(', ') : 'not yet identified';
  const belovedList = belovedStories.length > 0
    ? belovedStories.map(s => typeof s === 'object' ? `${s.title} (${s.reason || s.why || ''})` : s).join('; ')
    : 'not yet shared';
  const historyList = previousTitles.length > 0 ? previousTitles.join(', ') : 'none yet — this is their first set of stories';

  const wildcardCalibration = discoveryTolerance >= 0.7
    ? 'HIGH tolerance — the wildcard should be a genuine genre departure. Take the emotional driver and transplant it into a genre/setting they have NEVER mentioned or experienced. Be bold.'
    : discoveryTolerance >= 0.4
    ? 'MEDIUM tolerance — the wildcard should stay in a related genre family but take an unexpected thematic or setting angle they would not have predicted.'
    : 'LOW tolerance — the wildcard should stay within their preferred genres but approach from a surprising angle or subgenre they haven\'t explored. Gentle surprise, not shock.';

  const directedRequestContext = hasDirectedRequest ? `
${isReturningUser ? `RETURNING READER CONTEXT:
This reader has already enjoyed stories with you! They've completed: ${previousStoryTitles.join(', ')}` :
`DIRECTED REQUEST CONTEXT:
The reader rejected previous premises and came back with a clearer vision of what they want.`}

THEIR REQUEST FOR THIS NEW STORY:
- Direction: ${storyDirection === 'comfort' ? 'MORE OF WHAT I LOVE — give me another story like my favorites' :
              storyDirection === 'stretch' ? 'STRETCH ME — push into adjacent genres/themes I haven\'t tried' :
              storyDirection === 'wildcard' ? 'SURPRISE ME — something unexpected but still tailored to me' :
              storyDirection === 'specific' ? 'SPECIFIC IDEA — they have something particular in mind' :
              storyDirection}
${moodShift ? `- Current Mood: ${moodShift}` : ''}
${explicitRequest ? `- Specific Request: "${explicitRequest}"` : ''}
${newInterests.length > 0 ? `- New Interests to Incorporate: ${newInterests.join(', ')}` : ''}

IMPORTANT: Honor their direction preference when generating premises. ${
  storyDirection === 'comfort' ? 'All three premises should be variations on what they loved before.' :
  storyDirection === 'stretch' ? 'Push into adjacent territory — related but unexplored.' :
  storyDirection === 'wildcard' ? 'Be bold with surprises, but keep their reading level and avoid-list sacred.' :
  storyDirection === 'specific' && explicitRequest ? `Their explicit request takes priority: "${explicitRequest}". ALL THREE premises must be variations on this concept — different angles, tones, or twists on the same core idea. Do NOT generate unrelated premises.` :
  'Use their preferences as guidance.'
}
` : '';

  const premisePrompt = `You are Prospero, the master storyteller of Mythweaver. You know this reader deeply and are crafting three story premises — each with a DIFFERENT purpose.

READER PROFILE:
- Name: ${name}
- Preferred Genres: ${genreList}
- Preferred Themes: ${themeList}
- Desired Mood/Tone: ${mood}
- Character Preferences: ${characterTypes}
- Elements to AVOID: ${avoidList}
- Reading Level: ${readingLevel}
- Age Range: ${ageRange} (for context)
- Emotional Drivers (WHY they read): ${driverList}
- Stories/Shows/Games They Love: ${belovedList}
${learnedPreferencesBlock}${crossBookFeedbackBlock}${directedRequestContext}
READING HISTORY (do NOT repeat these):
${historyList}
${previouslyOfferedTitles.length > 0 ? `
PREVIOUSLY OFFERED TITLES (reader saw these but did NOT choose them — do NOT reuse these titles or close variations):
${previouslyOfferedTitles.join(', ')}
` : ''}
DISCOVERY TOLERANCE: ${discoveryTolerance.toFixed(2)} (scale 0.0 = comfort-seeker, 1.0 = explorer)

${excludePremises.length > 0 ? `
PREVIOUSLY SHOWN PREMISES (DO NOT repeat these concepts, settings, or genre+theme combinations):
${excludePremises.map(p => `- "${p.title}" (${p.tier}): ${p.description}`).join('\n')}

Generate 3 COMPLETELY DIFFERENT premises. Not variations of the above — genuinely new concepts.
` : ''}
---

GENERATE EXACTLY 3 PREMISES with these specific roles:

**PREMISE 1 — COMFORT** (tier: "comfort")
This is the "I know exactly what you want" option. It should land squarely within their stated genre and theme preferences. Make it excellent, compelling, and deeply aligned with what they've told you they love. This is the safe bet — and it should be VERY tempting.

**PREMISE 2 — STRETCH** (tier: "stretch")
This combines two or more things from their profile in a way they would NOT have predicted. Maybe it collides two of their favorite genres. Maybe it takes a beloved theme into an unexpected setting. The key: every ingredient comes from their profile, but the combination is fresh. They should look at this and think "I never would have asked for this, but... I'm intrigued."

**PREMISE 3 — WILDCARD** (tier: "wildcard")
This is your curated surprise, Prospero. Look beneath their stated preferences to their EMOTIONAL DRIVERS — the reasons they read. Then find a completely different genre or setting that delivers that same emotional payload through an unexpected vehicle.

Wildcard calibration: ${wildcardCalibration}

Use TRISOCIATION: combine the reader's core emotional driver + a theme from their profile + an unexpected genre/setting into something that feels both surprising and inevitable. The reader would never have asked for this story. But three chapters in, they'll be hooked.

CRITICAL RULES:
- NEVER repeat a title, genre+setting combination, or core concept from their reading history
- All three premises must feel COMPLETELY distinct from each other
- The wildcard must STILL respect their avoid-list and age range
- Every premise must have a compelling hook — the first sentence should make them NEED to know what happens
- Genres in the response should be specific (e.g., "LitRPG", "Space Opera", "Cozy Mystery") not generic (e.g., "Fantasy", "Sci-Fi")

Return ONLY a JSON object in this exact format:
{
  "premises": [
    {
      "title": "Story Title",
      "description": "2-3 sentence compelling description that highlights the genre and themes",
      "hook": "One sentence that captures the essence and makes them want to read",
      "genre": "specific genre label",
      "themes": ["theme1", "theme2", "theme3"],
      "age_range": "${ageRange}",
      "tier": "comfort"
    },
    {
      "title": "...",
      "description": "...",
      "hook": "...",
      "genre": "...",
      "themes": ["..."],
      "age_range": "${ageRange}",
      "tier": "stretch"
    },
    {
      "title": "...",
      "description": "...",
      "hook": "...",
      "genre": "...",
      "themes": ["..."],
      "age_range": "${ageRange}",
      "tier": "wildcard"
    }
  ]
}`;

  const messages = [{ role: 'user', content: premisePrompt }];

  const { response, inputTokens, outputTokens } = await callClaudeWithRetry(
    messages,
    32000,
    { operation: 'generate_premises', userId }
  );

  await logApiCost(userId, 'generate_premises', inputTokens, outputTokens, { preferences });

  const parsed = parseAndValidateJSON(response, ['premises']);

  if (!Array.isArray(parsed.premises) || parsed.premises.length !== 3) {
    throw new Error('Expected exactly 3 premises');
  }

  // Validate tier tags and add unique IDs
  const validTiers = ['comfort', 'stretch', 'wildcard'];
  const premisesWithIds = parsed.premises.map((premise, i) => {
    if (!premise.tier || !validTiers.includes(premise.tier)) {
      // Fallback: assign by position (comfort, stretch, wildcard)
      premise.tier = validTiers[i] || 'comfort';
      console.log(`⚠️ Premise ${i+1} missing tier, assigned: ${premise.tier}`);
    }
    return {
      id: crypto.randomUUID(),
      ...premise
    };
  });

  console.log('✅ Generated premises with tiers:', premisesWithIds.map(p => ({ id: p.id, title: p.title, tier: p.tier })));

  // Store in database
  const { data, error } = await supabaseAdmin
    .from('story_premises')
    .insert({
      user_id: userId,
      premises: premisesWithIds,
      status: 'offered',
      preferences_used: preferences,
      generated_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to store premises: ${error.message}`);
  }

  // Clear one-shot fields (explicitRequest, storyDirection) after use
  // so the next generation doesn't reuse a stale specific request
  if (explicitRequest || (storyDirection && storyDirection !== 'comfort')) {
    const cleanedPrefs = { ...preferences };
    delete cleanedPrefs.explicitRequest;
    delete cleanedPrefs.storyDirection;

    const { error: clearError } = await supabaseAdmin
      .from('user_preferences')
      .update({
        preferences: cleanedPrefs,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    if (clearError) {
      console.log('⚠️ Failed to clear one-shot fields:', clearError);
    } else {
      console.log('🧹 Cleared explicitRequest/storyDirection after premise generation');
    }
  }

  return {
    premises: premisesWithIds,
    premisesId: data.id
  };
}

/**
 * Generate comprehensive story bible from selected premise
 */
async function generateStoryBible(premiseId, userId) {
  console.log(`🔍 Looking for premise ID: ${premiseId} for user: ${userId}`);

  // Fetch all premise records for this user (premises are stored as arrays)
  const { data: premiseRecords, error: premiseError } = await supabaseAdmin
    .from('story_premises')
    .select('id, premises, preferences_used')
    .eq('user_id', userId)
    .order('generated_at', { ascending: false });

  if (premiseError || !premiseRecords || premiseRecords.length === 0) {
    console.log('❌ No premise records found for user');
    throw new Error('Premise not found');
  }

  // Find the specific premise by ID within the arrays
  let selectedPremise = null;
  let preferencesUsed = null;
  let storyPremisesRecordId = null; // Parent record ID for FK

  for (const record of premiseRecords) {
    if (Array.isArray(record.premises)) {
      const found = record.premises.find(p => p.id === premiseId);
      if (found) {
        selectedPremise = found;
        preferencesUsed = record.preferences_used;
        storyPremisesRecordId = record.id; // Capture parent record ID
        console.log(`✅ Found premise: "${found.title}"`);
        console.log(`📝 Parent story_premises record ID: ${record.id}`);
        break;
      }
    }
  }

  if (!selectedPremise) {
    console.log('❌ Premise ID not found in any records');
    throw new Error(`Premise with ID ${premiseId} not found`);
  }

  const premise = selectedPremise;

  // ✅ CREATE STORY RECORD IMMEDIATELY (BEFORE Claude API call)
  // This prevents race condition where users can select the same premise twice
  // during the 30-60 second bible generation window
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .insert({
      user_id: userId,
      premise_id: storyPremisesRecordId,
      title: premise.title,  // Use premise.title (already known)
      status: 'active',
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
    throw new Error(`Failed to create story record: ${storyError.message}`);
  }

  const storyId = story.id;
  console.log(`✅ Story record created immediately: ${storyId} - "${premise.title}"`);

  // Fetch reading level from user_preferences (new column + JSONB fallback)
  const { data: userPrefs } = await supabaseAdmin
    .from('user_preferences')
    .select('reading_level, preferences')
    .eq('user_id', userId)
    .maybeSingle();

  const readingLevel = userPrefs?.reading_level || userPrefs?.preferences?.readingLevel || 'adult';
  const ageRange = preferencesUsed?.ageRange || 'adult'; // Keep for backward compatibility
  const belovedStories = preferencesUsed?.belovedStories || [];
  console.log(`📊 Bible generation - Reading Level: ${readingLevel}, Age Range (compat): ${ageRange}`);

  const prompt = `You are an expert world-builder and story architect creating a foundation for compelling fiction.

Create a comprehensive story bible for this premise:

<premise>
  <title>${premise.title}</title>
  <description>${premise.description}</description>
  <genre>${premise.genre}</genre>
  <themes>${premise.themes.join(', ')}</themes>
  <reading_level>
    Reading Level: ${readingLevel}
    Age Range: ${ageRange}
    Beloved Stories: ${belovedStories.join(', ') || 'not specified'}

    CALIBRATE ALL PROSE TO THIS READING LEVEL. Here's what each level means:

    early_reader: Short chapters (800-1200 words). Simple sentences averaging 8-12 words. Concrete vocabulary — show don't tell through action and dialogue, not internal monologue. Think Magic Tree House, Diary of a Wimpy Kid.

    middle_grade: Standard chapters (1500-2500 words). Sentences average 12-16 words with variety. Accessible vocabulary with occasional "stretch" words that context makes clear. Emotions shown through behavior and some internal thought. Think Percy Jackson, early Harry Potter.

    upper_middle_grade: Fuller chapters (2000-3000 words). Sentence variety with some complex structures. Moral ambiguity can be introduced. Internal conflict goes deeper. Think later Harry Potter, Hunger Games, Eragon.

    young_adult: Rich chapters (2500-4000 words). Full sentence complexity. Unreliable narrators OK. Sophisticated vocabulary used naturally. Deep thematic exploration. Think Six of Crows, Throne of Glass.

    new_adult/adult: No prose constraints. Full literary range.

    IMPORTANT: If the reader mentioned specific beloved stories, match THAT prose level, not a generic age-based level. A 12-year-old who loves Hunger Games should get prose closer to Suzanne Collins than to Jeff Kinney.
  </reading_level>
</premise>

The story bible should include:

1. WORLD RULES: The fundamental rules of this story's world (magic systems, technology, society structure)

2. PROTAGONIST (Deep Psychology Required):
   - Name, age, personality, strengths, flaws, goals, fears
   - INTERNAL CONTRADICTION: What opposing forces war inside them? (e.g., "craves independence but fears abandonment")
   - THE LIE THEY BELIEVE: What false belief about themselves holds them back? (e.g., "I'm not brave enough", "I have to do everything alone")
   - DEEPEST FEAR vs. STATED FEAR: What they're REALLY afraid of vs. what they say/think they fear
   - VOICE NOTES: How do they speak? Vocabulary level, sentence rhythm, verbal tics?

3. ANTAGONIST (Sympathetic Depth Required):
   - Name, motivation, methods, backstory
   - WHY THEY BELIEVE THEY'RE RIGHT: The antagonist should think they're justified. What's their moral framework?
   - WHAT WOULD MAKE READERS ALMOST SYMPATHIZE: What wound or belief drives them? What makes them human, not evil?
   - POINT OF NO RETURN: What event locked them into this path?

4. SUPPORTING CHARACTERS (2-3 key characters):
   - Name, role, personality
   - RELATIONSHIP DYNAMIC WITH PROTAGONIST: Not just "friend" or "mentor"—how do they challenge/complement/frustrate the protagonist? What's the emotional texture of their bond?
   - THEIR OWN GOAL: Supporting characters aren't props. What do THEY want?

5. CENTRAL CONFLICT: The main problem/challenge the protagonist must overcome

6. STAKES: What happens if the protagonist fails? What's at risk?

7. THEMES: Core themes to explore throughout the story

8. KEY LOCATIONS (3-5 settings):
   - Name, visual description, significance
   - SENSORY DETAILS: What does this place SOUND like? SMELL like? FEEL like (temperature, texture, atmosphere)?
   - Not just what it looks like—make it visceral and immersive

9. TIMELINE: Story timeframe and key events

Create a rich, psychologically complex world that will support a 12-chapter story for ages ${ageRange}. Every character should feel like they have an interior life. The world should feel tangible and lived-in.

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
      "fears": "string",
      "internal_contradiction": "opposing forces within them",
      "lie_they_believe": "false belief holding them back",
      "deepest_fear": "what they're REALLY afraid of (vs. what they say)",
      "voice_notes": "how they speak—vocabulary, rhythm, quirks"
    },
    "antagonist": {
      "name": "string",
      "motivation": "string",
      "methods": "string",
      "backstory": "string",
      "why_they_believe_theyre_right": "their moral justification",
      "sympathetic_element": "what makes them human/wounded",
      "point_of_no_return": "event that locked them on this path"
    },
    "supporting": [
      {
        "name": "string",
        "role": "string",
        "personality": "string",
        "relationship_dynamic": "how they interact with protagonist—not just 'friend' but emotional texture",
        "their_own_goal": "what THEY want (supporting chars aren't props)"
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
      "significance": "string",
      "sensory_details": {
        "sounds": "what you hear here",
        "smells": "what you smell",
        "tactile": "temperature, texture, atmospheric feel"
      }
    }
  ],
  "timeline": {
    "total_duration": "string",
    "key_milestones": ["milestone1", "milestone2"]
  }
}`;

  const messages = [{ role: 'user', content: prompt }];

  // Wrap Claude API call in try-catch to handle failures gracefully
  let response, inputTokens, outputTokens, parsed;
  try {
    const apiResult = await callClaudeWithRetry(
      messages,
      32000,
      { operation: 'generate_bible', userId, premiseId }
    );
    response = apiResult.response;
    inputTokens = apiResult.inputTokens;
    outputTokens = apiResult.outputTokens;

    parsed = parseAndValidateJSON(response, [
      'title', 'world_rules', 'characters', 'central_conflict',
      'stakes', 'themes', 'key_locations', 'timeline'
    ]);
  } catch (apiError) {
    // If Claude API fails, update story record with error and re-throw
    console.error(`❌ Bible generation failed for story ${storyId}:`, apiError);
    await supabaseAdmin
      .from('stories')
      .update({
        generation_progress: {
          bible_complete: false,
          arc_complete: false,
          chapters_generated: 0,
          current_step: 'bible_generation_failed',
          last_updated: new Date().toISOString(),
          error: apiError.message
        }
      })
      .eq('id', storyId);

    // Peggy: Report bible generation failures
    reportToPeggy({
      source: 'generation:generateStoryBible',
      category: 'generation',
      severity: 'high',
      errorMessage: `Bible generation failed: ${apiError.message}`,
      stackTrace: apiError.stack,
      storyId,
      storyTitle: 'unknown',
      context: { step: 'bible_generation' }
    }).catch(() => {});

    throw apiError;
  }

  // Store bible in database with story_id (story record was created above)
  const { data: bible, error: bibleError } = await supabaseAdmin
    .from('story_bibles')
    .insert({
      user_id: userId,
      // premise_id removed - FK references generated_premises, not story_premises
      story_id: storyId,  // Use storyId from story record created above
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

  // Update story with bible_id now that bible is created
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
    .eq('id', storyId);

  if (updateError) {
    throw new Error(`Failed to update story with bible_id: ${updateError.message}`);
  }

  await logApiCost(userId, 'generate_bible', inputTokens, outputTokens, {
    storyId: storyId,
    premiseId
  });

  return {
    bible: parsed,
    storyId: storyId
  };
}

/**
 * Generate story bible for an EXISTING story record
 * Used by POST /select-premise to generate bible after story record already exists
 * This allows the API to return immediately while generation happens in background
 */
async function generateStoryBibleForExistingStory(storyId, premiseId, userId) {
  // Fetch story title first for logging
  const { data: storyData } = await supabaseAdmin
    .from('stories')
    .select('title')
    .eq('id', storyId)
    .single();

  const storyTitle = storyData?.title || 'Unknown';
  storyLog(storyId, storyTitle, `📖 [${storyTitle}] Bible: calling Claude API...`);

  // Fetch all premise records for this user (premises are stored as arrays)
  const { data: premiseRecords, error: premiseError } = await supabaseAdmin
    .from('story_premises')
    .select('id, premises, preferences_used')
    .eq('user_id', userId)
    .order('generated_at', { ascending: false });

  if (premiseError || !premiseRecords || premiseRecords.length === 0) {
    console.log('❌ No premise records found for user');
    throw new Error('Premise not found');
  }

  // Find the specific premise by ID within the arrays
  // NOTE: premiseId could be either:
  //   - The individual premise UUID (from happy path / select-premise route)
  //   - The story_premises batch record ID (from health check recovery, which reads stories.premise_id)
  // We check both: first search inside premise arrays by individual ID,
  // then fall back to matching by batch record ID + story title
  let selectedPremise = null;
  let preferencesUsed = null;

  // Strategy 1: Search by individual premise ID inside arrays
  for (const record of premiseRecords) {
    if (Array.isArray(record.premises)) {
      const found = record.premises.find(p => p.id === premiseId);
      if (found) {
        selectedPremise = found;
        preferencesUsed = record.preferences_used;
        console.log(`✅ Found premise by individual ID: "${found.title}"`);
        break;
      }
    }
  }

  // Strategy 2: If not found, premiseId might be the batch record ID (stories.premise_id FK)
  // Match by batch record ID + story title
  if (!selectedPremise) {
    const matchingRecord = premiseRecords.find(r => r.id === premiseId);
    if (matchingRecord && Array.isArray(matchingRecord.premises)) {
      // Find the premise within this batch that matches the story title
      const found = matchingRecord.premises.find(p => p.title === storyTitle);
      if (found) {
        selectedPremise = found;
        preferencesUsed = matchingRecord.preferences_used;
        console.log(`✅ Found premise by batch record ID + title match: "${found.title}"`);
      }
    }
  }

  if (!selectedPremise) {
    console.log(`❌ Premise ID ${premiseId} not found by individual ID or batch+title match`);
    throw new Error(`Premise with ID ${premiseId} not found`);
  }

  const premise = selectedPremise;

  // Fetch reading level from user_preferences (new column + JSONB fallback)
  const { data: userPrefs } = await supabaseAdmin
    .from('user_preferences')
    .select('reading_level, preferences')
    .eq('user_id', userId)
    .maybeSingle();

  const readingLevel = userPrefs?.reading_level || userPrefs?.preferences?.readingLevel || 'adult';
  const ageRange = preferencesUsed?.ageRange || 'adult'; // Keep for backward compatibility
  const belovedStories = preferencesUsed?.belovedStories || [];
  console.log(`📊 Bible generation - Reading Level: ${readingLevel}, Age Range (compat): ${ageRange}`);

  const prompt = `You are an expert world-builder and story architect creating a foundation for compelling fiction.

Create a comprehensive story bible for this premise:

<premise>
  <title>${premise.title}</title>
  <description>${premise.description}</description>
  <genre>${premise.genre}</genre>
  <themes>${premise.themes.join(', ')}</themes>
  <reading_level>
    Reading Level: ${readingLevel}
    Age Range: ${ageRange}
    Beloved Stories: ${belovedStories.join(', ') || 'not specified'}

    CALIBRATE ALL PROSE TO THIS READING LEVEL. Here's what each level means:

    early_reader: Short chapters (800-1200 words). Simple sentences averaging 8-12 words. Concrete vocabulary — show don't tell through action and dialogue, not internal monologue. Think Magic Tree House, Diary of a Wimpy Kid.

    middle_grade: Standard chapters (1500-2500 words). Sentences average 12-16 words with variety. Accessible vocabulary with occasional "stretch" words that context makes clear. Emotions shown through behavior and some internal thought. Think Percy Jackson, early Harry Potter.

    upper_middle_grade: Fuller chapters (2000-3000 words). Sentence variety with some complex structures. Moral ambiguity can be introduced. Internal conflict goes deeper. Think later Harry Potter, Hunger Games, Eragon.

    young_adult: Rich chapters (2500-4000 words). Full sentence complexity. Unreliable narrators OK. Sophisticated vocabulary used naturally. Deep thematic exploration. Think Six of Crows, Throne of Glass.

    new_adult/adult: No prose constraints. Full literary range.

    IMPORTANT: If the reader mentioned specific beloved stories, match THAT prose level, not a generic age-based level. A 12-year-old who loves Hunger Games should get prose closer to Suzanne Collins than to Jeff Kinney.
  </reading_level>
</premise>

The story bible should include:

1. WORLD RULES: The fundamental rules of this story's world (magic systems, technology, society structure)

2. PROTAGONIST (Deep Psychology Required):
   - Name, age, personality, strengths, flaws, goals, fears
   - INTERNAL CONTRADICTION: What opposing forces war inside them? (e.g., "craves independence but fears abandonment")
   - THE LIE THEY BELIEVE: What false belief about themselves holds them back? (e.g., "I'm not brave enough", "I have to do everything alone")
   - DEEPEST FEAR vs. STATED FEAR: What they're REALLY afraid of vs. what they say/think they fear
   - VOICE NOTES: How do they speak? Vocabulary level, sentence rhythm, verbal tics?

3. ANTAGONIST (Sympathetic Depth Required):
   - Name, motivation, methods, backstory
   - WHY THEY BELIEVE THEY'RE RIGHT: The antagonist should think they're justified. What's their moral framework?
   - WHAT WOULD MAKE READERS ALMOST SYMPATHIZE: What wound or belief drives them? What makes them human, not evil?
   - POINT OF NO RETURN: What event locked them into this path?

4. SUPPORTING CHARACTERS (2-3 key characters):
   - Name, role, personality
   - RELATIONSHIP DYNAMIC WITH PROTAGONIST: Not just "friend" or "mentor"—how do they challenge/complement/frustrate the protagonist? What's the emotional texture of their bond?
   - THEIR OWN GOAL: Supporting characters aren't props. What do THEY want?

5. CENTRAL CONFLICT: The main problem/challenge the protagonist must overcome

6. STAKES: What happens if the protagonist fails? What's at risk?

7. THEMES: Core themes to explore throughout the story

8. KEY LOCATIONS (3-5 settings):
   - Name, visual description, significance
   - SENSORY DETAILS: What does this place SOUND like? SMELL like? FEEL like (temperature, texture, atmosphere)?
   - Not just what it looks like—make it visceral and immersive

9. TIMELINE: Story timeframe and key events

Create a rich, psychologically complex world that will support a 12-chapter story for ages ${ageRange}. Every character should feel like they have an interior life. The world should feel tangible and lived-in.

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
      "fears": "string",
      "internal_contradiction": "opposing forces within them",
      "lie_they_believe": "false belief holding them back",
      "deepest_fear": "what they're REALLY afraid of (vs. what they say)",
      "voice_notes": "how they speak—vocabulary, rhythm, quirks"
    },
    "antagonist": {
      "name": "string",
      "motivation": "string",
      "methods": "string",
      "backstory": "string",
      "why_they_believe_theyre_right": "their moral justification",
      "sympathetic_element": "what makes them human/wounded",
      "point_of_no_return": "event that locked them on this path"
    },
    "supporting": [
      {
        "name": "string",
        "role": "string",
        "personality": "string",
        "relationship_dynamic": "how they interact with protagonist—not just 'friend' but emotional texture",
        "their_own_goal": "what THEY want (supporting chars aren't props)"
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
      "significance": "string",
      "sensory_details": {
        "sounds": "what you hear here",
        "smells": "what you smell",
        "tactile": "temperature, texture, atmospheric feel"
      }
    }
  ],
  "timeline": {
    "total_duration": "string",
    "key_milestones": ["milestone1", "milestone2"]
  }
}`;

  const messages = [{ role: 'user', content: prompt }];

  // Wrap bible generation in retryGenerationStep for immediate retry on failure
  const bibleStartTime = Date.now();
  const result = await retryGenerationStep('Bible generation', storyId, storyTitle, async () => {
    // Call Claude API
    const apiResult = await callClaudeWithRetry(
      messages,
      32000,
      { operation: 'generate_bible', userId, premiseId, storyTitle }
    );

    const parsed = parseAndValidateJSON(apiResult.response, [
      'title', 'world_rules', 'characters', 'central_conflict',
      'stakes', 'themes', 'key_locations', 'timeline'
    ]);

    // Store bible in database with story_id (story record already exists)
    const { data: bible, error: bibleError } = await supabaseAdmin
      .from('story_bibles')
      .insert({
        user_id: userId,
        story_id: storyId,
        content: parsed,
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

    // Update story with bible_id now that bible is created
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
      .eq('id', storyId);

    if (updateError) {
      throw new Error(`Failed to update story with bible_id: ${updateError.message}`);
    }

    await logApiCost(userId, 'generate_bible', apiResult.inputTokens, apiResult.outputTokens, {
      storyId: storyId,
      premiseId
    });

    const bibleDuration = ((Date.now() - bibleStartTime) / 1000).toFixed(1);
    const bibleChars = JSON.stringify(parsed).length;
    storyLog(storyId, storyTitle, `📖 [${storyTitle}] Bible: generated ✅ (${bibleChars.toLocaleString()} chars, ${bibleDuration}s)`);

    return { bible, inputTokens: apiResult.inputTokens, outputTokens: apiResult.outputTokens };
  });

  return { storyId };
}

/**
 * Generate 12-chapter arc outline
 */
async function generateArcOutline(storyId, userId) {
  // Fetch story
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .single();

  if (storyError || !story) {
    throw new Error(`Story not found: ${storyError?.message || 'No story returned'}`);
  }

  // Fetch bible separately using story_id (use maybeSingle to handle potential duplicates)
  const { data: bible, error: bibleError } = await supabaseAdmin
    .from('story_bibles')
    .select('*')
    .eq('story_id', storyId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (bibleError || !bible) {
    throw new Error(`Bible not found for story ${storyId}: ${bibleError?.message || 'No bible returned'}`);
  }

  // Fetch preferences from story_premises to get age range
  let ageRange = '25+'; // default to adult
  if (story.premise_id) {
    const { data: premiseRecord } = await supabaseAdmin
      .from('story_premises')
      .select('preferences_used')
      .eq('id', story.premise_id)
      .single();

    if (premiseRecord?.preferences_used?.ageRange) {
      const rawAgeRange = premiseRecord.preferences_used.ageRange;
      ageRange = mapAgeRange(rawAgeRange);
      console.log(`📊 Arc generation - Age Range: ${rawAgeRange} → ${ageRange}`);
    }
  }

  const prompt = `You are an expert story structure designer creating a detailed roadmap for compelling fiction.

Using this story bible, create a detailed 12-chapter outline following a classic 3-act structure:

<story_bible_summary>
  <title>${bible.title}</title>

  <protagonist>
    <name>${bible.characters.protagonist.name}</name>
    <age>${bible.characters.protagonist.age}</age>
    <goals>${bible.characters.protagonist.goals}</goals>
    <fears>${bible.characters.protagonist.fears}</fears>
    <internal_contradiction>${bible.characters.protagonist.internal_contradiction || 'N/A'}</internal_contradiction>
    <lie_they_believe>${bible.characters.protagonist.lie_they_believe || 'N/A'}</lie_they_believe>
  </protagonist>

  <antagonist>
    <name>${bible.characters.antagonist.name}</name>
    <motivation>${bible.characters.antagonist.motivation}</motivation>
  </antagonist>

  <central_conflict>${bible.central_conflict.description}</central_conflict>

  <stakes>${bible.stakes.personal}</stakes>

  <themes>${bible.themes.join(', ')}</themes>

  <target_age>${ageRange}</target_age>
</story_bible_summary>

Create a 12-chapter outline that:
- Follows 3-act structure (Setup: Ch 1-4, Confrontation: Ch 5-9, Resolution: Ch 10-12)
- Each chapter builds tension and advances the plot
- Tracks character growth milestones across chapters
- Develops subplots alongside main plot
- Has appropriate pacing for ages ${ageRange}
- Each chapter is 2500-3500 words

FOR EACH CHAPTER, specify:
1. Title and events summary
2. Character focus
3. Tension level (low/medium/high)
4. EMOTIONAL ARC: What emotional state does the READER start in? What state do they end in? (e.g., "Start: curious, End: dread" or "Start: hopeful, End: devastated")
5. KEY DIALOGUE MOMENT: The most important conversation/exchange in this chapter (1 sentence description)
6. CHAPTER HOOK: What specific moment/question/cliffhanger makes the reader turn to the next chapter?
7. Key revelations
8. Word count target

ALSO specify:
- SUBPLOT TRACKING: Identify 2-3 subplots and note which chapters advance each subplot
- CHARACTER GROWTH MILESTONES: Map the protagonist's arc to specific chapters (e.g., Ch 3: First taste of confidence, Ch 7: Major failure/setback, Ch 11: Realization of truth)

Return ONLY a JSON object in this exact format:
{
  "chapters": [
    {
      "chapter_number": 1,
      "title": "Chapter Title",
      "events_summary": "2-3 sentence summary of what happens",
      "character_focus": "Which character(s) are featured",
      "tension_level": "low/medium/high",
      "emotional_arc": {
        "reader_start": "emotion/state reader starts in",
        "reader_end": "emotion/state reader ends in"
      },
      "key_dialogue_moment": "The most important conversation in this chapter",
      "chapter_hook": "What makes the reader turn to the next chapter",
      "key_revelations": ["revelation1", "revelation2"],
      "word_count_target": 3000
    }
  ],
  "pacing_notes": "Overall pacing strategy",
  "story_threads": {
    "main_plot": "description",
    "subplots": [
      {
        "name": "Subplot name/description",
        "chapters": [1, 3, 5, 8, 12],
        "resolution": "How this subplot resolves"
      }
    ]
  },
  "character_growth_milestones": {
    "chapter_3": "First milestone in protagonist's arc",
    "chapter_6": "Second milestone",
    "chapter_9": "Major turning point",
    "chapter_12": "Final transformation"
  }
}`;

  const messages = [{ role: 'user', content: prompt }];

  const storyTitle = story.title || 'Unknown';
  const { response, inputTokens, outputTokens } = await callClaudeWithRetry(
    messages,
    32000,
    { operation: 'generate_arc', userId, storyId, storyTitle }
  );

  const parsed = parseAndValidateJSON(response, ['chapters', 'pacing_notes', 'story_threads']);

  if (!Array.isArray(parsed.chapters) || parsed.chapters.length !== 12) {
    throw new Error('Expected exactly 12 chapters in arc outline');
  }

  // Check if arc already exists for this story (prevents duplicates on recovery)
  const { data: existingArc } = await supabaseAdmin
    .from('story_arcs')
    .select('id, chapters, outline')
    .eq('story_id', storyId)
    .eq('arc_number', 1)
    .maybeSingle();

  if (existingArc) {
    storyLog(storyId, storyTitle, `📖 [${storyTitle}] Arc already exists (id: ${existingArc.id}), skipping creation`);
    // Update story progress to reflect arc is complete
    await updateGenerationProgress(storyId, {
      bible_complete: true,
      arc_complete: true,
      chapters_generated: 0,
      current_step: 'arc_created'
    });
    return { arc: existingArc.outline || parsed };
  }

  // Store arc in database
  const { data: arc, error: arcError} = await supabaseAdmin
    .from('story_arcs')
    .insert({
      story_id: storyId,
      arc_number: 1,  // First arc for this story
      outline: parsed,  // REQUIRED: Full arc outline as JSONB
      bible_id: bible.id,
      chapters: parsed.chapters,
      pacing_notes: parsed.pacing_notes,
      story_threads: parsed.story_threads
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
 * Analyze user's feedback patterns to learn writing preferences
 * Requires at least 2 completed stories to run analysis
 */
async function analyzeUserPreferences(userId) {
  // Step 1: Count completed stories (stories with 12 chapters)
  const { data: stories } = await supabaseAdmin
    .from('stories')
    .select('id, title, premise_tier')
    .eq('user_id', userId);

  if (!stories || stories.length === 0) {
    return { ready: false, reason: 'No stories found' };
  }

  // Check which stories have 12 chapters
  const completedStories = [];
  for (const story of stories) {
    const { count } = await supabaseAdmin
      .from('chapters')
      .select('*', { count: 'exact', head: true })
      .eq('story_id', story.id);

    if (count === 12) {
      completedStories.push(story);
    }
  }

  if (completedStories.length < 2) {
    return {
      ready: false,
      reason: `Need at least 2 completed stories (found ${completedStories.length})`
    };
  }

  console.log(`📊 Analyzing preferences for user ${userId} across ${completedStories.length} completed stories`);

  // Step 2: Fetch all story_feedback rows
  const { data: feedbackRows } = await supabaseAdmin
    .from('story_feedback')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  // Step 3: Fetch all book_completion_interviews
  const { data: interviewRows } = await supabaseAdmin
    .from('book_completion_interviews')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  // Step 4: Fetch quality_review data from chapters for all user's stories
  const storyIds = stories.map(s => s.id);
  const { data: qualityData } = await supabaseAdmin
    .from('chapters')
    .select('story_id, chapter_number, quality_score, quality_review')
    .in('story_id', storyIds)
    .not('quality_review', 'is', null)
    .order('story_id', { ascending: true })
    .order('chapter_number', { ascending: true });

  // Step 4.5: Fetch reading analytics (chapter_reading_stats)
  const { data: readingStats } = await supabaseAdmin
    .from('chapter_reading_stats')
    .select('*')
    .eq('user_id', userId)
    .in('story_id', storyIds)
    .order('story_id', { ascending: true })
    .order('chapter_number', { ascending: true });

  // Build reading behavior summary
  let readingBehaviorSummary = 'No reading analytics';
  if (readingStats && readingStats.length > 0) {
    const avgReadingTime = Math.round(
      readingStats.reduce((sum, s) => sum + (s.total_reading_time_seconds || 0), 0) / readingStats.length
    );

    const skimmedChapters = readingStats.filter(s =>
      s.total_reading_time_seconds > 0 && s.total_reading_time_seconds < 120 // < 2 min
    );

    const rereadChapters = readingStats.filter(s => s.session_count > 1);

    const abandonedChapters = readingStats.filter(s => !s.completed && s.max_scroll_progress < 90);

    readingBehaviorSummary = `
Average reading time per chapter: ${Math.floor(avgReadingTime / 60)} min ${avgReadingTime % 60} sec
Chapters likely skimmed (< 2 min): ${skimmedChapters.length} chapters (${skimmedChapters.map(s => `Ch${s.chapter_number}`).join(', ')})
Chapters re-read (multiple sessions): ${rereadChapters.length} chapters (${rereadChapters.map(s => `Ch${s.chapter_number} (${s.session_count}x)`).join(', ')})
Abandoned chapters (not completed): ${abandonedChapters.length} chapters (${abandonedChapters.map(s => `Ch${s.chapter_number} (${s.max_scroll_progress.toFixed(0)}%)`).join(', ')})
    `.trim();
  }

  // Step 5: Build analysis prompt (with Adaptive Reading Engine dimension data)
  const feedbackSummary = feedbackRows?.map(f => {
    // Include dimension feedback (Adaptive Reading Engine) alongside old response field
    const dimensions = [];
    if (f.pacing_feedback) dimensions.push(`Pacing: ${f.pacing_feedback}`);
    if (f.tone_feedback) dimensions.push(`Tone: ${f.tone_feedback}`);
    if (f.character_feedback) dimensions.push(`Character: ${f.character_feedback}`);

    const dimensionStr = dimensions.length > 0 ? `, ${dimensions.join(', ')}` : '';
    const responseStr = f.response ? `Response: ${f.response}` : 'Response: N/A';
    const actionStr = f.follow_up_action ? `, Action: ${f.follow_up_action}` : '';

    return `Story: ${f.story_id.slice(0, 8)}..., Checkpoint: ${f.checkpoint}, ${responseStr}${dimensionStr}${actionStr}`;
  }).join('\n') || 'No checkpoint feedback';

  const interviewSummary = interviewRows?.map(i =>
    `Story: ${i.story_id.slice(0, 8)}..., Book ${i.book_number || 1}\nTranscript: ${i.transcript?.substring(0, 500) || 'N/A'}...\nPreferences: ${JSON.stringify(i.preferences_extracted || {})}`
  ).join('\n\n') || 'No completion interviews';

  const qualitySummary = qualityData?.map(q => {
    const criteriaScores = q.quality_review?.criteria_scores
      ? Object.entries(q.quality_review.criteria_scores).map(([key, val]) =>
          `${key}: ${val.score || 'N/A'}`
        ).join(', ')
      : 'N/A';
    return `Story: ${q.story_id.slice(0, 8)}..., Ch${q.chapter_number}, Overall: ${q.quality_score || 'N/A'}, Criteria: [${criteriaScores}]`;
  }).join('\n') || 'No quality data';

  // Build premise tier history
  const premiseTierHistory = stories
    .map(s => `"${s.title}" — tier: ${s.premise_tier || 'unknown'}`)
    .join('\n');

  const analysisPrompt = `You are analyzing a reader's feedback patterns across multiple stories to learn their preferences.

<feedback_data>
${feedbackSummary}
</feedback_data>

<interview_data>
${interviewSummary}
</interview_data>

<quality_scores>
${qualitySummary}
</quality_scores>

<reading_behavior>
${readingBehaviorSummary}
</reading_behavior>

<premise_tier_history>
${premiseTierHistory}
</premise_tier_history>

Based on this data, identify this reader's preferences:

PACING: Do they prefer action-dense or character-focused stories? Fast or deliberate?
DIALOGUE: Do they respond better to snappy/humorous or serious/emotional dialogue?
COMPLEXITY: What vocabulary and sentence complexity level works best?
THEMES: What themes/elements consistently appear in their highly-rated content?
WHAT TO AVOID: Are there patterns in what they dislike or rate as "Meh"?
CUSTOM INSTRUCTIONS: Generate 3-5 specific writing instructions that would make future stories better for THIS reader.
AVOID PATTERNS: Generate 2-3 specific things to avoid for this reader.
DISCOVERY PATTERN: Based on premise_tier_history, does this reader tend toward comfort picks or do they embrace wildcards? Are they happier (better feedback, more engagement) with familiar or unfamiliar stories? Summarize in one sentence.

DIMENSION FEEDBACK PATTERNS (Adaptive Reading Engine — HIGHEST WEIGHT):
Look at the pacing_feedback, tone_feedback, and character_feedback columns across checkpoints. These are the STRONGEST signals because they're specific and structured:
- If a reader consistently says "serious" for tone_feedback, STRONGLY weight humor_level HIGHER in custom_instructions (they want more humor)
- If a reader consistently says "slow" for pacing_feedback, STRONGLY weight action_density HIGHER (they want faster pacing)
- If a reader consistently says "fast" for pacing_feedback, weight description_ratio HIGHER (they want more breathing room)
- If a reader consistently says "warming" or "not_clicking" for character_feedback, add custom_instructions about deeper character interiority and vulnerability
- Checkpoint corrections that persisted across multiple checkpoints (e.g., "slow" at chapter_2 AND chapter_5) are the STRONGEST signal
- Dimension feedback is MORE RELIABLE than old "Meh/Great/Fantastic" responses because it's granular and actionable

Return ONLY a JSON object:
{
  "preferred_pacing": {
    "action_density": 0.0-1.0,
    "description_ratio": 0.0-1.0,
    "summary": "one sentence"
  },
  "preferred_dialogue_style": {
    "style": "snappy|balanced|literary",
    "humor_level": 0.0-1.0,
    "summary": "one sentence"
  },
  "preferred_complexity": {
    "vocabulary_grade_level": number,
    "sentence_variation": 0.0-1.0,
    "summary": "one sentence"
  },
  "character_voice_preferences": {
    "summary": "one sentence about what character types they like"
  },
  "custom_instructions": ["instruction1", "instruction2", "instruction3"],
  "avoid_patterns": ["pattern1", "pattern2"],
  "discovery_pattern": "one sentence about comfort vs wildcard preference",
  "confidence": 0.0-1.0,
  "analysis_summary": "2-3 sentence summary of this reader's taste"
}`;

  // Step 6: Call Claude to analyze
  const startTime = Date.now();
  const response = await anthropic.messages.create({
    model: GENERATION_MODEL,
    max_tokens: 32000,
    messages: [{ role: 'user', content: analysisPrompt }]
  });

  const duration = Date.now() - startTime;
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  console.log(`✅ Preference analysis complete (${duration}ms, ${inputTokens + outputTokens} tokens)`);

  // Step 7: Parse response
  const parsed = parseAndValidateJSON(response.content[0].text, [
    'preferred_pacing',
    'preferred_dialogue_style',
    'preferred_complexity',
    'character_voice_preferences',
    'custom_instructions',
    'avoid_patterns',
    'discovery_pattern',
    'confidence',
    'analysis_summary'
  ]);

  // Step 8: Upsert into user_writing_preferences
  const { data: upserted, error: upsertError } = await supabaseAdmin
    .from('user_writing_preferences')
    .upsert({
      user_id: userId,
      preferred_pacing: parsed.preferred_pacing,
      preferred_dialogue_style: parsed.preferred_dialogue_style,
      preferred_complexity: parsed.preferred_complexity,
      character_voice_preferences: parsed.character_voice_preferences,
      custom_instructions: parsed.custom_instructions,
      avoid_patterns: parsed.avoid_patterns,
      discovery_pattern: parsed.discovery_pattern,
      stories_analyzed: completedStories.length,
      feedback_data_points: (feedbackRows?.length || 0) + (interviewRows?.length || 0),
      confidence_score: Math.round(parsed.confidence * 100) / 100, // Round to 2 decimals
      analysis_summary: parsed.analysis_summary,
      last_updated: new Date().toISOString()
    }, {
      onConflict: 'user_id'
    })
    .select()
    .single();

  if (upsertError) {
    throw new Error(`Failed to store preferences: ${upsertError.message}`);
  }

  // Step 8b: Write learned_adjustments summary back to user_preferences
  // This ensures base preferences evolve over time without overwriting onboarding data
  try {
    const { data: currentPrefs } = await supabaseAdmin
      .from('user_preferences')
      .select('preferences')
      .eq('user_id', userId)
      .maybeSingle();

    if (currentPrefs?.preferences) {
      const updatedPreferences = {
        ...currentPrefs.preferences,
        learned_adjustments: {
          updated_at: new Date().toISOString(),
          stories_analyzed: completedStories.length,
          confidence: Math.round(parsed.confidence * 100) / 100,
          pacing_tendency: parsed.preferred_pacing?.summary || null,
          tone_tendency: parsed.preferred_dialogue_style?.summary || null,
          complexity_tendency: parsed.preferred_complexity?.summary || null,
          custom_notes: parsed.custom_instructions?.join('; ') || null,
          avoid_notes: parsed.avoid_patterns?.join('; ') || null,
          analysis_summary: parsed.analysis_summary
        }
      };

      await supabaseAdmin
        .from('user_preferences')
        .update({
          preferences: updatedPreferences,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId);

      console.log(`📝 Learned adjustments written back to user_preferences (${completedStories.length} books analyzed)`);
    }
  } catch (learnedErr) {
    // Non-blocking — don't fail the whole analysis if this write fails
    console.warn(`⚠️ Failed to write learned_adjustments to user_preferences: ${learnedErr.message}`);
  }

  // Step 8c: Log preference event
  await logPreferenceEvent(userId, 'analysis_update', 'system', {
    stories_analyzed: completedStories.length,
    confidence: parsed.confidence,
    custom_instructions: parsed.custom_instructions,
    avoid_patterns: parsed.avoid_patterns,
    pacing_summary: parsed.preferred_pacing?.summary,
    dialogue_summary: parsed.preferred_dialogue_style?.summary,
    analysis_summary: parsed.analysis_summary
  });

  // Step 9: Log API cost
  await logApiCost(userId, 'analyze_preferences', inputTokens, outputTokens, {
    stories_analyzed: completedStories.length,
    confidence: parsed.confidence
  });

  return {
    ready: true,
    preferences: upserted,
    stats: {
      stories_analyzed: completedStories.length,
      feedback_points: (feedbackRows?.length || 0) + (interviewRows?.length || 0),
      confidence: parsed.confidence
    }
  };
}

/**
 * Get user's learned writing preferences
 */
async function getUserWritingPreferences(userId) {
  const { data } = await supabaseAdmin
    .from('user_writing_preferences')
    .select('*')
    .eq('user_id', userId)
    .single();

  return data; // null if no preferences yet
}

/**
 * Log a preference event for audit trail.
 * Non-blocking — failures are logged but don't break the caller.
 *
 * @param {string} userId
 * @param {string} eventType - 'onboarding', 'returning_user', 'checkpoint_feedback', 'book_completion', 'analysis_update', 'explicit_request', 'skip_checkpoint'
 * @param {string} source - 'voice', 'text', 'dimension_cards', 'system'
 * @param {object} eventData - flexible payload (snapshot of what changed)
 * @param {string} [storyId] - optional story context
 */
async function logPreferenceEvent(userId, eventType, source, eventData, storyId = null) {
  try {
    await supabaseAdmin
      .from('preference_events')
      .insert({
        user_id: userId,
        event_type: eventType,
        source,
        story_id: storyId,
        event_data: eventData
      });
  } catch (err) {
    console.warn(`⚠️ Failed to log preference event (${eventType}): ${err.message}`);
  }
}

/**
 * Update discovery tolerance based on reader's selection patterns and feedback
 * This is the learning loop: behavior → adjustment → smarter future premises
 */
async function updateDiscoveryTolerance(userId) {
  // Fetch current tolerance
  const { data: userPrefs } = await supabaseAdmin
    .from('user_preferences')
    .select('discovery_tolerance, preferences')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let tolerance = userPrefs?.discovery_tolerance ?? 0.5;
  const originalTolerance = tolerance;

  // Fetch stories with tiers (only those created AFTER premise_tier was added)
  const { data: stories } = await supabaseAdmin
    .from('stories')
    .select('id, premise_tier, created_at')
    .eq('user_id', userId)
    .not('premise_tier', 'is', null)
    .order('created_at', { ascending: false })
    .limit(10);

  if (!stories || stories.length === 0) {
    return { tolerance, changed: false, reason: 'No tier-tracked stories yet' };
  }

  // Fetch completion interviews for these stories
  const storyIds = stories.map(s => s.id);
  const { data: interviews } = await supabaseAdmin
    .from('book_completion_interviews')
    .select('story_id, preferences_extracted')
    .in('story_id', storyIds);

  const interviewMap = {};
  (interviews || []).forEach(i => { interviewMap[i.story_id] = i; });

  // --- ADJUSTMENT RULES ---

  // Rule 1: Recent selection patterns
  const recentTiers = stories.slice(0, 5).map(s => s.premise_tier);
  const comfortCount = recentTiers.filter(t => t === 'comfort').length;
  const stretchCount = recentTiers.filter(t => t === 'stretch').length;
  const wildcardCount = recentTiers.filter(t => t === 'wildcard').length;

  // Consistently picking comfort across 3+ recent stories = tolerance down
  if (comfortCount >= 3) {
    tolerance -= 0.05;
  }

  // Picking stretch or wildcard = tolerance up per pick
  tolerance += (stretchCount + wildcardCount) * 0.03;

  // Rule 2: Completion feedback on wildcards/stretches
  for (const story of stories) {
    if (story.premise_tier === 'wildcard' || story.premise_tier === 'stretch') {
      const interview = interviewMap[story.id];
      if (interview?.preferences_extracted) {
        const signal = interview.preferences_extracted.satisfactionSignal;
        if (signal === 'loved_it' || signal === 'wanting_more' || signal === 'fantastic') {
          tolerance += 0.05;  // Positive wildcard/stretch experience
        } else if (signal === 'disappointed' || signal === 'not_for_me') {
          tolerance -= 0.05;  // Negative experience
        }
      }
    }
  }

  // Rule 3: Check for abandoned wildcards (stories with < 6 chapters read)
  for (const story of stories) {
    if (story.premise_tier === 'wildcard') {
      const { count } = await supabaseAdmin
        .from('chapter_reading_stats')
        .select('*', { count: 'exact', head: true })
        .eq('story_id', story.id)
        .eq('user_id', userId)
        .eq('completed', true);

      // If they didn't finish at least 6 chapters of a wildcard, tolerance down
      if (count !== null && count < 6) {
        tolerance -= 0.08;
      }
    }
  }

  // Rule 4: Discarded premise patterns
  const { data: discards } = await supabaseAdmin
    .from('premise_discards')
    .select('discarded_premises')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (discards && discards.length > 0) {
    const allDiscarded = discards.flatMap(d => d.discarded_premises || []);
    const discardedWildcards = allDiscarded.filter(p => p.tier === 'wildcard').length;
    const discardedComforts = allDiscarded.filter(p => p.tier === 'comfort').length;

    if (discardedWildcards >= 3) tolerance -= 0.05;
    if (discardedComforts >= 3) tolerance += 0.05;
  }

  // Clamp to floor/ceiling
  tolerance = Math.max(0.1, Math.min(0.95, tolerance));
  tolerance = Math.round(tolerance * 100) / 100;  // Round to 2 decimals

  // Only update if changed
  if (tolerance !== originalTolerance) {
    await supabaseAdmin
      .from('user_preferences')
      .update({ discovery_tolerance: tolerance })
      .eq('user_id', userId);

    console.log(`🎯 Discovery tolerance updated: ${originalTolerance} → ${tolerance} for user ${userId}`);
  }

  return {
    tolerance,
    changed: tolerance !== originalTolerance,
    previous: originalTolerance,
    reason: `Analyzed ${stories.length} stories (${comfortCount}C/${stretchCount}S/${wildcardCount}W)`
  };
}

/**
 * Generate editor-revised chapter briefs that weave corrections into the outline itself.
 * Instead of a separate correction block that fights the rest of the prompt,
 * this produces modified outlines where the corrections are part of the plan.
 *
 * @param {string} storyId
 * @param {Array} feedbackHistory - checkpoint feedback records
 * @param {Array} chapterOutlines - the 3 chapter outlines for this batch (from story_arcs)
 * @returns {Promise<Object|null>} { revisedOutlines: [{...}], styleExample: string } or null
 */
async function generateEditorBrief(storyId, feedbackHistory, chapterOutlines) {
  const latestFeedback = feedbackHistory[feedbackHistory.length - 1];

  // If all dimensions are positive/neutral, no editor brief needed
  const needsCorrection =
    (latestFeedback.tone_feedback && latestFeedback.tone_feedback !== 'right') ||
    (latestFeedback.character_feedback && latestFeedback.character_feedback !== 'love') ||
    (latestFeedback.pacing_feedback && latestFeedback.pacing_feedback !== 'hooked');

  if (!needsCorrection) {
    return null; // No revisions needed, use original outlines
  }

  console.log(`📝 [Story ${storyId}] Generating editor brief with course corrections...`);

  try {
    // Fetch story context
    const { data: bible } = await supabaseAdmin
      .from('story_bibles')
      .select('*')
      .eq('story_id', storyId)
      .single();

    if (!bible) {
      console.warn(`⚠️ No bible for story ${storyId}, skipping editor brief`);
      return null;
    }

    const { data: chapters } = await supabaseAdmin
      .from('chapters')
      .select('chapter_number, title, metadata, content')
      .eq('story_id', storyId)
      .order('chapter_number', { ascending: true });

    const { data: story } = await supabaseAdmin
      .from('stories')
      .select('title, genre, premise')
      .eq('id', storyId)
      .single();

    const protagonist = bible.characters?.protagonist || { name: 'Protagonist', personality: 'Unknown' };
    const supporting = bible.characters?.supporting || [];
    const antagonist = bible.characters?.antagonist || { name: 'Antagonist', motivation: 'Unknown' };

    // Get brief content samples from existing chapters (first ~600 chars of each)
    const proseSamples = chapters && chapters.length > 0
      ? chapters.slice(-2).map(ch =>
          `Chapter ${ch.chapter_number} "${ch.title}" opens:\n${(ch.content || '').substring(0, 600)}...`
        ).join('\n\n')
      : 'No chapters available';

    const chapterSummaries = chapters && chapters.length > 0
      ? chapters.map(ch =>
          `Chapter ${ch.chapter_number} "${ch.title}": ${(ch.metadata?.key_events || []).join('; ')}`
        ).join('\n')
      : 'No chapters yet';

    const outlineText = chapterOutlines.map(ch =>
      `Chapter ${ch.chapter_number} "${ch.title}":
  Events: ${ch.events_summary}
  Character focus: ${ch.character_focus}
  Tension level: ${ch.tension_level}
  Word count target: ${ch.word_count_target}`
    ).join('\n\n');

    // Build feedback description
    const feedbackDesc = [];
    if (latestFeedback.pacing_feedback && latestFeedback.pacing_feedback !== 'hooked') {
      feedbackDesc.push(`PACING: Reader says "${latestFeedback.pacing_feedback}" — ${latestFeedback.pacing_feedback === 'slow' ? 'story feels sluggish, needs more momentum and forward drive' : 'story is rushing, needs more breathing room and emotional landing'}`);
    }
    if (latestFeedback.tone_feedback && latestFeedback.tone_feedback !== 'right') {
      feedbackDesc.push(`TONE: Reader says "${latestFeedback.tone_feedback}" — ${latestFeedback.tone_feedback === 'serious' ? 'story is too relentlessly heavy, needs moments of levity, warmth, dry humor, or human absurdity woven between the tension' : 'story is too breezy, needs higher emotional stakes and more weight to the consequences'}`);
    }
    if (latestFeedback.character_feedback && latestFeedback.character_feedback !== 'love') {
      feedbackDesc.push(`CHARACTER: Reader says "${latestFeedback.character_feedback}" — ${latestFeedback.character_feedback === 'warming' ? 'reader is starting to connect but wants more vulnerability, interior thought, and relatable human moments from the protagonist' : 'reader is not connecting at all — protagonist needs more agency, a more distinctive voice, and moments that make the reader root for them'}`);
    }

    const editorPrompt = `You are a senior fiction editor reviewing chapter outlines for a novel-in-progress. A reader has finished chapters 1-3 and given feedback. Your job is to ANNOTATE the chapter outlines for chapters 4-6 with specific micro-beats that address the feedback — and write one short example passage showing the target prose style.

CRITICAL RULES:
- You are making SUBTLE adjustments, not overhauling the story. The reader should feel the story warming up, not lurching into a different book.
- Add 2-3 specific beats per chapter. A "beat" is a concrete moment: "When [character] does [action], add [specific adjustment]."
- Do NOT change what happens in the plot. Only change HOW scenes are written.
- The evolution should be GRADUAL. Chapter 4 shifts 10-15% from the established tone. Not 50%.

<story_context>
Title: ${story.title}
Genre: ${story.genre}
Premise: ${story.premise}

Protagonist: ${protagonist.name} — ${protagonist.personality || 'Unknown'}
Voice: ${protagonist.voice_notes || 'Not specified'}
Flaws: ${(protagonist.flaws || []).join(', ') || 'Not specified'}

Supporting: ${supporting.map(sc => `${sc.name} (${sc.role || 'supporting'})`).join(', ') || 'None'}
Antagonist: ${antagonist.name}
</story_context>

<what_happened_so_far>
${chapterSummaries}
</what_happened_so_far>

<current_prose_style>
${proseSamples}
</current_prose_style>

<reader_feedback>
${feedbackDesc.join('\n')}
</reader_feedback>

<chapter_outlines_to_revise>
${outlineText}
</chapter_outlines_to_revise>

Now produce TWO things:

PART 1 — REVISED OUTLINES
For each chapter (4, 5, 6), return the original outline PLUS an "editor_notes" field with 2-3 specific beat annotations. Each annotation should:
- Name a character
- Describe a specific moment or scene type
- Say exactly what the adjustment looks like

Example of a good annotation: "When Jinx is reviewing supply data in the logistics bay, give her one sardonic internal observation about an absurd line item — something that reveals her dark humor without breaking the espionage tension. Think a single wry thought, not a comedy routine."

Example of a bad annotation: "Add more humor to this chapter."

PART 2 — STYLE EXAMPLE
Write an original 80-120 word passage that demonstrates how this story should sound WITH the corrections applied. Use the actual character names. Match the genre. Show the adjustment in action — don't describe it, demonstrate it. This passage doesn't need to be from any specific chapter; it's a TONE TARGET for the writer to pattern-match against.

Return as XML (NOT JSON — avoid quote escaping issues):

<editor_brief>
  <revised_outline chapter="4">
    <title>[original title]</title>
    <events_summary>[original events]</events_summary>
    <character_focus>[original focus]</character_focus>
    <tension_level>[original level]</tension_level>
    <word_count_target>[original target]</word_count_target>
    <editor_notes>
      [2-3 specific beat annotations, each on its own line]
    </editor_notes>
  </revised_outline>
  <revised_outline chapter="5">
    [same structure]
  </revised_outline>
  <revised_outline chapter="6">
    [same structure]
  </revised_outline>
  <style_example>
    [80-120 word original passage demonstrating corrected tone with actual character names]
  </style_example>
</editor_brief>`;

    console.log(`📝 [${story.title}] Calling editor brief generation...`);

    const { response, inputTokens, outputTokens } = await callClaudeWithRetry(
      [{ role: 'user', content: editorPrompt }],
      6000,
      { operation: 'generate_editor_brief', storyId, storyTitle: story.title }
    );

    await logApiCost(null, 'generate_editor_brief', inputTokens, outputTokens, { storyId });

    // Parse XML response (much more robust than JSON for long-form text)
    const revisedOutlines = [];
    const outlineMatches = response.matchAll(/<revised_outline chapter="(\d+)">([\s\S]*?)<\/revised_outline>/g);

    for (const match of outlineMatches) {
      const chapterNum = parseInt(match[1]);
      const content = match[2];

      const getTag = (tag) => {
        const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
        return m ? m[1].trim() : '';
      };

      revisedOutlines.push({
        chapter_number: chapterNum,
        title: getTag('title'),
        events_summary: getTag('events_summary'),
        character_focus: getTag('character_focus'),
        tension_level: getTag('tension_level'),
        word_count_target: getTag('word_count_target'),
        editor_notes: getTag('editor_notes')
      });
    }

    const styleMatch = response.match(/<style_example>([\s\S]*?)<\/style_example>/);
    const styleExample = styleMatch ? styleMatch[1].trim() : null;

    if (revisedOutlines.length === 0) {
      console.warn(`⚠️ [${story.title}] Editor brief parsing found 0 outlines, falling back`);
      return null;
    }

    console.log(`🎯 [${story.title}] Editor brief generated: ${revisedOutlines.length} revised outlines, style example: ${styleExample ? 'yes' : 'no'}`);
    revisedOutlines.forEach(o => {
      console.log(`  Ch${o.chapter_number}: ${o.editor_notes.substring(0, 120)}...`);
    });

    return { revisedOutlines, styleExample };

  } catch (error) {
    console.error(`❌ [${story.title}] Editor brief generation failed: ${error.message}`);
    return null;
  }
}

/**
 * Build course correction XML block from checkpoint feedback history
 * @param {Array} feedbackHistory - Array of checkpoint feedback objects with dimension fields OR checkpoint_corrections JSONB
 * @returns {string} Formatted course correction text for prompt injection
 */
function buildCourseCorrections(feedbackHistory) {
  if (!feedbackHistory || feedbackHistory.length === 0) {
    return '';
  }

  // Check if this is new format (checkpoint_corrections JSONB) or old format (dimension fields)
  const hasNewFormat = feedbackHistory.some(fb => fb.checkpoint_corrections);
  const hasOldFormat = feedbackHistory.some(fb => fb.pacing_feedback || fb.tone_feedback || fb.character_feedback);

  // NEW FORMAT: Structured interview feedback from Prospero checkpoint conversations
  if (hasNewFormat) {
    const checkpointLabels = {
      'chapter_2': 'CHECKPOINT 1 (after Ch 2)',
      'chapter_5': 'CHECKPOINT 2 (after Ch 5)',
      'chapter_8': 'CHECKPOINT 3 (after Ch 8)'
    };

    let feedbackSections = feedbackHistory
      .filter(fb => fb.checkpoint_corrections)
      .map(fb => {
        const label = checkpointLabels[fb.checkpoint] || fb.checkpoint;
        const corrections = fb.checkpoint_corrections;

        let section = `${label}:\n`;
        if (corrections.pacing_note) section += `  PACING: ${corrections.pacing_note}\n`;
        if (corrections.tone_note) section += `  TONE: ${corrections.tone_note}\n`;
        if (corrections.character_notes && corrections.character_notes.length > 0) {
          section += `  CHARACTER: ${corrections.character_notes.join('; ')}\n`;
        }
        if (corrections.style_note) section += `  STYLE: ${corrections.style_note}\n`;
        if (corrections.overall_engagement) section += `  ENGAGEMENT: ${corrections.overall_engagement}\n`;
        if (corrections.raw_reader_quotes && corrections.raw_reader_quotes.length > 0) {
          section += `  READER QUOTES: "${corrections.raw_reader_quotes.join('"; "')}"`;
        }

        return section;
      })
      .join('\n\n');

    const wrapperText = feedbackHistory.length === 1
      ? 'The reader provided feedback in a checkpoint conversation with Prospero.'
      : 'The reader has had multiple checkpoint conversations with Prospero throughout this story.';

    return `${wrapperText} Apply these as SUBTLE REFINEMENTS. Do not overhaul the story — lean into the changes so the reader feels improvement without feeling like a different book.

${feedbackSections}

IMPORTANT: These are adjustments to HOW the story is told, not WHAT happens.
The story bible, arc outline, and plot events remain exactly as planned.
Only the craft of the telling changes.`;
  }

  // OLD FORMAT: Dimension-based card tap feedback (backward compatibility)
  const pacingInstructions = {
    'hooked': 'Maintain current pacing parameters — reader is engaged',
    'slow': 'Enter scenes later, leave earlier. Shorter paragraphs. More cliffhanger chapter endings. Reduce descriptive passages. Increase action-to-reflection ratio.',
    'fast': 'Add sensory grounding moments. Longer scene transitions. More internal reflection. Let emotional beats land before moving on.'
  };

  const toneInstructions = {
    'right': 'Maintain current tone parameters — reader finds it appropriate',
    'serious': 'Add moments of humor through dialogue and character interactions. Give protagonist or a secondary character dry wit. Include at least one moment of comic relief per chapter. Lighter metaphors.',
    'light': 'Deepen emotional stakes. More consequence to actions. Richer internal conflict. Reduce banter, increase tension.'
  };

  const characterInstructions = {
    'love': 'Maintain current characterization — it\'s working',
    'warming': 'Add more interior thought and vulnerability. Show relatable mundane moments alongside the extraordinary. Reveal backstory through action, not exposition.',
    'not_clicking': 'Increase protagonist agency and decisiveness. Show more competence. Add moments where they surprise the reader. Lean into their unique voice.'
  };

  // Single checkpoint case
  if (feedbackHistory.length === 1) {
    const fb = feedbackHistory[0];
    let sections = [];

    if (fb.pacing_feedback && pacingInstructions[fb.pacing_feedback]) {
      const instruction = fb.pacing_feedback === 'hooked'
        ? pacingInstructions[fb.pacing_feedback]
        : `PACING (reader said: ${fb.pacing_feedback}):\n  - ${pacingInstructions[fb.pacing_feedback].split('. ').join('\n  - ')}`;
      sections.push(instruction);
    }

    if (fb.tone_feedback && toneInstructions[fb.tone_feedback]) {
      const instruction = fb.tone_feedback === 'right'
        ? toneInstructions[fb.tone_feedback]
        : `TONE (reader said: too ${fb.tone_feedback}):\n  - ${toneInstructions[fb.tone_feedback].split('. ').join('\n  - ')}`;
      sections.push(instruction);
    }

    if (fb.character_feedback && characterInstructions[fb.character_feedback]) {
      const instruction = fb.character_feedback === 'love'
        ? characterInstructions[fb.character_feedback]
        : `CHARACTER (reader said: ${fb.character_feedback.replace('_', ' ')}):\n  - ${characterInstructions[fb.character_feedback].split('. ').join('\n  - ')}`;
      sections.push(instruction);
    }

    if (sections.length === 0) return '';

    return `The reader has provided feedback on the story so far. Adjust your writing
to address these preferences while maintaining the story bible and arc:

${sections.join('\n\n')}

IMPORTANT: These are adjustments to HOW the story is told, not WHAT happens.
The story bible, arc outline, and plot events remain exactly as planned.
Only the craft of the telling changes.`;
  }

  // Multiple checkpoints case - show trajectory and accumulated corrections
  const checkpointLabels = {
    'chapter_2': 'CHECKPOINT 1 (after Ch 2)',
    'chapter_5': 'CHECKPOINT 2 (after Ch 5)',
    'chapter_8': 'CHECKPOINT 3 (after Ch 8)'
  };

  let history = feedbackHistory.map(fb => {
    const label = checkpointLabels[fb.checkpoint] || fb.checkpoint;
    const pacing = fb.pacing_feedback ? `Pacing: ${fb.pacing_feedback}` : null;
    const tone = fb.tone_feedback ? `Tone: ${fb.tone_feedback}` : null;
    const character = fb.character_feedback ? `Character: ${fb.character_feedback}` : null;

    return `${label}:
  ${[pacing, tone, character].filter(Boolean).join('\n  ')}`;
  }).join('\n\n');

  // Determine current directives based on latest feedback
  const latest = feedbackHistory[feedbackHistory.length - 1];
  let directives = [];

  if (latest.pacing_feedback && pacingInstructions[latest.pacing_feedback]) {
    const prefix = latest.pacing_feedback === 'hooked' ? '- ' : '- ';
    directives.push(`${prefix}${pacingInstructions[latest.pacing_feedback]}`);
  }

  if (latest.tone_feedback && toneInstructions[latest.tone_feedback]) {
    const prefix = latest.tone_feedback === 'right' ? '- ' : '- ';
    directives.push(`${prefix}${toneInstructions[latest.tone_feedback]}`);
  }

  if (latest.character_feedback && characterInstructions[latest.character_feedback]) {
    const prefix = latest.character_feedback === 'love' ? '- ' : '- ';
    directives.push(`${prefix}${characterInstructions[latest.character_feedback]}`);
  }

  return `Feedback history across this story:

${history}

Current writing directives (accumulated):
${directives.join('\n')}

IMPORTANT: These are adjustments to HOW the story is told, not WHAT happens.
The story bible, arc outline, and plot events remain exactly as planned.
Only the craft of the telling changes.`;
}

/**
 * Generate a batch of chapters (3 at a time) with optional course corrections
 * @param {string} storyId - The story ID
 * @param {number} startChapter - First chapter number to generate
 * @param {number} endChapter - Last chapter number to generate (inclusive)
 * @param {string} userId - User ID for cost tracking
 * @param {string} courseCorrections - Optional course correction text to inject into prompts
 */
async function generateBatch(storyId, startChapter, endChapter, userId, editorBrief = null) {
  const { data: story } = await supabaseAdmin
    .from('stories')
    .select('title')
    .eq('id', storyId)
    .single();

  const storyTitle = story?.title || 'Unknown';

  storyLog(storyId, storyTitle, `🚀 [${storyTitle}] Batch generation: chapters ${startChapter}-${endChapter}${editorBrief ? ' with editor brief' : ''}`);

  for (let i = startChapter; i <= endChapter; i++) {
    storyLog(storyId, storyTitle, `📖 [${storyTitle}] Chapter ${i}: starting generation...`);
    const chapterStartTime = Date.now();

    const chapter = await generateChapter(storyId, i, userId, editorBrief);

    const chapterDuration = ((Date.now() - chapterStartTime) / 1000).toFixed(1);
    const charCount = chapter?.content?.length || 0;
    storyLog(storyId, storyTitle, `📖 [${storyTitle}] Chapter ${i}: saved ✅ (${charCount.toLocaleString()} chars, ${chapterDuration}s)`);

    // 1-second pause between chapters
    if (i < endChapter) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  storyLog(storyId, storyTitle, `✅ [${storyTitle}] Batch complete: chapters ${startChapter}-${endChapter}`);
}

/**
 * Generate a single chapter with quality review
 * @param {string} storyId - The story ID
 * @param {number} chapterNumber - The chapter number to generate
 * @param {string} userId - User ID for cost tracking
 * @param {Object} editorBrief - Optional editor brief with revised outlines and style example (default: null)
 */
async function generateChapter(storyId, chapterNumber, userId, editorBrief = null) {
  // Check if chapter already exists (prevents duplicate generation for legacy stories or recovery loops)
  const { data: existingChapter } = await supabaseAdmin
    .from('chapters')
    .select('id, title, content')
    .eq('story_id', storyId)
    .eq('chapter_number', chapterNumber)
    .maybeSingle();

  if (existingChapter) {
    console.log(`📖 Chapter ${chapterNumber} already exists for story ${storyId}, skipping generation`);
    return existingChapter;
  }

  // Fetch story
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .single();

  if (storyError || !story) {
    throw new Error(`Story not found: ${storyError?.message || 'No story returned'}`);
  }

  const storyTitle = story.title || 'Untitled';

  // Get generation config for feature flags
  const config = story.generation_config || {};

  // Fetch bible and arc separately
  const { data: bible } = await supabaseAdmin
    .from('story_bibles')
    .select('*')
    .eq('story_id', storyId)
    .single();

  // Fetch most recent arc (handles duplicate arcs from recovery retries)
  const { data: arc, error: arcError } = await supabaseAdmin
    .from('story_arcs')
    .select('*')
    .eq('story_id', storyId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!arc || arcError) {
    throw new Error(`No arc found for story ${storyId}: ${arcError?.message || 'arc is null'}`);
  }

  // Fetch reading level and preferences
  const { data: userPrefs } = await supabaseAdmin
    .from('user_preferences')
    .select('reading_level, preferences')
    .eq('user_id', userId)
    .maybeSingle();

  const readingLevel = userPrefs?.reading_level || userPrefs?.preferences?.readingLevel || 'adult';

  // Also fetch age range and beloved stories for backward compatibility
  let ageRange = '25+';
  let belovedStories = [];
  if (story.premise_id) {
    const { data: premiseRecord } = await supabaseAdmin
      .from('story_premises')
      .select('preferences_used')
      .eq('id', story.premise_id)
      .single();

    if (premiseRecord?.preferences_used) {
      const rawAgeRange = premiseRecord.preferences_used.ageRange;
      if (rawAgeRange) {
        ageRange = mapAgeRange(rawAgeRange);
      }
      belovedStories = premiseRecord.preferences_used.belovedStories || [];
    }
  }
  console.log(`📊 Chapter ${chapterNumber} generation - Reading Level: ${readingLevel}, Age Range (compat): ${ageRange}`);

  // Get last 3 chapters for context
  const { data: previousChapters } = await supabaseAdmin
    .from('chapters')
    .select('chapter_number, title, content, metadata')
    .eq('story_id', storyId)
    .lt('chapter_number', chapterNumber)
    .order('chapter_number', { ascending: false })
    .limit(3);

  // Use bible and arc variables already fetched above
  const chapterOutline = arc.chapters.find(ch => ch.chapter_number === chapterNumber);

  if (!chapterOutline) {
    throw new Error(`Chapter ${chapterNumber} not found in arc outline`);
  }

  // If editor brief exists, use the revised outline for this chapter
  let effectiveOutline = chapterOutline;
  let editorNotes = '';
  if (editorBrief && editorBrief.revisedOutlines) {
    const revised = editorBrief.revisedOutlines.find(o => o.chapter_number === chapterNumber);
    if (revised) {
      effectiveOutline = { ...chapterOutline, ...revised }; // Revised fields override originals
      editorNotes = revised.editor_notes || '';
      console.log(`📝 [${storyTitle}] Ch${chapterNumber} using editor-revised outline`);
    }
  }

  // Build context from previous chapters (key_events lives in metadata JSONB, not a direct column)
  const previousContext = previousChapters && previousChapters.length > 0
    ? previousChapters.reverse().map(ch =>
        `Chapter ${ch.chapter_number}: ${ch.title}\nKey events: ${(ch.metadata?.key_events || []).join(', ') || 'N/A'}`
      ).join('\n\n')
    : 'This is the first chapter.';

  // Fetch learned reader preferences (if available and enabled)
  let learnedPreferencesBlock = '';
  if (config.adaptive_preferences !== false) {
    const writingPrefs = await getUserWritingPreferences(userId);

    if (writingPrefs && writingPrefs.stories_analyzed >= 2 && writingPrefs.confidence_score >= 0.5) {
      console.log(`📚 Injecting learned preferences (confidence: ${writingPrefs.confidence_score})`);
      learnedPreferencesBlock = `

<learned_reader_preferences>
  This reader's past feedback shows specific preferences. Incorporate naturally:

  ${writingPrefs.custom_instructions?.map(i => `• ${i}`).join('\n  ') || ''}

  This reader tends to dislike:
  ${writingPrefs.avoid_patterns?.map(p => `• ${p}`).join('\n  ') || ''}

  Pacing preference: ${writingPrefs.preferred_pacing?.summary || 'No data'}
  Dialogue preference: ${writingPrefs.preferred_dialogue_style?.summary || 'No data'}
  Complexity: ${writingPrefs.preferred_complexity?.summary || 'No data'}
</learned_reader_preferences>`;
    }
  } else {
    console.log(`⚙️ [${storyTitle}] Adaptive preferences DISABLED by generation_config`);
  }

  // Build character continuity block from previous ledger entries
  const { buildCharacterContinuityBlock } = require('./character-intelligence');
  const characterContinuityBlock = config.character_ledger !== false
    ? await buildCharacterContinuityBlock(storyId, chapterNumber)
    : '';

  if (config.character_ledger === false) {
    console.log(`⚙️ [${storyTitle}] Character ledger DISABLED by generation_config`);
  }

  // Prepare style example - use editor brief's example if available, otherwise use generic
  const styleExampleContent = editorBrief?.styleExample
    ? `Prose standard to aim for — this example captures the specific tone and voice this story should have going forward:

${editorBrief.styleExample}

Match this tone, rhythm, and emotional register in your chapter.`
    : `Prose standard to aim for:

The door stood open. She didn't remember leaving it that way. Mira pressed her back against the hallway wall and counted to three. The brick bit through her jacket. No sound from inside.

She slipped through. The apartment looked rearranged. Someone had been careful. Couch cushions perfectly straight. Mail on the counter lined up like soldiers. Her breathing went shallow. Whoever did this wanted her to know.

Notice: no em dashes. Short sentences for tension. Physical sensation instead of named emotions. No "not X but Y." Just clean prose that trusts the reader.`;

  const generatePrompt = `You are an award-winning fiction author known for prose that shows instead of tells, vivid character work, and compulsive page-turning narratives.

<CRITICAL_PROSE_RULES>
These rules are NON-NEGOTIABLE. Any chapter that violates them will be rejected and regenerated.

BANNED CONSTRUCTIONS — zero tolerance:

1. EM DASHES: Maximum 3 per chapter. Use periods, commas, or semicolons instead.
2. "NOT X, BUT Y" / "NOT X — Y": Do NOT define anything by what it isn't. Maximum 1 per chapter.
3. "SOMETHING IN [X]": Never write "something in her chest," "something in his voice." Name it or show it.
4. "THE KIND OF X THAT Y": Never write "the kind of silence that meant calculation." Just describe it directly.
5. MICRO-EXPRESSION MIND-READING: When a face does something, do NOT explain what it means. Let readers interpret.
6. BODY-PART EMOTION PALETTE: Do NOT default to throat-tightens, hands-shake, chest-seizes, jaw-tightens for every emotion. Use varied, surprising physical manifestations.
7. ONE-WORD DRAMATIC SENTENCES: Maximum 2 per chapter. ("Silence." "Just that." "Alive.")
8. SIMULTANEOUS DIALOGUE + ACTION: Not every line of dialogue needs physical business. Let some dialogue stand alone.

INSTEAD: Write with restraint. Let readers interpret. Vary sentence structure aggressively. Use specific physical details, not generic body-part emotions. Silence and ambiguity are features.
</CRITICAL_PROSE_RULES>

Write Chapter ${chapterNumber} of "${bible.title}" following this outline and craft rules.

<story_context>
  <protagonist>
    <name>${bible.characters.protagonist.name}</name>
    <age>${bible.characters.protagonist.age}</age>
    <personality>${bible.characters.protagonist.personality}</personality>
    <strengths>${bible.characters.protagonist.strengths?.join(', ') || 'N/A'}</strengths>
    <flaws>${bible.characters.protagonist.flaws?.join(', ') || 'N/A'}</flaws>
    <goals>${bible.characters.protagonist.goals}</goals>
    <fears>${bible.characters.protagonist.fears}</fears>
    <internal_contradiction>${bible.characters.protagonist.internal_contradiction || 'N/A'}</internal_contradiction>
    <lie_they_believe>${bible.characters.protagonist.lie_they_believe || 'N/A'}</lie_they_believe>
    <deepest_fear>${bible.characters.protagonist.deepest_fear || 'N/A'}</deepest_fear>
    <voice_notes>${bible.characters.protagonist.voice_notes || 'N/A'}</voice_notes>
  </protagonist>

  <antagonist>
    <name>${bible.characters.antagonist.name}</name>
    <motivation>${bible.characters.antagonist.motivation}</motivation>
    <methods>${bible.characters.antagonist.methods || 'N/A'}</methods>
    <why_they_believe_theyre_right>${bible.characters.antagonist.why_they_believe_theyre_right || 'N/A'}</why_they_believe_theyre_right>
    <sympathetic_element>${bible.characters.antagonist.sympathetic_element || 'N/A'}</sympathetic_element>
  </antagonist>

  <supporting_characters>
    ${bible.characters.supporting?.map(sc => `<character name="${sc.name}" role="${sc.role}" relationship="${sc.relationship_dynamic || 'N/A'}">${sc.personality}</character>`).join('\n    ') || 'None'}
  </supporting_characters>

  <world_rules>
    ${JSON.stringify(bible.world_rules)}
  </world_rules>

  <central_conflict>${bible.central_conflict.description}</central_conflict>

  <stakes>
    <personal>${bible.stakes.personal}</personal>
    <broader>${bible.stakes.broader || 'N/A'}</broader>
  </stakes>

  <key_locations>
    ${bible.key_locations?.map(loc => `<location name="${loc.name}">${loc.description}</location>`).join('\n    ') || 'None'}
  </key_locations>
</story_context>

<chapter_outline>
  <chapter_number>${chapterNumber}</chapter_number>
  <title>${effectiveOutline.title}</title>
  <events_summary>${effectiveOutline.events_summary}</events_summary>
  <character_focus>${effectiveOutline.character_focus}</character_focus>
  <tension_level>${effectiveOutline.tension_level}</tension_level>
  <word_count_target>${effectiveOutline.word_count_target}</word_count_target>
${editorNotes ? `  <editor_notes>
  These notes from the story editor describe specific beats to include in this chapter.
  Weave them naturally into the scenes — they are part of the chapter plan, not afterthoughts.

  ${editorNotes}
  </editor_notes>` : ''}
</chapter_outline>

<previous_chapters>
${previousContext}
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
${styleExampleContent}
</style_example>

<word_count>
  STRICT REQUIREMENT: This chapter must be between 2500 and 3500 words. Not a guideline—a hard constraint. Count carefully.

  If you approach 3500 words and haven't completed the chapter arc, condense. If you finish the chapter arc before 2500 words, expand scenes with richer detail, more character interiority, or stronger sensory grounding.
</word_count>

<reading_level>
  Reading Level: ${readingLevel}
  Age Range: ${ageRange}
  Beloved Stories: ${belovedStories.join(', ') || 'not specified'}

  CALIBRATE ALL PROSE TO THIS READING LEVEL. Here's what each level means:

  early_reader: Short chapters (800-1200 words). Simple sentences averaging 8-12 words. Concrete vocabulary — show don't tell through action and dialogue, not internal monologue. Think Magic Tree House, Diary of a Wimpy Kid.

  middle_grade: Standard chapters (1500-2500 words). Sentences average 12-16 words with variety. Accessible vocabulary with occasional "stretch" words that context makes clear. Emotions shown through behavior and some internal thought. Think Percy Jackson, early Harry Potter.

  upper_middle_grade: Fuller chapters (2000-3000 words). Sentence variety with some complex structures. Moral ambiguity can be introduced. Internal conflict goes deeper. Think later Harry Potter, Hunger Games, Eragon.

  young_adult: Rich chapters (2500-4000 words). Full sentence complexity. Unreliable narrators OK. Sophisticated vocabulary used naturally. Deep thematic exploration. Think Six of Crows, Throne of Glass.

  new_adult/adult: No prose constraints. Full literary range.

  IMPORTANT: If the reader mentioned specific beloved stories, match THAT prose level, not a generic age-based level. A 12-year-old who loves Hunger Games should get prose closer to Suzanne Collins than to Jeff Kinney.
</reading_level>
${learnedPreferencesBlock}${characterContinuityBlock}

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
      32000,
      { operation: 'generate_chapter', userId, storyId, chapterNumber, regenerationCount, storyTitle }
    );

    await logApiCost(userId, 'generate_chapter', inputTokens, outputTokens, {
      storyId,
      chapterNumber,
      regenerationCount
    });

    const parsed = parseAndValidateJSON(response, ['chapter']);
    chapter = parsed.chapter;

    // Prose violations scan (before quality review)
    const proseScan = scanForProseViolations(chapter.content);
    if (!proseScan.passed) {
      storyLog(storyId, storyTitle, `⚠️ [${storyTitle}] Chapter ${chapterNumber} failed prose scan (attempt ${regenerationCount + 1}/3)`);
      storyLog(storyId, storyTitle, `   Violations: ${proseScan.violations.join(', ')}`);

      if (regenerationCount < 2) {
        regenerationCount++;
        qualityReview = {
          weighted_score: 5.0,
          priority_fixes: proseScan.violations,
          pass: false,
          criteria_scores: {
            prose_quality: {
              score: 3,
              weight: 0.25,
              quotes: proseScan.violations,
              fix: `CRITICAL PROSE VIOLATIONS: ${proseScan.violations.join('; ')}. Rewrite to eliminate these patterns completely.`
            }
          }
        };
        continue; // Retry generation
      } else {
        storyLog(storyId, storyTitle, `⚠️ [${storyTitle}] Chapter ${chapterNumber} still has prose violations after 3 attempts. Proceeding to quality review.`);
      }
    }

    // Quality review pass
    const reviewPrompt = `You are an expert editor for fiction with deep knowledge of show-don't-tell craft, dialogue quality, and prose technique.

Review this chapter against the same writing craft standards it was supposed to follow.

<chapter_to_review>
${JSON.stringify(chapter, null, 2)}
</chapter_to_review>

<story_context>
Target Age: ${ageRange} years
Genre: ${bible.themes.join(', ')}
Protagonist: ${bible.characters.protagonist.name}
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

1. SHOW DON'T TELL (Weight: 15%)
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

5. CHARACTER CONSISTENCY (Weight: 5%)
   - Do character decisions flow from established traits, fears, goals?
   - Any out-of-character moments?
   - Does this chapter develop the character arc?

6. PROSE QUALITY (Weight: 25%)
   - Clean writing free of AI tells ("not X but Y", rhetorical questions, etc.)?
   - Count em dashes (>3 = score ≤5)
   - Count "Not X but Y" constructions (>1 = score ≤6)
   - Count "something in" constructions (>1 = score ≤5)
   - Count "the kind of" constructions (>1 = score ≤6)
   - Check for repeated body-part emotions (jaw-tightens, hands-shake, throat-tightens)
   - Check if micro-expressions are interpreted rather than left ambiguous
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
        "weight": 0.15,
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
        "weight": 0.05,
        "quotes": ["quote1", "quote2"],
        "fix": "actionable fix or empty"
      },
      "prose_quality": {
        "score": number (1-10),
        "weight": 0.25,
        "quotes": ["quote1", "quote2"],
        "fix": "actionable fix or empty"
      }
    },
    "top_strengths": ["strength1 (specific)", "strength2", "strength3"],
    "priority_fixes": ["fix1 (most important)", "fix2", "fix3"],
    "pass": true/false (pass if weighted_score >= 7.5)
  }
}`;

    const reviewMessages = [{ role: 'user', content: reviewPrompt }];

    const { response: reviewResponse, inputTokens: reviewInputTokens, outputTokens: reviewOutputTokens } = await callClaudeWithRetry(
      reviewMessages,
      32000,
      { operation: 'quality_review', userId, storyId, chapterNumber, regenerationCount, storyTitle }
    );

    await logApiCost(userId, 'quality_review', reviewInputTokens, reviewOutputTokens, {
      storyId,
      chapterNumber,
      regenerationCount
    });

    const reviewParsed = parseAndValidateJSON(reviewResponse, ['quality_review']);
    qualityReview = reviewParsed.quality_review;

    // Use weighted_score with new 7.5 threshold
    const scoreToCheck = qualityReview.weighted_score !== undefined ? qualityReview.weighted_score : qualityReview.score;
    if (scoreToCheck >= 7.5) {
      passedQuality = true;
    } else {
      regenerationCount++;
      console.log(`Chapter ${chapterNumber} quality score: ${scoreToCheck.toFixed(2)}. Regenerating (attempt ${regenerationCount}/2)...`);
    }
  }

  // Store chapter in database
  const finalScore = qualityReview.weighted_score !== undefined ? qualityReview.weighted_score : qualityReview.score;
  const { data: storedChapter, error: chapterError } = await supabaseAdmin
    .from('chapters')
    .insert({
      story_id: storyId,
      arc_id: arc.id,  // REQUIRED: Link to parent arc
      chapter_number: chapterNumber,
      title: chapter.title,
      content: chapter.content,
      word_count: chapter.word_count,
      quality_score: Math.round(finalScore * 10) / 10,  // Store with 1 decimal place
      quality_review: qualityReview,
      quality_pass_completed: true,
      regeneration_count: regenerationCount,
      metadata: {
        opening_hook: chapter.opening_hook,
        closing_hook: chapter.closing_hook,
        key_events: chapter.key_events,
        character_development: chapter.character_development
      }
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
    current_step: `generating_chapter_${chapterNumber}_postprocessing`
  });

  // Extract character ledger (wait for completion to ensure intra-batch continuity)
  const { extractCharacterLedger, reviewCharacterVoices, applyVoiceRevisions } = require('./character-intelligence');
  if (config.character_ledger !== false) {
    try {
      await extractCharacterLedger(storyId, chapterNumber, chapter.content, userId);
      storyLog(storyId, storyTitle, `📚 [${storyTitle}] Character ledger extracted for chapter ${chapterNumber}`);
    } catch (err) {
      storyLog(storyId, storyTitle, `⚠️ [${storyTitle}] Character ledger extraction failed for chapter ${chapterNumber}: ${err.message}`);
    }
  } else {
    console.log(`⚙️ [${storyTitle}] Skipping ledger extraction (character_ledger disabled)`);
  }

  // Entity validation (check consistency against story bible + prior chapters)
  if (config.entity_validation !== false) {
    try {
      const { validateChapter } = require('./chapter-validation');
      const validationResult = await validateChapter(storyId, storedChapter.id, chapterNumber, storedChapter.content, bible, userId);
      storyLog(storyId, storyTitle, `🔍 [${storyTitle}] Entity validation for chapter ${chapterNumber}: severity=${validationResult.severity}${validationResult.wasRevised ? ' (surgically revised)' : ''}`);
      if (validationResult.revisedContent) {
        storedChapter.content = validationResult.revisedContent;
      }
    } catch (err) {
      storyLog(storyId, storyTitle, `⚠️ [${storyTitle}] Entity validation failed for chapter ${chapterNumber}: ${err.message}`);
    }
  } else {
    console.log(`⚙️ [${storyTitle}] Skipping entity validation (entity_validation disabled)`);
  }

  // Character voice review (Sonnet pass — checks character authenticity against ledger)
  if (config.voice_review !== false) {
    try {
      const voiceReview = await reviewCharacterVoices(storyId, chapterNumber, chapter.content, userId);
      if (voiceReview) {
        storyLog(storyId, storyTitle, `🎭 [${storyTitle}] Voice review complete for chapter ${chapterNumber} (${voiceReview.voice_checks?.length || 0} characters reviewed)`);

        // Check if revision is needed
        const revisedContent = await applyVoiceRevisions(storyId, chapterNumber, chapter.content, voiceReview, userId);
        if (revisedContent) {
          storyLog(storyId, storyTitle, `🎭 [${storyTitle}] Voice revision applied to chapter ${chapterNumber}`);
          // Update the storedChapter reference with new content
          storedChapter.content = revisedContent;
        }
      }
    } catch (err) {
      storyLog(storyId, storyTitle, `⚠️ [${storyTitle}] Voice review failed for chapter ${chapterNumber}: ${err.message}`);
    }
  } else {
    console.log(`⚙️ [${storyTitle}] Skipping voice review (voice_review disabled)`);
  }

  return storedChapter;
}

/**
 * Orchestrate complete pre-generation: Bible -> Arc -> Chapters 1-3 (initial batch)
 * (Chapters 4-6, 7-9, and 10-12 are generated based on reader feedback after checkpoints)
 */
async function orchestratePreGeneration(storyId, userId) {
  const pipelineStartTime = Date.now();
  let storyTitle = 'Unknown';

  try {
    // Step 1: Check current progress to determine where to resume
    const { data: story } = await supabaseAdmin
      .from('stories')
      .select('title, generation_progress, bible_id, current_arc_id')
      .eq('id', storyId)
      .single();

    if (!story) {
      throw new Error('Story not found');
    }

    storyTitle = story.title || 'Unknown';
    const progress = story.generation_progress || {};
    const chaptersAlreadyGenerated = progress.chapters_generated || 0;
    const arcComplete = !!progress.arc_complete;
    const bibleComplete = !!progress.bible_complete;

    storyLog(storyId, storyTitle, `📖 [${storyTitle}] Pipeline started (chapters=${chaptersAlreadyGenerated}/3, arc=${arcComplete}, bible=${bibleComplete})`);

    // Verify bible exists
    const { data: bible } = await supabaseAdmin
      .from('story_bibles')
      .select('*')
      .eq('story_id', storyId)
      .single();

    if (!bible) {
      throw new Error('Bible not found');
    }

    // Step 1.5: Generate cover image in background (non-blocking)
    // Runs in parallel with arc/chapter generation
    const { generateBookCover } = require('./cover-generation');

    // Fetch reader's name and confirmation status from preferences
    const { data: userPrefsData } = await supabaseAdmin
      .from('user_preferences')
      .select('preferences, name_confirmed')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    const authorName = userPrefsData?.preferences?.name || 'Reader';
    const nameConfirmed = userPrefsData?.name_confirmed || false;

    // Fetch story details for cover generation
    const { data: storyData } = await supabaseAdmin
      .from('stories')
      .select('title, genre, cover_image_url')
      .eq('id', storyId)
      .single();

    // Only generate cover if:
    // 1. It doesn't already exist (prevents regeneration on recovery)
    // 2. Name has been confirmed (ensures correct author name on cover)
    if (!storyData?.cover_image_url) {
      if (nameConfirmed) {
        storyLog(storyId, storyTitle, `🎨 [${storyTitle}] Cover: generating in background...`);
        generateBookCover(storyId, {
          title: storyData?.title || bible.title,
          genre: storyData?.genre || 'fiction',
          bible: bible  // Pass the entire bible for unique cover generation
        }, authorName).then(url => {
          storyLog(storyId, storyTitle, `🎨 [${storyTitle}] Cover: uploaded ✅`);
        }).catch(err => {
          storyLog(storyId, storyTitle, `⚠️ [${storyTitle}] Cover generation failed (non-blocking): ${err.message}`);
          reportToPeggy({
            source: 'generation:cover',
            category: 'generation',
            severity: 'medium',
            errorMessage: `Cover generation failed: ${err.message}`,
            stackTrace: err.stack,
            storyId,
            storyTitle
          }).catch(() => {});
        });
      } else {
        console.log(`📖 [${storyTitle}] Skipping cover generation — name not yet confirmed`);
      }
    } else {
      console.log(`🎨 [${storyTitle}] Cover: already exists, skipping`);
    }

    // Step 2: Generate Arc (skip if already complete)
    if (!arcComplete) {
      await updateGenerationProgress(storyId, {
        bible_complete: true,
        arc_complete: false,
        chapters_generated: 0,
        current_step: 'generating_arc'
      });

      storyLog(storyId, storyTitle, `📖 [${storyTitle}] Arc: starting generation...`);
      const arcResult = await retryGenerationStep('Arc generation', storyId, storyTitle, async () => {
        return await generateArcOutline(storyId, userId);
      });

      const chapterCount = arcResult?.outline?.length || 6;
      storyLog(storyId, storyTitle, `📖 [${storyTitle}] Arc: complete ✅ (${chapterCount} chapters outlined)`);
    } else {
      storyLog(storyId, storyTitle, `📖 [${storyTitle}] Arc: already exists, skipping`);
    }

    // Step 3: Generate Chapters (resume from where we left off)
    for (let i = chaptersAlreadyGenerated + 1; i <= 3; i++) {
      await updateGenerationProgress(storyId, {
        bible_complete: true,
        arc_complete: true,
        chapters_generated: i - 1,
        current_step: `generating_chapter_${i}`
      });

      storyLog(storyId, storyTitle, `📖 [${storyTitle}] Chapter ${i}/3: starting generation...`);
      const chapterStartTime = Date.now();

      const chapter = await retryGenerationStep(`Chapter ${i} generation`, storyId, storyTitle, async () => {
        return await generateChapter(storyId, i, userId);
      });

      const chapterDuration = ((Date.now() - chapterStartTime) / 1000).toFixed(1);
      const charCount = chapter?.content?.length || 0;
      storyLog(storyId, storyTitle, `📖 [${storyTitle}] Chapter ${i}/3: saved ✅ (${charCount.toLocaleString()} chars, ${chapterDuration}s)`);

      // 1-second pause between chapters to avoid rate limits
      if (i < 3) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Mark story as active (with 3 chapters ready)
    await supabaseAdmin
      .from('stories')
      .update({
        status: 'active',
        generation_progress: {
          bible_complete: true,
          arc_complete: true,
          chapters_generated: 3,
          current_step: 'awaiting_chapter_2_feedback',
          last_updated: new Date().toISOString()
        }
      })
      .eq('id', storyId);

    // Clear recovery lock on success
    await clearRecoveryLock(storyId);

    const pipelineDuration = ((Date.now() - pipelineStartTime) / 1000).toFixed(1);
    storyLog(storyId, storyTitle, `📖 [${storyTitle}] Pipeline complete! All chapters generated (${pipelineDuration}s total)`);
    clearStoryLogs(storyId); // Success — free the buffer
  } catch (error) {
    storyLog(storyId, storyTitle, `❌ [${storyTitle}] Pipeline failed: ${error.message}`);

    // Peggy: Report pipeline-level failures
    reportToPeggy({
      source: 'generation:pipeline',
      category: 'generation',
      severity: 'critical',
      errorMessage: `Pipeline failed: ${error.message}`,
      stackTrace: error.stack,
      storyId,
      storyTitle,
      context: { pipeline_duration_s: ((Date.now() - pipelineStartTime) / 1000).toFixed(1) }
    }).catch(() => {});

    // Error handling is now in retryGenerationStep, but catch any other errors
    // Update story with error status if not already set
    const { data: currentStory } = await supabaseAdmin
      .from('stories')
      .select('status, generation_progress')
      .eq('id', storyId)
      .single();

    if (currentStory?.status !== 'error') {
      const progress = currentStory?.generation_progress || {};
      await supabaseAdmin
        .from('stories')
        .update({
          status: 'error',
          error_message: error.message,
          generation_progress: {
            ...progress,
            last_error: error.message,
            last_error_at: new Date().toISOString(),
            current_step: 'generation_failed',
            error_logs: getStoryLogs(storyId)
          }
        })
        .eq('id', storyId);
    }

    // Clear recovery lock on final failure
    await clearRecoveryLock(storyId);

    throw error;
  }
}

/**
 * Extract book context for sequel generation
 * Analyzes final chapters to understand character states, world changes, etc.
 */
async function extractBookContext(storyId, userId) {
  console.log(`📊 Extracting context from Book ${storyId} for sequel generation...`);

  // Get final chapters (10-12) to understand ending state
  const { data: finalChapters, error: chaptersError } = await supabaseAdmin
    .from('chapters')
    .select('*')
    .eq('story_id', storyId)
    .gte('chapter_number', 10)
    .lte('chapter_number', 12)
    .order('chapter_number', { ascending: true });

  if (chaptersError || !finalChapters || finalChapters.length === 0) {
    throw new Error(`Failed to fetch final chapters: ${chaptersError?.message || 'No chapters found'}`);
  }

  // Get the bible for character info
  const { data: bible, error: bibleError } = await supabaseAdmin
    .from('story_bibles')
    .select('*')
    .eq('story_id', storyId)
    .single();

  if (bibleError || !bible) {
    throw new Error(`Failed to fetch bible: ${bibleError?.message}`);
  }

  // Use Claude to analyze the ending
  const analysisPrompt = `You are analyzing the final chapters of a children's book to extract context for generating a sequel.

BOOK BIBLE (Original Setup):
${JSON.stringify(bible, null, 2)}

FINAL CHAPTERS (10-12):
${finalChapters.map(ch => `
CHAPTER ${ch.chapter_number}: ${ch.title}
${ch.content}
`).join('\n\n')}

TASK: Extract structured data about how this book ended:

1. CHARACTER STATES:
   - How has the protagonist grown/changed from the beginning?
   - What new skills/abilities did they gain?
   - What's their emotional state at story's end?
   - Where are they physically/emotionally?
   - How have supporting characters evolved?

2. RELATIONSHIPS:
   - What friendships/bonds were formed or strengthened?
   - How did key relationships evolve?
   - Any new mentors, allies, or rivals?

3. ACCOMPLISHMENTS:
   - What major challenges were overcome?
   - What was achieved/resolved?
   - What victories did the protagonist earn?

4. WORLD STATE:
   - How did the world change from the beginning?
   - What's different about their community/location?
   - Any new magical/technological/social changes?

5. KEY EVENTS (for future reference):
   - List 3-5 major events that a sequel might reference
   - Format: "The Battle of [Place]", "Discovery of [Thing]"

6. LOOSE THREADS:
   - Any unresolved mysteries?
   - Hints at future adventures?
   - Characters or plot points left open?

Return ONLY a JSON object:
{
  "character_states": {
    "protagonist": {
      "growth": "brief summary of character arc",
      "skills_gained": ["skill1", "skill2"],
      "emotional_state": "description",
      "current_location": "where they are",
      "confidence_level": "description"
    },
    "supporting": [
      {
        "name": "character name",
        "relationship": "relationship to protagonist",
        "status": "where they ended up"
      }
    ]
  },
  "relationships": {
    "protagonist + character": "nature of relationship"
  },
  "accomplishments": ["accomplishment1", "accomplishment2"],
  "world_state": ["change1", "change2"],
  "key_events": ["event1", "event2"],
  "loose_threads": ["thread1", "thread2"]
}`;

  const { response: contextJson, inputTokens, outputTokens } = await callClaudeWithRetry(
    [{ role: 'user', content: analysisPrompt }],
    32000
  );

  await logApiCost(userId, 'extract_book_context', inputTokens, outputTokens, {
    storyId
  });

  const context = parseAndValidateJSON(contextJson, [
    'character_states',
    'relationships',
    'accomplishments',
    'world_state',
    'key_events'
  ]);

  console.log(`✅ Extracted context:`, JSON.stringify(context, null, 2).substring(0, 500));

  return context;
}

/**
 * Generate sequel bible with continuity from Book 1
 */
async function generateSequelBible(book1StoryId, userPreferences, userId) {
  console.log(`📚 Generating sequel bible for story ${book1StoryId}...`);

  // Get Book 1 bible
  const { data: book1Bible, error: bibleError } = await supabaseAdmin
    .from('story_bibles')
    .select('*')
    .eq('story_id', book1StoryId)
    .single();

  if (bibleError || !book1Bible) {
    throw new Error(`Failed to fetch Book 1 bible: ${bibleError?.message}`);
  }

  // Get Book 1 context from series_context table (should have been stored)
  const { data: book1Story } = await supabaseAdmin
    .from('stories')
    .select('series_id, book_number, premise_id')
    .eq('id', book1StoryId)
    .single();

  let book1Context;
  const { data: storedContext } = await supabaseAdmin
    .from('story_series_context')
    .select('*')
    .eq('series_id', book1Story.series_id)
    .eq('book_number', book1Story.book_number)
    .single();

  if (storedContext) {
    book1Context = {
      character_states: storedContext.character_states,
      relationships: storedContext.relationships,
      accomplishments: storedContext.accomplishments,
      world_state: storedContext.world_state,
      key_events: storedContext.key_events
    };
  } else {
    // Extract if not stored
    book1Context = await extractBookContext(book1StoryId, userId);
  }

  // Fetch age range from Book 1's preferences
  let ageRange = '25+'; // default to adult
  if (book1Story.premise_id) {
    const { data: premiseRecord } = await supabaseAdmin
      .from('story_premises')
      .select('preferences_used')
      .eq('id', book1Story.premise_id)
      .single();

    if (premiseRecord?.preferences_used?.ageRange) {
      const rawAgeRange = premiseRecord.preferences_used.ageRange;
      ageRange = mapAgeRange(rawAgeRange);
      console.log(`📊 Sequel bible generation - Age Range: ${rawAgeRange} → ${ageRange}`);
    }
  }

  // Generate Book 2 bible with strong continuity
  const sequelPrompt = `You are creating BOOK 2 in a series for ages ${ageRange}.

CRITICAL: This is a SEQUEL. You must preserve continuity.

═══════════════════════════════════════════════════════
BOOK 1 FOUNDATION (MUST HONOR):
═══════════════════════════════════════════════════════

TITLE: "${book1Bible.title}"
GENRE: ${book1Bible.content.characters.protagonist.name}'s adventures - ${JSON.stringify(book1Bible.themes)} ← SAME GENRE/THEMES REQUIRED

PROTAGONIST (as they ENDED Book 1):
Name: ${book1Bible.content.characters.protagonist.name}
Age: ${book1Bible.content.characters.protagonist.age}
Growth in Book 1: ${book1Context.character_states.protagonist.growth}
Skills Gained: ${book1Context.character_states.protagonist.skills_gained.join(', ')}
Emotional State: ${book1Context.character_states.protagonist.emotional_state}
Current Location: ${book1Context.character_states.protagonist.current_location}

⚠️ Book 2 protagonist MUST:
- Be the SAME character
- START more capable than Book 1 beginning (they've grown!)
- RETAIN all skills/growth from Book 1
- Remember and reference Book 1 events naturally

WORLD RULES (MUST PRESERVE):
${JSON.stringify(book1Bible.world_rules, null, 2)}

World Changes from Book 1:
${book1Context.world_state.join('\n- ')}

RELATIONSHIPS ESTABLISHED:
${JSON.stringify(book1Context.relationships, null, 2)}

BOOK 1 ACCOMPLISHMENTS:
${book1Context.accomplishments.join('\n- ')}

KEY EVENTS FROM BOOK 1:
${book1Context.key_events.join('\n- ')}

═══════════════════════════════════════════════════════
READER'S PREFERENCES FOR BOOK 2:
═══════════════════════════════════════════════════════

${userPreferences ? JSON.stringify(userPreferences, null, 2) : 'Continue the adventure naturally'}

═══════════════════════════════════════════════════════
BOOK 2 REQUIREMENTS:
═══════════════════════════════════════════════════════

Create a NEW adventure that:

1. CONTINUITY:
   - Takes place 3-6 months after Book 1
   - Character is MORE experienced than Book 1 start
   - References Book 1 events naturally
   - Relationships continue/evolve
   - World reflects Book 1 changes

2. NEW CONFLICT:
   - DIFFERENT type than Book 1 main conflict
   - Bigger stakes (protagonist more capable)
   - Requires NEW skills (not just Book 1 skills)
   - Introduces new locations while honoring established ones

3. EVOLVED THEMES — Each theme MUST evolve from Book 1. Show how the sequel explores a NEW dimension or complication of the same core theme. Do NOT copy Book 1 theme descriptions verbatim. The theme's essence stays, but the lens changes.
4. AGE-APPROPRIATE: ${ageRange} years old
5. INCORPORATE reader preferences where appropriate

CRITICAL FORMAT INSTRUCTIONS:
- Return ONLY valid JSON — no markdown, no code blocks, no commentary
- Keep values CONCISE — 1-3 sentences per field, not paragraphs
- Supporting characters: MAX 4 entries
- Key locations: MAX 5 entries
- Do NOT duplicate Book 1 world_rules verbatim — summarize changes/additions only

Return Book 2 Bible in this EXACT format:
{
  "title": "A standalone creative title for Book 2 — NOT a subtitle, NOT 'Book 2 of...', just a strong title like Book 1 had",
  "world_rules": {
    "magic_system": "brief summary of magic rules (1-2 sentences)",
    "technology_level": "brief (1 sentence)",
    "social_structure": "brief (1 sentence)",
    "key_rules": ["rule 1", "rule 2", "rule 3"],
    "changes_from_book1": "what changed in the world since Book 1 (1-2 sentences)"
  },
  "characters": {
    "protagonist": {
      "name": "${book1Bible.content.characters.protagonist.name}",
      "age": ${book1Bible.content.characters.protagonist.age + 1},
      "personality": "1-2 sentences",
      "strengths": ["strength 1", "strength 2", "strength 3"],
      "flaws": ["flaw 1", "flaw 2"],
      "goals": "1 sentence",
      "fears": "1 sentence"
    },
    "antagonist": {
      "name": "name",
      "role": "1 sentence",
      "motivation": "1 sentence",
      "connection_to_book1": "1 sentence"
    },
    "supporting": [
      {"name": "name", "role": "1 sentence", "arc": "1 sentence"}
    ]
  },
  "central_conflict": {
    "description": "2-3 sentences",
    "connection_to_book1": "1 sentence",
    "escalation": "1 sentence"
  },
  "stakes": {
    "personal": "1 sentence",
    "world": "1 sentence"
  },
  "themes": ["EVOLVE theme 1 from Book 1 — same core idea, new angle/complication", "EVOLVE theme 2...", "etc — one evolved entry per Book 1 theme: ${book1Bible.themes.map(t => typeof t === 'string' ? t.substring(0, 40) : JSON.stringify(t).substring(0, 40)).join('; ')}"],
  "key_locations": [
    {"name": "location", "description": "1 sentence", "new_or_returning": "new/returning"}
  ],
  "timeline": {
    "time_after_book1": "e.g. 3 months later",
    "duration": "e.g. spans 2 weeks",
    "season": "e.g. early winter"
  }
}`;

  const { response: bibleJson, inputTokens, outputTokens } = await callClaudeWithRetry(
    [{ role: 'user', content: sequelPrompt }],
    8000  // Reduced from 32000 — constrained format keeps response compact, prevents JSON corruption on long outputs
  );

  await logApiCost(userId, 'generate_sequel_bible', inputTokens, outputTokens, {
    parentStoryId: book1StoryId
  });

  const parsed = parseAndValidateJSON(bibleJson, [
    'title',
    'world_rules',
    'characters',
    'central_conflict',
    'stakes',
    'themes',
    'key_locations',
    'timeline'
  ]);

  console.log(`✅ Generated sequel bible: "${parsed.title}"`);

  return parsed;
}

/**
 * Generate a creative AI series name for a book series
 * @param {string} bookTitle - Title of the first book in the series
 * @param {string} genre - Genre of the series
 * @returns {Promise<string>} - The generated series name
 */
async function generateSeriesName(bookTitle, genre, bible) {
  const themesSummary = Array.isArray(bible?.themes)
    ? bible.themes.slice(0, 3).map(t => typeof t === 'string' ? t.split('—')[0].trim() : t).join(', ')
    : 'unknown';

  const conflictSummary = bible?.central_conflict?.description
    ? bible.central_conflict.description.substring(0, 200)
    : '';

  const antagonist = bible?.characters?.antagonist?.name || '';

  const prompt = `You are naming a BOOK SERIES. Here is what you know about Book 1:

Title: "${bookTitle}"
Genre: ${genre || 'fiction'}
Core Themes: ${themesSummary}
Central Conflict: ${conflictSummary}
Antagonist: ${antagonist}

Generate a creative, evocative series name that:
- Captures the overarching world, mood, or thematic arc of the series
- Works as a label above multiple book titles (like "The Lord of the Rings" or "A Song of Ice and Fire")
- Is 3-6 words
- Does NOT repeat the book title or character names
- Does NOT include the word "Series" (the UI adds that)
- Feels like a real published book series name
- Matches the genre/tone (literary fiction gets elegant names, fantasy gets evocative names, comedy gets punchy names, etc.)

Return ONLY the series name, nothing else. No quotes, no explanation.`;

  const { response } = await callClaudeWithRetry(
    [{ role: 'user', content: prompt }],
    100
  );

  return response.trim().replace(/^["']|["']$/g, ''); // Strip any quotes
}

/**
 * Determine if an error message indicates a transient (infrastructure) failure
 * vs a code bug. Transient errors will resolve on their own — keep retrying.
 * Code bugs won't fix themselves — circuit breaker should trip.
 */
function isTransientError(errorMessage) {
  if (!errorMessage) return false;
  const transientPatterns = [
    /overloaded/i,
    /529/,
    /503/,
    /rate.?limit/i,
    /too many requests/i,
    /ETIMEDOUT/i,
    /ECONNRESET/i,
    /ECONNREFUSED/i,
    /socket hang up/i,
    /network/i,
    /timeout/i,
    /temporarily unavailable/i,
    /service unavailable/i,
    /capacity/i
  ];
  return transientPatterns.some(pattern => pattern.test(errorMessage));
}

/**
 * Self-healing health check: Resume stalled story generations
 * Runs on server startup and every 30 minutes thereafter
 *
 * Retry strategy:
 * - Transient errors (529, 503, timeouts): unlimited retries on 5-min intervals.
 *   These are infrastructure issues that resolve on their own.
 * - Code errors (400, parse failures, constraint violations): max 2 retries then
 *   circuit breaker trips. These won't fix themselves.
 */
async function resumeStalledGenerations() {
  console.log('\n🏥 Health check running...');

  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  try {
    // Query 1: Stalled stories (active but not updated recently)
    const { data: stalledStories, error: stalledError } = await supabaseAdmin
      .from('stories')
      .select('id, user_id, title, generation_progress, status')
      .eq('status', 'active')
      .not('generation_progress', 'is', null);

    // Query 2: Failed stories eligible for retry
    const { data: failedStories, error: failedError } = await supabaseAdmin
      .from('stories')
      .select('id, user_id, title, generation_progress, status')
      .eq('status', 'error')
      .not('generation_progress', 'is', null);

    // Query 3: Fix orphaned chapter_X_complete states (from before realtime push migration)
    const { data: orphanedStories, error: orphanedError } = await supabaseAdmin
      .from('stories')
      .select('id, title, generation_progress')
      .eq('status', 'active')
      .filter('generation_progress->>current_step', 'like', 'chapter_%_complete');

    if (orphanedStories && orphanedStories.length > 0) {
      console.log(`🏥 Fixing ${orphanedStories.length} orphaned chapter_X_complete states`);
      for (const story of orphanedStories) {
        const step = story.generation_progress?.current_step;
        const chaptersGenerated = story.generation_progress?.chapters_generated || 0;

        // Determine correct awaiting state based on chapters generated
        let correctStep;
        if (chaptersGenerated <= 3) correctStep = 'awaiting_chapter_2_feedback';
        else if (chaptersGenerated <= 6) correctStep = 'awaiting_chapter_5_feedback';
        else if (chaptersGenerated <= 9) correctStep = 'awaiting_chapter_8_feedback';
        else correctStep = 'chapter_12_complete';

        console.log(`🏥 Fixing orphaned state: "${story.title}" ${step} → ${correctStep}`);

        await supabaseAdmin
          .from('stories')
          .update({
            generation_progress: {
              ...story.generation_progress,
              current_step: correctStep,
              last_updated: new Date().toISOString()
            }
          })
          .eq('id', story.id);
      }
    }

    // Combine both sets
    const allStories = [
      ...(stalledStories || []),
      ...(failedStories || [])
    ];

    // Filter to stories that actually need recovery
    const needsRecovery = allStories.filter(story => {
      const progress = story.generation_progress;
      if (!progress) return false;

      // CONCURRENCY LOCK: Skip if recovery already in progress
      // (recovery_started within last 20 minutes)
      if (progress.recovery_started) {
        const recoveryStartTime = new Date(progress.recovery_started);
        const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
        if (recoveryStartTime > twentyMinutesAgo) {
          return false; // Recovery already in progress, don't spawn duplicate
        }
      }

      // Check retry limits — transient errors get unlimited retries, code errors max 2
      const healthCheckRetries = progress.health_check_retries || 0;
      const lastError = progress.last_error || '';
      const transient = isTransientError(lastError);

      if (!transient && healthCheckRetries >= 2) {
        return false; // Code error: give up after 2 retries (won't fix itself)
      }
      // Transient errors (529, timeout, etc): always eligible for retry — they'll resolve

      // For stalled active stories: must be older than 10 minutes
      if (story.status === 'active') {
        const lastUpdated = new Date(progress.last_updated);
        const isStalled = lastUpdated < new Date(tenMinutesAgo);

        // Steps that indicate active generation or a mid-pipeline stall.
        // We must catch ALL steps where the pipeline stopped and needs recovery,
        // not just `generating_*`. Transitional steps like `bible_created` and
        // `arc_created` mean the pipeline crashed between completing one phase
        // and starting the next. Failed steps like `bible_generation_failed`
        // mean an error occurred but status wasn't set to 'error'.
        const step = progress.current_step || '';
        const needsRecoveryStep =
          step.startsWith('generating_') ||      // Active generation (bible, arc, chapters, postprocessing)
          step === 'bible_created' ||             // Bible done, arc never started
          step === 'arc_created' ||               // Arc done, chapters never started
          step === 'bible_generation_failed' ||   // Bible failed, status still 'active'
          step === 'generation_failed';           // Generic failure, status still 'active'

        return isStalled && needsRecoveryStep;
      }

      // For error'd stories: always eligible (up to retry limit)
      if (story.status === 'error') {
        return true;
      }

      return false;
    });

    if (needsRecovery.length === 0) {
      console.log('🏥 All clear — no stalled generations');
      return;
    }

    const stalledCount = needsRecovery.filter(s => s.status === 'active').length;
    const failedCount = needsRecovery.filter(s => s.status === 'error').length;
    console.log(`🏥 Found ${stalledCount} stalled stories, ${failedCount} failed stories`);

    for (const story of needsRecovery) {
      const progress = story.generation_progress;
      const currentStep = progress.current_step || 'unknown';
      const chaptersGenerated = progress.chapters_generated || 0;
      const healthCheckRetries = progress.health_check_retries || 0;
      const lastError = progress.last_error;

      // Calculate stall duration
      const lastUpdated = new Date(progress.last_updated || story.created_at);
      const stallMinutes = Math.round((Date.now() - lastUpdated.getTime()) / (1000 * 60));

      // CIRCUIT BREAKER: Distinguish transient errors from code bugs
      const transient = isTransientError(lastError);

      if (!transient && healthCheckRetries >= 2) {
        // CODE ERROR: Won't fix itself. Stop retrying and report.
        storyLog(story.id, story.title, `🛑 [${story.title}] Code error — max recovery attempts reached (${healthCheckRetries}). Giving up.`);
        await supabaseAdmin
          .from('stories')
          .update({
            status: 'error',
            error_message: `Generation failed permanently after ${healthCheckRetries} recovery attempts. Last error: ${lastError || 'unknown'}. Needs manual investigation.`,
            generation_progress: {
              ...progress,
              current_step: 'permanently_failed',
              permanently_failed_at: new Date().toISOString(),
              error_logs: getStoryLogs(story.id)
            }
          })
          .eq('id', story.id);

        // Peggy: Report permanently failed stories
        reportToPeggy({
          source: 'health-check:max-retries',
          category: 'generation',
          severity: 'critical',
          errorMessage: `Story permanently failed after ${healthCheckRetries} recovery attempts (code error). Last error: ${lastError || 'unknown'}`,
          storyId: story.id,
          storyTitle: story.title,
          affectedUserId: story.user_id,
          context: { current_step: currentStep, chapters_generated: chaptersGenerated, stall_minutes: stallMinutes }
        }).catch(() => {});

        continue; // Skip this story, DO NOT retry
      }

      // TRANSIENT ERROR: Infrastructure issue (529, timeout, etc). Keep trying.
      if (transient && healthCheckRetries >= 2) {
        console.log(`🏥 [${story.title}] Transient error (${lastError.substring(0, 80)}), retry #${healthCheckRetries + 1} — will keep trying until resolved`);
      }

      const retryLabel = transient
        ? `transient retry #${healthCheckRetries + 1} (no limit)`
        : `attempt ${healthCheckRetries + 1}/2`;
      console.log(`🏥 Recovering: [${story.title}] (stuck at: ${currentStep}, stalled for ${stallMinutes}m, ${retryLabel})`);

      try {
        // Increment health check retry counter and set recovery lock
        const updatedProgress = {
          ...progress,
          health_check_retries: healthCheckRetries + 1,
          last_health_check: new Date().toISOString(),
          last_recovery_attempt: new Date().toISOString(),
          recovery_started: new Date().toISOString()  // CONCURRENCY LOCK
        };

        // Reset story to active status for retry
        await supabaseAdmin
          .from('stories')
          .update({
            status: 'active',
            error_message: null,
            generation_progress: updatedProgress
          })
          .eq('id', story.id);

        // STATE DRIFT CHECK: Before attempting any recovery, verify that the actual
        // database state matches what generation_progress claims. If all expected chapters
        // exist but the progress tracker is stuck (e.g. "generating_chapter_10" when ch10
        // already exists), just correct the state instead of regenerating.
        const { data: actualChapters } = await supabaseAdmin
          .from('chapters')
          .select('chapter_number')
          .eq('story_id', story.id)
          .order('chapter_number', { ascending: true });

        const actualChapterCount = actualChapters?.length || 0;

        if (actualChapterCount > chaptersGenerated) {
          console.log(`🏥 [${story.title}] State drift detected: progress says ${chaptersGenerated} chapters, DB has ${actualChapterCount}`);

          // Determine the correct state based on actual chapter count
          let correctStep;
          if (actualChapterCount >= 12) {
            correctStep = 'completed';
          } else if (actualChapterCount >= 9) {
            correctStep = 'awaiting_chapter_8_feedback';
          } else if (actualChapterCount >= 6) {
            correctStep = 'awaiting_chapter_5_feedback';
          } else if (actualChapterCount >= 3) {
            correctStep = 'awaiting_chapter_2_feedback';
          } else {
            correctStep = `generating_chapter_${actualChapterCount + 1}`;
          }

          console.log(`🏥 [${story.title}] Correcting state: ${currentStep} → ${correctStep} (${actualChapterCount} chapters in DB)`);

          await supabaseAdmin
            .from('stories')
            .update({
              status: 'active',
              error_message: null,
              generation_progress: {
                ...updatedProgress,
                current_step: correctStep,
                chapters_generated: actualChapterCount,
                health_check_retries: 0, // Reset — this wasn't a real failure
                last_updated: new Date().toISOString()
              }
            })
            .eq('id', story.id);

          await clearRecoveryLock(story.id);
          continue; // State corrected, no regeneration needed
        }

        // Determine what needs to be retried based on progress
        const hasBible = !!progress.bible_complete;
        const hasArc = !!progress.arc_complete;

        if (!hasBible) {
          // Bible not complete — check if bible_id exists (bible was generated but progress wasn't updated)
          const { data: storyData } = await supabaseAdmin
            .from('stories')
            .select('bible_id')
            .eq('id', story.id)
            .single();

          if (storyData?.bible_id) {
            console.log('   📖 Bible exists (bible_id found), skipping to arc generation');
            // Bible exists, update progress and continue to arc
            await supabaseAdmin
              .from('stories')
              .update({
                generation_progress: {
                  ...updatedProgress,
                  bible_complete: true,
                  current_step: 'generating_arc'
                }
              })
              .eq('id', story.id);

            // Run orchestratePreGeneration — it should detect bible exists and skip to arc
            orchestratePreGeneration(story.id, story.user_id)
              .catch(err => {
                console.error(`   ❌ Recovery failed for ${story.id}:`, err.message);
              })
              .finally(() => clearRecoveryLock(story.id));
          } else {
            console.log('   📖 Bible missing — restarting full generation');
            // Need full re-generation — call the existing pipeline
            const { data: storyFull } = await supabaseAdmin
              .from('stories')
              .select('premise_id')
              .eq('id', story.id)
              .single();

            if (storyFull?.premise_id) {
              generateStoryBibleForExistingStory(story.id, storyFull.premise_id, story.user_id)
                .catch(err => {
                  console.error(`   ❌ Bible re-generation failed for ${story.id}:`, err.message);
                })
                .finally(() => clearRecoveryLock(story.id));
            }
          }
        } else if (!hasArc) {
          console.log('   🗺️ Bible complete, retrying arc generation');
          // Re-run from arc generation onward
          orchestratePreGeneration(story.id, story.user_id)
            .catch(err => {
              console.error(`   ❌ Arc recovery failed for ${story.id}:`, err.message);
            })
            .finally(() => clearRecoveryLock(story.id));
        } else if (chaptersGenerated < 3) {
          console.log(`   📝 Arc complete, resuming initial batch from chapter ${chaptersGenerated + 1}`);
          // Resume initial chapter generation (chapters 1-3)
          orchestratePreGeneration(story.id, story.user_id)
            .catch(err => {
              console.error(`   ❌ Chapter recovery failed for ${story.id}:`, err.message);
            })
            .finally(() => clearRecoveryLock(story.id));
        } else if (progress.batch_start && progress.batch_end) {
          // Recovery for checkpoint-triggered batch generation (chapters 4-6, 7-9, 10-12)
          const batchStart = progress.batch_start;
          const batchEnd = progress.batch_end;
          console.log(`   📝 Resuming batch generation: chapters ${batchStart}-${batchEnd}`);

          // Use triggerCheckpointGeneration logic to regenerate the batch
          const { triggerCheckpointGeneration } = require('../routes/feedback');
          const checkpointMap = { 4: 'chapter_2', 7: 'chapter_5', 10: 'chapter_8' };
          const checkpoint = checkpointMap[batchStart];

          if (checkpoint) {
            triggerCheckpointGeneration(story.id, story.user_id, checkpoint)
              .catch(err => {
                console.error(`   ❌ Batch recovery failed for ${story.id}:`, err.message);
              })
              .finally(() => clearRecoveryLock(story.id));
          } else {
            console.log(`   ⚠️ Unknown batch start ${batchStart}, skipping`);
            await clearRecoveryLock(story.id);
          }
        } else if (chaptersGenerated >= 3 && currentStep.startsWith('generating_')) {
          // Story has 3+ chapters and is stuck generating — likely a batch generation that didn't set batch_start/batch_end
          // Determine which batch based on chapter count
          const batchMap = { 3: { start: 4, end: 6, cp: 'chapter_2' }, 6: { start: 7, end: 9, cp: 'chapter_5' }, 9: { start: 10, end: 12, cp: 'chapter_8' } };
          const batch = batchMap[chaptersGenerated];

          if (batch) {
            // GUARD: Only trigger batch generation if the prerequisite checkpoint feedback actually exists.
            // Without this check, the health check can fire during the brief window between
            // "chapter 3 generated" and "pipeline sets awaiting_chapter_2_feedback", causing
            // runaway generation of chapters 4-6 without the reader ever giving feedback.
            const { data: feedbackExists } = await supabase
              .from('story_feedback')
              .select('id')
              .eq('story_id', story.id)
              .eq('checkpoint', batch.cp)
              .limit(1);

            if (feedbackExists && feedbackExists.length > 0) {
              console.log(`   📝 Inferring batch from chapter count (${chaptersGenerated}): chapters ${batch.start}-${batch.end} (feedback verified)`);
              const { triggerCheckpointGeneration } = require('../routes/feedback');
              triggerCheckpointGeneration(story.id, story.user_id, batch.cp)
                .catch(err => {
                  console.error(`   ❌ Inferred batch recovery failed for ${story.id}:`, err.message);
                })
                .finally(() => clearRecoveryLock(story.id));
            } else {
              // No feedback found — this is a race condition. The initial batch just finished
              // but the pipeline hasn't set the awaiting state yet. DON'T trigger the next batch.
              // Instead, just set the correct awaiting state.
              const awaitingStep = `awaiting_${batch.cp}_feedback`;
              console.log(`   ⚠️ No feedback for checkpoint "${batch.cp}" — race condition detected. Setting ${awaitingStep} instead of triggering batch.`);
              await supabase
                .from('stories')
                .update({
                  generation_progress: {
                    ...progress,
                    current_step: awaitingStep,
                    chapters_generated: chaptersGenerated,
                    last_updated: new Date().toISOString()
                  }
                })
                .eq('id', story.id);
              await clearRecoveryLock(story.id);
            }
          } else {
            console.log(`   ⚠️ Can't determine batch for ${chaptersGenerated} chapters, skipping`);
            await clearRecoveryLock(story.id);
          }
        } else {
          console.log('   ✅ Story appears complete, marking as active');
          await clearRecoveryLock(story.id);
        }

        console.log(`   ✅ Recovery initiated for "${story.title}"`);
      } catch (error) {
        console.error(`   ❌ Failed to initiate recovery for ${story.id}:`, error.message);

        // Peggy: Report recovery initiation failures
        reportToPeggy({
          source: 'health-check:recovery-failed',
          category: 'health_check',
          severity: 'high',
          errorMessage: `Recovery initiation failed: ${error.message}`,
          stackTrace: error.stack,
          storyId: story.id,
          storyTitle: story.title,
          affectedUserId: story.user_id
        }).catch(() => {});
      }
    }

    console.log('\n✅ Stalled/failed generation check complete\n');
  } catch (error) {
    console.error('❌ Error in resumeStalledGenerations:', error);

    // Peggy: Report health check system-level failures
    reportToPeggy({
      source: 'health-check:system-error',
      category: 'health_check',
      severity: 'critical',
      errorMessage: `Health check system error: ${error.message}`,
      stackTrace: error.stack
    }).catch(() => {});
  }
}

module.exports = {
  generatePremises,
  generateStoryBible,
  generateStoryBibleForExistingStory,
  generateArcOutline,
  generateChapter,
  orchestratePreGeneration,
  extractBookContext,
  generateSequelBible,
  generateSeriesName,
  analyzeUserPreferences,
  getUserWritingPreferences,
  updateDiscoveryTolerance,
  resumeStalledGenerations,
  buildCourseCorrections,
  generateEditorBrief,
  generateBatch,
  // Export utilities for testing and cross-service use
  calculateCost,
  parseAndValidateJSON,
  attemptJsonRepair,
  mapAgeRange,
  logApiCost,
  logPreferenceEvent
};
