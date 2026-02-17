require('dotenv').config();
const prospero = require('../src/config/prospero');
const peggy = require('../src/config/peggy');

console.log('=================================');
console.log('PEGGY QA VERIFICATION SCRIPT');
console.log('=================================\n');

// 1. Test Prospero config still works
console.log('1. Testing Prospero config (backward compatibility)...');
try {
  const prosperoPrompt = prospero.assemblePrompt('onboarding', 'voice', { userName: 'Test' });
  const prosperoGreeting = prospero.getGreeting('onboarding', {});

  if (prosperoPrompt.length > 0 && prosperoGreeting.length > 0) {
    console.log('   ✅ Prospero config works');
    console.log(`      Prompt length: ${prosperoPrompt.length} chars`);
    console.log(`      Greeting: "${prosperoGreeting.substring(0, 50)}..."`);
  } else {
    throw new Error('Prospero returned empty strings');
  }
} catch (error) {
  console.log('   ❌ Prospero config failed:', error.message);
  process.exit(1);
}

// 2. Test Peggy config
console.log('\n2. Testing Peggy config...');
try {
  const peggyBugPrompt = peggy.assemblePrompt('bug_report', 'voice', {
    user_name: 'TestUser',
    reading_level: 'adult'
  });
  const peggySuggestionPrompt = peggy.assemblePrompt('suggestion', 'text', {
    user_name: 'TestUser',
    reading_level: 'middle_grade'
  });
  const peggyGreeting = peggy.getGreeting('bug_report', {});

  if (peggyBugPrompt.length > 0 && peggySuggestionPrompt.length > 0 && peggyGreeting.length > 0) {
    console.log('   ✅ Peggy config works');
    console.log(`      Bug report prompt length: ${peggyBugPrompt.length} chars`);
    console.log(`      Suggestion prompt length: ${peggySuggestionPrompt.length} chars`);
    console.log(`      Greeting: "${peggyGreeting}"`);
  } else {
    throw new Error('Peggy returned empty strings');
  }
} catch (error) {
  console.log('   ❌ Peggy config failed:', error.message);
  process.exit(1);
}

// 3. Verify Peggy personality traits are present
console.log('\n3. Verifying Peggy personality traits...');
try {
  const prompt = peggy.assemblePrompt('bug_report', 'voice', {});

  const requiredTraits = [
    '1950s',
    'Long Island',
    'phone operator',
    'PEGGY',
    'submit_bug_report'
  ];

  const missingTraits = requiredTraits.filter(trait => !prompt.includes(trait));

  if (missingTraits.length === 0) {
    console.log('   ✅ All personality traits present');
    requiredTraits.forEach(trait => {
      console.log(`      ✓ ${trait}`);
    });
  } else {
    console.log('   ❌ Missing traits:', missingTraits.join(', '));
    process.exit(1);
  }
} catch (error) {
  console.log('   ❌ Personality verification failed:', error.message);
  process.exit(1);
}

// 4. Verify tone adjustment for young readers
console.log('\n4. Verifying tone adjustment for young readers...');
try {
  const youngPrompt = peggy.assemblePrompt('bug_report', 'voice', {
    reading_level: 'early_reader'
  });
  const adultPrompt = peggy.assemblePrompt('bug_report', 'voice', {
    reading_level: 'adult'
  });

  if (youngPrompt.includes('TONE ADJUSTMENT') && !adultPrompt.includes('TONE ADJUSTMENT')) {
    console.log('   ✅ Tone adjustment works correctly');
    console.log('      Young reader: TONE ADJUSTMENT present');
    console.log('      Adult reader: No adjustment');
  } else {
    throw new Error('Tone adjustment not working as expected');
  }
} catch (error) {
  console.log('   ❌ Tone adjustment failed:', error.message);
  process.exit(1);
}

// 5. Verify both mediums work
console.log('\n5. Verifying voice and text mediums...');
try {
  const voicePrompt = peggy.assemblePrompt('bug_report', 'voice', {});
  const textPrompt = peggy.assemblePrompt('bug_report', 'text', {});

  if (voicePrompt.includes('VOICE CONVERSATION') && textPrompt.includes('WRITTEN CORRESPONDENCE')) {
    console.log('   ✅ Both mediums work correctly');
    console.log('      Voice: includes VOICE CONVERSATION');
    console.log('      Text: includes WRITTEN CORRESPONDENCE');
  } else {
    throw new Error('Medium adapters not working');
  }
} catch (error) {
  console.log('   ❌ Medium verification failed:', error.message);
  process.exit(1);
}

// 6. Verify error handling
console.log('\n6. Verifying error handling...');
try {
  let errorCaught = false;

  try {
    peggy.assemblePrompt('invalid_type', 'voice', {});
  } catch (error) {
    if (error.message.includes('Unknown report type')) {
      errorCaught = true;
    }
  }

  if (errorCaught) {
    console.log('   ✅ Error handling works correctly');
    console.log('      Invalid report type throws appropriate error');
  } else {
    throw new Error('Error handling not working');
  }
} catch (error) {
  console.log('   ❌ Error handling failed:', error.message);
  process.exit(1);
}

console.log('\n=================================');
console.log('✅ ALL QA CHECKS PASSED');
console.log('=================================');
console.log('\nSummary:');
console.log('- Prospero config: Working ✓');
console.log('- Peggy config: Working ✓');
console.log('- Personality traits: Present ✓');
console.log('- Tone adjustment: Working ✓');
console.log('- Voice/text mediums: Working ✓');
console.log('- Error handling: Working ✓');
console.log('\nPeggy is ready for iOS integration!');
