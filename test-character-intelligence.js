/**
 * Character Intelligence Integration Test
 *
 * Standalone test script that exercises the full character intelligence pipeline
 * against real story data. Makes REAL API calls to Claude (~$0.21 expected cost).
 *
 * Run with: node test-character-intelligence.js
 */

// Load environment variables first
require('dotenv').config();

const {
  extractCharacterLedger,
  buildCharacterContinuityBlock,
  reviewCharacterVoices,
  applyVoiceRevisions
} = require('./src/services/character-intelligence');
const { supabaseAdmin } = require('./src/config/supabase');

// Test state
let testStoryId = null;
let testStory = null;
let chapter1Content = null;
let chapter2Content = null;
let originalChapter2Content = null;
let originalChapter2Metadata = {};
let chapter2WasRevised = false;
let totalCost = 0;
const startTime = Date.now();

// Results tracking
const results = {
  pass: 0,
  fail: 0,
  skip: 0,
  steps: []
};

/**
 * Helper: Report step result
 */
function reportStep(stepNumber, description, status, details = '') {
  const statusIcon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⏭️';
  const line = `Step ${stepNumber}: ${description.padEnd(30)} ${statusIcon} ${status}${details ? ' — ' + details : ''}`;
  console.log(line);

  results.steps.push({ stepNumber, description, status, details });
  if (status === 'PASS') results.pass++;
  else if (status === 'FAIL') results.fail++;
  else if (status === 'SKIP') results.skip++;
}

/**
 * Helper: Format elapsed time
 */
function elapsed() {
  return ((Date.now() - startTime) / 1000).toFixed(1) + 's';
}

/**
 * Step 0: Setup - Find a story with at least 3 chapters
 */
async function setup() {
  console.log('🧪 Character Intelligence Integration Test');
  console.log('==========================================\n');
  console.log('Setup: Finding a story with at least 3 chapters...');

  const { data: stories, error } = await supabaseAdmin
    .from('stories')
    .select('id, title, user_id')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) throw new Error(`Failed to fetch stories: ${error.message}`);
  if (!stories || stories.length === 0) {
    throw new Error('No completed stories found in database');
  }

  // Find first story with at least 3 chapters
  for (const story of stories) {
    const { count, error: countError } = await supabaseAdmin
      .from('chapters')
      .select('*', { count: 'exact', head: true })
      .eq('story_id', story.id);

    if (countError) continue;
    if (count >= 3) {
      testStoryId = story.id;
      testStory = story;
      break;
    }
  }

  if (!testStoryId) {
    throw new Error('No story found with at least 3 chapters');
  }

  // Fetch chapters 1 and 2
  const { data: chapters, error: chaptersError } = await supabaseAdmin
    .from('chapters')
    .select('chapter_number, content')
    .eq('story_id', testStoryId)
    .in('chapter_number', [1, 2])
    .order('chapter_number');

  if (chaptersError || !chapters || chapters.length < 2) {
    throw new Error('Failed to fetch chapters 1 and 2');
  }

  chapter1Content = chapters.find(c => c.chapter_number === 1)?.content;
  chapter2Content = chapters.find(c => c.chapter_number === 2)?.content;
  originalChapter2Content = chapter2Content; // Save for cleanup

  // Fetch chapter 2 metadata to preserve during cleanup
  const { data: ch2Meta } = await supabaseAdmin
    .from('chapters')
    .select('metadata')
    .eq('story_id', testStoryId)
    .eq('chapter_number', 2)
    .single();
  originalChapter2Metadata = ch2Meta?.metadata || {};

  if (!chapter1Content || !chapter2Content) {
    throw new Error('Missing chapter content');
  }

  console.log(`Using story: "${testStory.title}" (${testStoryId.substring(0, 8)}...)`);
  console.log(`Chapter 1: ${chapter1Content.length.toLocaleString()} chars`);
  console.log(`Chapter 2: ${chapter2Content.length.toLocaleString()} chars\n`);
}

/**
 * Step 1: Extract Character Ledger - Chapter 1
 */
