/**
 * Test Prose Craft Rules
 *
 * Tests the new CRITICAL_PROSE_RULES by generating Chapter 1 for Tyler's story
 * using the current generation prompt. Verifies the scanner catches violations.
 *
 * DOES NOT write to database - console output only.
 */

require('dotenv').config();
const { supabaseAdmin } = require('./src/config/supabase');
const { anthropic } = require('./src/config/ai-clients');

// Import scanner function from generation.js (we'll need to copy it here since it's not exported)
function scanForProseViolations(chapterContent) {
  const violations = [];

  // Check em dashes
  const emDashCount = (chapterContent.match(/—/g) || []).length;
  if (emDashCount > 5) {
    violations.push(`Em dashes: ${emDashCount} (limit: 5)`);
  }

  // Check "Not X, but Y" constructions
  const notButPattern = /Not [a-zA-Z]+(?:,| —) (?:but|just) /gi;
  const notButMatches = (chapterContent.match(notButPattern) || []).length;
  if (notButMatches > 2) {
    violations.push(`"Not X, but Y" constructions: ${notButMatches} (limit: 2)`);
  }

  // Check "something in" constructions
  const somethingInPattern = /something in (?:his|her|their|my|your) /gi;
  const somethingInMatches = (chapterContent.match(somethingInPattern) || []).length;
  if (somethingInMatches > 1) {
    violations.push(`"something in" constructions: ${somethingInMatches} (limit: 1)`);
  }

  // Check "the kind of" constructions
  const kindOfPattern = /the kind of \w+ (?:that|who) /gi;
  const kindOfMatches = (chapterContent.match(kindOfPattern) || []).length;
  if (kindOfMatches > 1) {
    violations.push(`"the kind of" constructions: ${kindOfMatches} (limit: 1)`);
  }

  return {
    passed: violations.length === 0,
    violations,
    counts: {
      emDashes: emDashCount,
      notBut: notButMatches,
      somethingIn: somethingInMatches,
      kindOf: kindOfMatches
    }
  };
}

function mapAgeRange(readingLevel) {
  const map = {
    early_reader: '6-8',
    middle_grade: '8-12',
    upper_middle_grade: '10-14',
    young_adult: '14-18',
    new_adult: '18-25',
    adult: '18+'
  };
  return map[readingLevel] || '18+';
}

