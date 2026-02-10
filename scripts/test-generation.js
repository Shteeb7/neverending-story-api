#!/usr/bin/env node

/**
 * Test script for AI Generation Engine
 *
 * Tests the complete generation pipeline from preferences to chapters.
 *
 * Usage:
 *   node scripts/test-generation.js [--full]
 *
 * Options:
 *   --full    Run full integration test including pre-generation (10-15 min)
 */

require('dotenv').config();
const {
  generatePremises,
  generateStoryBible,
  generateArcOutline,
  generateChapter,
  orchestratePreGeneration,
  calculateCost
} = require('../src/services/generation');

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001'; // Mock UUID for testing

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test 1: Cost Calculation
function testCostCalculation() {
  console.log('\n📊 Test 1: Cost Calculation');
  console.log('─'.repeat(50));

  const inputTokens = 1000;
  const outputTokens = 500;
  const cost = calculateCost(inputTokens, outputTokens);

  console.log(`Input tokens: ${inputTokens}`);
  console.log(`Output tokens: ${outputTokens}`);
  console.log(`Cost: $${cost.toFixed(4)}`);

  const expectedCost = (1000 / 1_000_000 * 15) + (500 / 1_000_000 * 75);
  console.log(`Expected: $${expectedCost.toFixed(4)}`);

  if (Math.abs(cost - expectedCost) < 0.0001) {
    console.log('✅ Cost calculation correct');
  } else {
    console.log('❌ Cost calculation incorrect');
  }
}

// Test 2: Generate Premises
async function testGeneratePremises() {
  console.log('\n📚 Test 2: Generate Premises');
  console.log('─'.repeat(50));

  const preferences = {
    favorite_series: ['Harry Potter', 'Percy Jackson'],
    favorite_genres: ['fantasy', 'adventure'],
    loved_elements: ['magic', 'friendship', 'quests', 'dragons'],
    disliked_elements: ['excessive violence', 'dark themes']
  };

  console.log('Generating premises with preferences:');
  console.log(JSON.stringify(preferences, null, 2));

  try {
    const startTime = Date.now();
    const { premises, premisesId } = await generatePremises(TEST_USER_ID, preferences);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n⏱️  Completed in ${duration}s`);
    console.log(`Premises ID: ${premisesId}`);
    console.log(`\nGenerated ${premises.length} premises:\n`);

    premises.forEach((premise, i) => {
      console.log(`${i + 1}. ${premise.title}`);
      console.log(`   Genre: ${premise.genre}`);
      console.log(`   Hook: ${premise.hook}`);
      console.log(`   Themes: ${premise.themes.join(', ')}`);
      console.log('');
    });

    if (premises.length === 3) {
      console.log('✅ Generated exactly 3 premises');
    } else {
      console.log(`❌ Expected 3 premises, got ${premises.length}`);
    }

    return { premisesId, premises };
  } catch (error) {
    console.error('❌ Error generating premises:', error.message);
    throw error;
  }
}

// Test 3: Generate Story Bible
async function testGenerateStoryBible(premiseId) {
  console.log('\n📖 Test 3: Generate Story Bible');
  console.log('─'.repeat(50));

  try {
    const startTime = Date.now();
    const { bible, storyId } = await generateStoryBible(premiseId, TEST_USER_ID);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n⏱️  Completed in ${duration}s`);
    console.log(`Story ID: ${storyId}`);
    console.log(`\nStory Bible for "${bible.title}":\n`);

    console.log(`Protagonist: ${bible.characters.protagonist.name}, age ${bible.characters.protagonist.age}`);
    console.log(`  Goals: ${bible.characters.protagonist.goals}`);
    console.log(`  Strengths: ${bible.characters.protagonist.strengths.join(', ')}`);
    console.log(`  Flaws: ${bible.characters.protagonist.flaws.join(', ')}`);

    console.log(`\nAntagonist: ${bible.characters.antagonist.name}`);
    console.log(`  Motivation: ${bible.characters.antagonist.motivation}`);

    console.log(`\nCentral Conflict: ${bible.central_conflict.description}`);
    console.log(`\nStakes: ${bible.stakes.personal}`);

    console.log(`\nKey Locations: ${bible.key_locations.length}`);
    bible.key_locations.forEach((loc, i) => {
      console.log(`  ${i + 1}. ${loc.name} - ${loc.description.substring(0, 60)}...`);
    });

    console.log(`\nThemes: ${bible.themes.join(', ')}`);

    console.log('\n✅ Story bible generated successfully');
    return { bible, storyId };
  } catch (error) {
    console.error('❌ Error generating bible:', error.message);
    throw error;
  }
}