async function step1_extractLedgerChapter1() {
  const ledger = await extractCharacterLedger(testStoryId, 1, chapter1Content);

  // Verify: returns non-null object
  if (!ledger) {
    reportStep(1, 'Extract Ledger (Ch 1)', 'FAIL', 'returned null');
    return;
  }

  // Verify: saved to DB
  const { data: dbEntry, error } = await supabaseAdmin
    .from('character_ledger_entries')
    .select('*')
    .eq('story_id', testStoryId)
    .eq('chapter_number', 1)
    .maybeSingle();

  if (error || !dbEntry) {
    reportStep(1, 'Extract Ledger (Ch 1)', 'FAIL', 'not saved to DB');
    return;
  }

  // Verify: has ledger_data with characters
  if (!dbEntry.ledger_data || !dbEntry.ledger_data.characters) {
    reportStep(1, 'Extract Ledger (Ch 1)', 'FAIL', 'missing characters in ledger_data');
    return;
  }

  // Verify: callback_bank is an array
  if (!Array.isArray(dbEntry.callback_bank)) {
    reportStep(1, 'Extract Ledger (Ch 1)', 'FAIL', 'callback_bank is not an array');
    return;
  }

  const charCount = Object.keys(dbEntry.ledger_data.characters || {}).length;
  const callbackCount = dbEntry.callback_bank.length;

  reportStep(
    1,
    'Extract Ledger (Ch 1)',
    'PASS',
    `${charCount} characters, ${callbackCount} callbacks`
  );
}

/**
 * Step 2: Extract Character Ledger - Chapter 2
 */
async function step2_extractLedgerChapter2() {
  const ledger = await extractCharacterLedger(testStoryId, 2, chapter2Content);

  // Verify: returns non-null object
  if (!ledger) {
    reportStep(2, 'Extract Ledger (Ch 2)', 'FAIL', 'returned null');
    return;
  }

  // Verify: saved to DB
  const { data: dbEntry, error } = await supabaseAdmin
    .from('character_ledger_entries')
    .select('*')
    .eq('story_id', testStoryId)
    .eq('chapter_number', 2)
    .maybeSingle();

  if (error || !dbEntry) {
    reportStep(2, 'Extract Ledger (Ch 2)', 'FAIL', 'not saved to DB');
    return;
  }

  // Verify: callback_bank merges from chapter 1
  const { data: ch1Entry } = await supabaseAdmin
    .from('character_ledger_entries')
    .select('callback_bank')
    .eq('story_id', testStoryId)
    .eq('chapter_number', 1)
    .maybeSingle();

  const ch1CallbackCount = ch1Entry?.callback_bank?.length || 0;
  const ch2CallbackCount = dbEntry.callback_bank.length;

  if (ch2CallbackCount < ch1CallbackCount) {
    reportStep(2, 'Extract Ledger (Ch 2)', 'FAIL', 'callback_bank did not merge from Ch 1');
    return;
  }

  const charCount = Object.keys(dbEntry.ledger_data.characters || {}).length;

  reportStep(
    2,
    'Extract Ledger (Ch 2)',
    'PASS',
    `${charCount} characters, ${ch2CallbackCount} merged callbacks`
  );
}

/**
 * Step 3: Callback Deduplication Verification
 */
async function step3_callbackDedup() {
  const { data: ch2Entry, error } = await supabaseAdmin
    .from('character_ledger_entries')
    .select('callback_bank')
    .eq('story_id', testStoryId)
    .eq('chapter_number', 2)
    .maybeSingle();

  if (error || !ch2Entry) {
    reportStep(3, 'Callback Dedup', 'FAIL', 'could not fetch Ch 2 ledger');
    return;
  }

  const callbacks = ch2Entry.callback_bank || [];
  const keys = new Set();
  let duplicates = 0;

  for (const callback of callbacks) {
    const key = `${callback.source_chapter}_${callback.moment}`;
    if (keys.has(key)) {
      duplicates++;
    }
    keys.add(key);
  }

  if (duplicates > 0) {
    reportStep(3, 'Callback Dedup', 'FAIL', `${duplicates} duplicates found`);
  } else {
    reportStep(3, 'Callback Dedup', 'PASS', '0 duplicates found');
  }
}

/**
 * Step 4: Build Character Continuity Block - For Chapter 3
 */
async function step4_buildContinuityBlock() {
  const block = await buildCharacterContinuityBlock(testStoryId, 3);

  // Verify: returns non-empty string
  if (!block || typeof block !== 'string') {
    reportStep(4, 'Build Continuity Block', 'FAIL', 'returned empty or non-string');
    return;
  }

  // Verify: contains expected XML tags
  const hasRoot = block.includes('<character_continuity>');
  const hasCh2 = block.includes('<chapter_2_ledger>');
  const hasCh1 = block.includes('<chapter_1_ledger>');
  const hasCallbacks = block.includes('<callback_bank>');

  if (!hasRoot || !hasCh2 || !hasCh1 || !hasCallbacks) {
    const missing = [];
    if (!hasRoot) missing.push('character_continuity');
    if (!hasCh2) missing.push('chapter_2_ledger');
    if (!hasCh1) missing.push('chapter_1_ledger');
    if (!hasCallbacks) missing.push('callback_bank');

    reportStep(4, 'Build Continuity Block', 'FAIL', `missing tags: ${missing.join(', ')}`);
    return;
  }

  reportStep(
    4,
    'Build Continuity Block',
    'PASS',
    `${block.length.toLocaleString()} chars, both chapters included`
  );
}