async function testProseFixForTyler() {
  const storyId = '0fdb7f93-c136-4f83-8ab2-4d8ebcea91c4';

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST: Prose Craft Rules - Chapter 1 Generation');
  console.log('Story: Tyler - "Respawn: The Worst Gamer in the Apocalypse"');
  console.log('═══════════════════════════════════════════════════════════════\n');

  try {
    // Step 1: Load story data
    console.log('📥 Loading story data...');
    const { data: story, error: storyError } = await supabaseAdmin
      .from('stories')
      .select('title, genre, bible_id, user_id, current_arc_id')
      .eq('id', storyId)
      .single();

    if (storyError || !story) {
      throw new Error(`Failed to load story: ${storyError?.message}`);
    }

    console.log(`   Title: "${story.title}"`);
    console.log(`   Genre: ${story.genre}`);

    // Step 2: Load bible
    console.log('\n📥 Loading story bible...');
    const { data: bible, error: bibleError } = await supabaseAdmin
      .from('story_bibles')
      .select('*')
      .eq('id', story.bible_id)
      .single();

    if (bibleError || !bible) {
      throw new Error(`Failed to load bible: ${bibleError?.message}`);
    }

    console.log(`   ✅ Bible loaded (${bible.characters?.length || 0} characters, ${bible.key_locations?.length || 0} locations)`);

    // Step 3: Load arc outline
    console.log('\n📥 Loading arc outline...');
    const { data: arc, error: arcError} = await supabaseAdmin
      .from('story_arcs')
      .select('*')
      .eq('story_id', storyId)
      .eq('arc_number', 1)
      .single();

    if (arcError || !arc) {
      throw new Error(`Failed to load arc: ${arcError?.message}`);
    }

    const arcTitle = arc.outline?.title || `Arc ${arc.arc_number}`;
    console.log(`   ✅ Arc loaded: "${arcTitle}"`);

    // Step 4: Load user preferences
    console.log('\n📥 Loading user preferences...');
    const { data: preferences, error: prefsError } = await supabaseAdmin
      .from('user_preferences')
      .select('*')
      .eq('user_id', story.user_id)
      .single();

    if (prefsError || !preferences) {
      throw new Error(`Failed to load preferences: ${prefsError?.message}`);
    }

    console.log(`   ✅ Preferences loaded (reading level: ${preferences.reading_level})`);

    // Step 5: Build generation prompt (simplified version matching generation.js)
    console.log('\n🤖 Building chapter generation prompt...');

    const ageRange = mapAgeRange(preferences.reading_level);
    const chapterData = arc.outline?.chapters?.[0];
    const chapterSummary = chapterData?.events_summary || 'Introduction and setup';

    const generatePrompt = `You are an award-winning fiction author...

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

<story_bible>
Title: ${story.title}
Genre: ${story.genre}

Characters: ${JSON.stringify(bible.characters, null, 2)}

Locations: ${JSON.stringify(bible.key_locations, null, 2)}

Central Conflict: ${JSON.stringify(bible.central_conflict, null, 2)}

Themes: ${JSON.stringify(bible.themes, null, 2)}

Tone: ${bible.tone || 'Not specified'}
</story_bible>

<arc_outline>
Arc: ${arc.title}
Chapter 1 Summary: ${chapterSummary}
</arc_outline>

<reading_level>
Target age range: ${ageRange}
Reading level: ${preferences.reading_level}
</reading_level>

Generate Chapter 1 following all prose rules. The chapter should be engaging, well-paced, and appropriate for the target age range.

Return ONLY valid JSON in this exact format:
{
  "chapter": {
    "title": "Chapter 1 title here",
    "content": "Full chapter text here (3500-4500 words)"
  }
}`;

    console.log(`   ✅ Prompt built (${generatePrompt.length} chars)`);

    // Step 6: Generate chapter
    console.log('\n🤖 Generating Chapter 1 with Claude...');
    console.log('   (This will take ~30-60 seconds)\n');

    const startTime = Date.now();
    let response;
    try {
      response = await anthropic.messages.create({
        model: 'claude-opus-4-20250514',
        max_tokens: 16000,
        temperature: 1,
        messages: [{
          role: 'user',
          content: generatePrompt
        }]
      });
    } catch (apiError) {
      console.error(`   ❌ Claude API error:`, apiError.message);
      throw new Error(`Claude API call failed: ${apiError.message}`);
    }

    if (!response || !response.content || !response.content[0]) {
      throw new Error(`Invalid response structure from Claude API`);
    }

    const generationTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`   ✅ Generation complete (${generationTime}s)`);

    // Step 7: Parse response
    console.log('\n📄 Parsing response...');
    const rawText = response.content[0].text;
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      console.log('\n❌ JSON Parse Error Details:');
      console.log(`   Error: ${parseError.message}`);
      console.log(`\n   Raw response length: ${jsonMatch[0].length} chars`);
      console.log(`   First 500 chars: ${jsonMatch[0].substring(0, 500)}`);
      console.log(`   Around error position (${parseError.message.match(/\d+/)?.[0] || 'unknown'}):`);
      const errorPos = parseInt(parseError.message.match(/\d+/)?.[0] || '0');
      console.log(`   ${jsonMatch[0].substring(Math.max(0, errorPos - 100), errorPos + 100)}`);
      throw parseError;
    }
    const chapter = parsed.chapter;

    if (!chapter || !chapter.content) {
      throw new Error('Invalid chapter structure');
    }

    console.log(`   Title: "${chapter.title}"`);
    console.log(`   Length: ${chapter.content.length} chars, ~${Math.round(chapter.content.split(/\s+/).length)} words`);

    // Step 8: Run prose violations scanner
    console.log('\n🔍 Running prose violations scanner...');
    const scanResult = scanForProseViolations(chapter.content);

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('SCANNER RESULTS');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Status: ${scanResult.passed ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`\nViolation Counts:`);
    console.log(`  Em dashes: ${scanResult.counts.emDashes} (limit: 5)`);
    console.log(`  "Not X but Y": ${scanResult.counts.notBut} (limit: 2)`);
    console.log(`  "something in": ${scanResult.counts.somethingIn} (limit: 1)`);
    console.log(`  "the kind of": ${scanResult.counts.kindOf} (limit: 1)`);

    if (!scanResult.passed) {
      console.log(`\n⚠️  Violations detected:`);
      scanResult.violations.forEach((v, i) => {
        console.log(`  ${i + 1}. ${v}`);
      });
      console.log(`\n→ In production, this would trigger regeneration (attempt 1/3)`);
    } else {
      console.log(`\n✅ No violations - chapter would proceed to quality review`);
    }

    // Step 9: Print full chapter
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('GENERATED CHAPTER TEXT');
    console.log('═══════════════════════════════════════════════════════════════\n');
    console.log(chapter.content);
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('END OF CHAPTER');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Summary
    console.log('📊 SUMMARY');
    console.log(`   Story: "${story.title}"`);
    console.log(`   Chapter: "${chapter.title}"`);
    console.log(`   Word count: ~${Math.round(chapter.content.split(/\s+/).length)}`);
    console.log(`   Generation time: ${generationTime}s`);
    console.log(`   Prose scan: ${scanResult.passed ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`   Em dashes: ${scanResult.counts.emDashes}/5`);
    console.log(`\n✅ Test complete - no database writes performed`);

  } catch (error) {
    console.error('\n❌ TEST FAILED');
    console.error(`Error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run test
testProseFixForTyler()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
