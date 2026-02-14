/**
 * Test script for GET /onboarding/user-preferences/:userId
 * Verifies the returning user data flow
 */

const userId = 'a3f8818e-2ffe-4d61-bfbe-7f96d1d78a7b';
const baseURL = process.env.API_BASE_URL || 'https://neverending-story-api-production.up.railway.app';

async function testUserPreferences() {
  console.log('🧪 Testing GET /onboarding/user-preferences/:userId');
  console.log(`   User ID: ${userId}`);
  console.log(`   Endpoint: ${baseURL}/onboarding/user-preferences/${userId}`);
  console.log('');

  try {
    // You'll need a valid access token for this user
    // Get it from Supabase or use the auth flow
    const accessToken = process.env.TEST_ACCESS_TOKEN;

    if (!accessToken) {
      console.log('❌ ERROR: TEST_ACCESS_TOKEN environment variable not set');
      console.log('   Set it with: export TEST_ACCESS_TOKEN="your_token_here"');
      process.exit(1);
    }

    const response = await fetch(`${baseURL}/onboarding/user-preferences/${userId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-User-ID': userId,
        'Content-Type': 'application/json'
      }
    });

    console.log(`📊 Response Status: ${response.status} ${response.statusText}`);
    console.log('');

    if (!response.ok) {
      const errorText = await response.text();
      console.log('❌ Request failed:');
      console.log(errorText);
      process.exit(1);
    }

    const data = await response.json();
    console.log('✅ Response received successfully!');
    console.log('');
    console.log('📦 Full Response:');
    console.log(JSON.stringify(data, null, 2));
    console.log('');

    // Verify expected fields
    console.log('🔍 Verifying Required Fields:');
    console.log('');

    const prefs = data.preferences;

    if (!prefs) {
      console.log('❌ FAIL: No preferences object in response');
      process.exit(1);
    }

    // Check for required fields
    const checks = [
      { field: 'name', path: 'preferences.name', value: prefs.name },
      { field: 'genres', path: 'preferences.genres', value: prefs.genres },
      { field: 'themes', path: 'preferences.themes', value: prefs.themes },
      { field: 'mood', path: 'preferences.mood', value: prefs.mood }
    ];

    let allPassed = true;
    for (const check of checks) {
      if (check.value !== undefined && check.value !== null) {
        console.log(`✅ ${check.field}: ${JSON.stringify(check.value)}`);
      } else {
        console.log(`❌ ${check.field}: MISSING`);
        allPassed = false;
      }
    }

    console.log('');
    console.log('🆕 New Prompt #8 Fields (may be absent for old users):');
    console.log('');

    const newFields = [
      { field: 'emotionalDrivers', value: prefs.emotionalDrivers },
      { field: 'belovedStories', value: prefs.belovedStories },
      { field: 'readingMotivation', value: prefs.readingMotivation },
      { field: 'discoveryTolerance', value: prefs.discoveryTolerance },
      { field: 'pacePreference', value: prefs.pacePreference }
    ];

    for (const field of newFields) {
      if (field.value !== undefined && field.value !== null) {
        console.log(`✅ ${field.field}: ${JSON.stringify(field.value)}`);
      } else {
        console.log(`⚠️  ${field.field}: Not present (expected for old users)`);
      }
    }

    console.log('');
    if (allPassed) {
      console.log('✅ ALL REQUIRED FIELDS PRESENT');
    } else {
      console.log('❌ SOME REQUIRED FIELDS MISSING');
      process.exit(1);
    }

  } catch (error) {
    console.log('❌ Test failed with error:');
    console.log(error.message);
    console.log(error.stack);
    process.exit(1);
  }
}

testUserPreferences();