/**
 * Step 5: Review Character Voices - Chapter 2
 */
async function step5_reviewVoices() {
  const userId = testStory.user_id;
  const reviewResult = await reviewCharacterVoices(
    testStoryId,
    2,
    chapter2Content,
    userId
  );

  // Verify: returns non-null object
  if (!reviewResult) {
    reportStep(5, 'Voice Review (Ch 2)', 'FAIL', 'returned null');
    return null;
  }

  // Verify: has voice_checks array
  if (!reviewResult.voice_checks || !Array.isArray(reviewResult.voice_checks)) {
    reportStep(5, 'Voice Review (Ch 2)', 'FAIL', 'missing voice_checks array');
    return null;
  }

  if (reviewResult.voice_checks.length === 0) {
    reportStep(5, 'Voice Review (Ch 2)', 'FAIL', 'voice_checks is empty');
    return null;
  }

  // Verify: each check has required fields
  for (const check of reviewResult.voice_checks) {
    if (!check.character || typeof check.authenticity_score !== 'number') {
      reportStep(5, 'Voice Review (Ch 2)', 'FAIL', 'voice_check missing required fields');
      return null;
    }
    if (check.authenticity_score < 0 || check.authenticity_score > 1) {
      reportStep(5, 'Voice Review (Ch 2)', 'FAIL', 'authenticity_score out of range');
      return null;
    }
  }

  // Verify: saved to DB
  const { data: dbEntry, error } = await supabaseAdmin
    .from('character_voice_reviews')
    .select('*')
    .eq('story_id', testStoryId)
    .eq('chapter_number', 2)
    .maybeSingle();

  if (error || !dbEntry) {
    reportStep(5, 'Voice Review (Ch 2)', 'FAIL', 'not saved to DB');
    return null;
  }

  // Format scores for output
  const scores = reviewResult.voice_checks
    .map(c => `${c.character}: ${c.authenticity_score.toFixed(2)}`)
    .join(', ');

  reportStep(5, 'Voice Review (Ch 2)', 'PASS', scores);

  return reviewResult;
}

/**
 * Step 6: Apply Voice Revisions - Chapter 2 (conditional)
 */
async function step6_applyRevisions(reviewResult) {
  if (!reviewResult) {
    reportStep(6, 'Voice Revision', 'SKIP', 'no review result from Step 5');
    return;
  }

  // Check if revision is needed (any character with score < 0.8 OR missed callbacks)
  const needsRevision = reviewResult.voice_checks.some(c =>
    c.authenticity_score < 0.8 ||
    (c.missed_callbacks && c.missed_callbacks.length > 0)
  );

  const userId = testStory.user_id;
  const revisedContent = await applyVoiceRevisions(
    testStoryId,
    2,
    chapter2Content,
    reviewResult,
    userId
  );

  if (!needsRevision) {
    // Should return null
    if (revisedContent === null) {
      reportStep(6, 'Voice Revision', 'SKIP', 'all scores >= 0.8, no revision needed');
    } else {
      reportStep(6, 'Voice Revision', 'FAIL', 'returned content when no revision needed');
    }
    return;
  }

  // Revision was needed
  if (!revisedContent || typeof revisedContent !== 'string') {
    reportStep(6, 'Voice Revision', 'FAIL', 'returned null when revision was needed');
    return;
  }

  // Verify: chapter was updated in DB
  const { data: updatedChapter, error } = await supabaseAdmin
    .from('chapters')
    .select('content, metadata')
    .eq('story_id', testStoryId)
    .eq('chapter_number', 2)
    .maybeSingle();

  if (error || !updatedChapter) {
    reportStep(6, 'Voice Revision', 'FAIL', 'could not fetch updated chapter');
    return;
  }

  if (updatedChapter.content === originalChapter2Content) {
    reportStep(6, 'Voice Revision', 'FAIL', 'chapter content was not updated');
    return;
  }

  if (!updatedChapter.metadata?.voice_revision) {
    reportStep(6, 'Voice Revision', 'FAIL', 'metadata.voice_revision not set');
    return;
  }

  chapter2WasRevised = true;

  const lowScores = reviewResult.voice_checks
    .filter(c => c.authenticity_score < 0.8)
    .map(c => c.character)
    .join(', ');

  reportStep(6, 'Voice Revision', 'PASS', `revised for: ${lowScores}`);
}

