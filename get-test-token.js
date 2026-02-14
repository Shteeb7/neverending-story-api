/**
 * Generate a test access token for the specified user
 */
const { supabaseAdmin } = require('./src/config/supabase');

const userId = 'a3f8818e-2ffe-4d61-bfbe-7f96d1d78a7b';

async function getAccessToken() {
  try {
    console.log('🔐 Fetching access token for user:', userId);
    
    // Get user from auth
    const { data: { user }, error: userError } = await supabaseAdmin.auth.admin.getUserById(userId);
    
    if (userError || !user) {
      console.error('❌ Failed to get user:', userError?.message || 'User not found');
      process.exit(1);
    }
    
    console.log('✅ User found:', user.email);
    
    // Generate a session for the user
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: user.email,
      options: {
        redirectTo: 'https://mythweaver.app'
      }
    });
    
    if (error) {
      console.error('❌ Failed to generate link:', error.message);
      process.exit(1);
    }
    
    // Extract the access token from the generated link
    const url = new URL(data.properties.action_link);
    const accessToken = url.searchParams.get('access_token');
    
    if (!accessToken) {
      console.error('❌ No access token in generated link');
      process.exit(1);
    }
    
    console.log('');
    console.log('✅ Access token generated!');
    console.log('');
    console.log('Run the test with:');
    console.log(`export TEST_ACCESS_TOKEN="${accessToken}"`);
    console.log('node test-returning-user-data.js');
    
    return accessToken;
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

getAccessToken();