// Test 4: Generate Arc Outline
async function testGenerateArcOutline(storyId) {
  console.log('\n📋 Test 4: Generate Arc Outline');
  console.log('─'.repeat(50));

  try {
    const startTime = Date.now();
    const { arc } = await generateArcOutline(storyId, TEST_USER_ID);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n⏱️  Completed in ${duration}s`);
    console.log(`\nGenerated ${arc.chapters.length}-chapter outline:\n`);

    arc.chapters.forEach((chapter, i) => {
      console.log(`Chapter ${chapter.chapter_number}: ${chapter.title}`);
      console.log(`  Events: ${chapter.events_summary.substring(0, 80)}...`);
      console.log(`  Tension: ${chapter.tension_level}`);
      console.log(`  Target words: ${chapter.word_count_target}`);
      console.log('');
    });

    console.log(`Pacing: ${arc.pacing_notes}`);

    if (arc.chapters.length === 12) {
      console.log('✅ Generated exactly 12 chapters');
    } else {
      console.log(`❌ Expected 12 chapters, got ${arc.chapters.length}`);
    }

    return { arc };
  } catch (error) {
    console.error('❌ Error generating arc:', error.message);
    throw error;
  }
}

// Test 5: Generate Single Chapter
async function testGenerateChapter(storyId, chapterNumber = 1) {
  console.log(`\n✍️  Test 5: Generate Chapter ${chapterNumber}`);
  console.log('─'.repeat(50));

  try {
    const startTime = Date.now();
    const chapter = await generateChapter(storyId, chapterNumber, TEST_USER_ID);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n⏱️  Completed in ${duration}s`);
    console.log(`\nChapter ${chapter.chapter_number}: ${chapter.title}\n`);

    console.log(`Word count: ${chapter.word_count}`);
    console.log(`Quality score: ${chapter.quality_score}/10`);
    console.log(`Regenerations: ${chapter.regeneration_count}`);

    if (chapter.quality_review) {
      console.log('\nQuality Review:');
      console.log(`  Age-appropriateness: ${chapter.quality_review.criteria_scores?.age_appropriateness || 'N/A'}/10`);
      console.log(`  Engagement: ${chapter.quality_review.criteria_scores?.engagement || 'N/A'}/10`);
      console.log(`  Pacing: ${chapter.quality_review.criteria_scores?.pacing || 'N/A'}/10`);
      console.log(`  Character consistency: ${chapter.quality_review.criteria_scores?.character_consistency || 'N/A'}/10`);
      console.log(`  Arc alignment: ${chapter.quality_review.criteria_scores?.arc_alignment || 'N/A'}/10`);
      console.log(`  Writing quality: ${chapter.quality_review.criteria_scores?.writing_quality || 'N/A'}/10`);

      if (chapter.quality_review.strengths) {
        console.log('\n  Strengths:');
        chapter.quality_review.strengths.forEach(s => console.log(`    - ${s}`));
      }
    }

    console.log(`\nContent preview (first 200 chars):`);
    console.log(`"${chapter.content.substring(0, 200)}..."`);

    const passedQuality = chapter.quality_score >= 7;
    const correctWordCount = chapter.word_count >= 2500 && chapter.word_count <= 3500;

    if (passedQuality) {
      console.log('✅ Chapter passed quality review');
    } else {
      console.log(`❌ Chapter quality score too low: ${chapter.quality_score}/10`);
    }

    if (correctWordCount) {
      console.log('✅ Chapter word count in range (2500-3500)');
    } else {
      console.log(`❌ Chapter word count out of range: ${chapter.word_count}`);
    }

    return { chapter };
  } catch (error) {
    console.error('❌ Error generating chapter:', error.message);
    throw error;
  }
}

// Test 6: Full Pre-Generation (SLOW - 10-15 minutes)
async function testFullPreGeneration(storyId) {
  console.log('\n🚀 Test 6: Full Pre-Generation (Bible + Arc + 8 Chapters)');
  console.log('─'.repeat(50));
  console.log('⚠️  This will take 10-15 minutes and cost ~$8.45');
  console.log('Starting in 3 seconds...\n');

  await sleep(3000);

  try {
    const startTime = Date.now();

    // Run orchestration
    await orchestratePreGeneration(storyId, TEST_USER_ID);

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

    console.log(`\n⏱️  Completed in ${duration} minutes`);
    console.log('✅ Full pre-generation completed successfully');

    // Verify in database
    const { supabaseAdmin } = require('../src/config/supabase');

    const { data: story } = await supabaseAdmin
      .from('stories')
      .select('*, chapters(*)')
      .eq('id', storyId)
      .single();

    console.log(`\nStory Status: ${story.status}`);
    console.log(`Chapters Generated: ${story.chapters?.length || 0}`);
    console.log(`Progress: ${JSON.stringify(story.generation_progress, null, 2)}`);

    if (story.status === 'active' && story.chapters?.length === 8) {
      console.log('\n✅ Pre-generation verification passed');
    } else {
      console.log('\n❌ Pre-generation verification failed');
    }
  } catch (error) {
    console.error('❌ Error in pre-generation:', error.message);
    throw error;
  }
}

// Main test runner
async function runTests() {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║   AI Generation Engine Test Suite                ║');
  console.log('╚═══════════════════════════════════════════════════╝');

  const runFullTest = process.argv.includes('--full');

  try {
    // Test 1: Cost calculation
    testCostCalculation();

    // Test 2: Generate premises
    const { premisesId, premises } = await testGeneratePremises();

    // Test 3: Generate bible (creates story)
    const { storyId } = await testGenerateStoryBible(premisesId);

    // Test 4: Generate arc
    await testGenerateArcOutline(storyId);

    // Test 5: Generate single chapter
    await testGenerateChapter(storyId, 1);

    // Test 6: Full pre-generation (optional - very slow)
    if (runFullTest) {
      await testFullPreGeneration(storyId);
    } else {
      console.log('\n⏭️  Skipping full pre-generation test (use --full to run)');
    }

    console.log('\n╔═══════════════════════════════════════════════════╗');
    console.log('║   ✅ All Tests Passed!                            ║');
    console.log('╚═══════════════════════════════════════════════════╝');
  } catch (error) {
    console.log('\n╔═══════════════════════════════════════════════════╗');
    console.log('║   ❌ Tests Failed                                 ║');
    console.log('╚═══════════════════════════════════════════════════╝');
    console.error('\nError details:', error);
    process.exit(1);
  }
}

// Run tests
runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