/**
 * Step 7: Admin Endpoint Verification (DB query)
 */
async function step7_adminVerification() {
  // Check character_ledger_entries
  const { data: ledgerEntries, error: ledgerError } = await supabaseAdmin
    .from('character_ledger_entries')
    .select('chapter_number')
    .eq('story_id', testStoryId)
    .order('chapter_number');

  if (ledgerError) {
    reportStep(7, 'DB Verification', 'FAIL', `ledger query error: ${ledgerError.message}`);
    return;
  }

  if (!ledgerEntries || ledgerEntries.length !== 2) {
    reportStep(7, 'DB Verification', 'FAIL', `expected 2 ledger entries, got ${ledgerEntries?.length || 0}`);
    return;
  }

  // Check character_voice_reviews
  const { data: voiceReviews, error: reviewError } = await supabaseAdmin
    .from('character_voice_reviews')
    .select('chapter_number')
    .eq('story_id', testStoryId);

  if (reviewError) {
    reportStep(7, 'DB Verification', 'FAIL', `review query error: ${reviewError.message}`);
    return;
  }

  if (!voiceReviews || voiceReviews.length !== 1) {
    reportStep(7, 'DB Verification', 'FAIL', `expected 1 voice review, got ${voiceReviews?.length || 0}`);
    return;
  }

  reportStep(7, 'DB Verification', 'PASS', '2 ledger entries, 1 voice review');
}

/**
 * Step 8: Cleanup
 */
async function step8_cleanup() {
  const errors = [];

  // Delete voice reviews
  const { error: reviewDeleteError } = await supabaseAdmin
    .from('character_voice_reviews')
    .delete()
    .eq('story_id', testStoryId);

  if (reviewDeleteError) {
    errors.push(`voice reviews: ${reviewDeleteError.message}`);
  }

  // Delete ledger entries
  const { error: ledgerDeleteError } = await supabaseAdmin
    .from('character_ledger_entries')
    .delete()
    .eq('story_id', testStoryId);

  if (ledgerDeleteError) {
    errors.push(`ledger entries: ${ledgerDeleteError.message}`);
  }

  // Restore chapter 2 if it was revised
  if (chapter2WasRevised && originalChapter2Content) {
    const { error: updateError } = await supabaseAdmin
      .from('chapters')
      .update({
        content: originalChapter2Content,
        metadata: originalChapter2Metadata // Restore original metadata
      })
      .eq('story_id', testStoryId)
      .eq('chapter_number', 2);

    if (updateError) {
      errors.push(`chapter restore: ${updateError.message}`);
    }
  }

  // Verify cleanup
  const { count: ledgerCount } = await supabaseAdmin
    .from('character_ledger_entries')
    .select('*', { count: 'exact', head: true })
    .eq('story_id', testStoryId);

  const { count: reviewCount } = await supabaseAdmin
    .from('character_voice_reviews')
    .select('*', { count: 'exact', head: true })
    .eq('story_id', testStoryId);

  if (ledgerCount > 0 || reviewCount > 0) {
    errors.push(`${ledgerCount} ledger entries, ${reviewCount} reviews still remain`);
  }

  if (errors.length > 0) {
    reportStep(8, 'Cleanup', 'FAIL', errors.join('; '));
  } else {
    reportStep(8, 'Cleanup', 'PASS', 'all test data removed');
  }
}

/**
 * Main test runner
 */
async function main() {
  try {
    await setup();

    // Run all test steps
    await step1_extractLedgerChapter1();
    await step2_extractLedgerChapter2();
    await step3_callbackDedup();
    await step4_buildContinuityBlock();
    const reviewResult = await step5_reviewVoices();
    await step6_applyRevisions(reviewResult);
    await step7_adminVerification();

  } catch (error) {
    console.error('\n❌ Test failed with error:', error.message);
    console.error(error.stack);

    // Still try cleanup
    try {
      console.log('\nAttempting cleanup...');
      await step8_cleanup();
    } catch (cleanupError) {
      console.error('Cleanup also failed:', cleanupError.message);
    }

    process.exit(1);
  } finally {
    // Always run cleanup
    if (testStoryId) {
      await step8_cleanup();
    }
  }

  // Print summary
  console.log('\n============================================');
  console.log(`Results: ${results.pass} PASS, ${results.fail} FAIL, ${results.skip} SKIP`);
  console.log(`Total cost: ~$0.21 (2 Haiku + 1 Sonnet)`);
  console.log(`Duration: ${elapsed()}`);

  // Exit with appropriate code
  if (results.fail > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

// Run the test
main();
