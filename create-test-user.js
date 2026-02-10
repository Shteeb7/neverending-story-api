require('dotenv').config();
const { supabaseAdmin } = require('./src/config/supabase');

async function createTestUser() {
  console.log('🔧 Creating test user...\n');

  try {
    // Create a test user using admin API
    const { data: user, error } = await supabaseAdmin.auth.admin.createUser({
      email: 'test@neverendingstory.com',
      password: 'test-password-123',
      email_confirm: true,
      user_metadata: {
        name: 'Test User',
        has_completed_onboarding: false
      }
    });

    if (error) {
      // User might already exist, try to get them
      if (error.message.includes('already registered')) {
        console.log('ℹ️  User already exists, fetching...');

        const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers();

        if (listError) {
          throw listError;
        }

        const existingUser = users.find(u => u.email === 'test@neverendingstory.com');

        if (existingUser) {
          console.log('✅ Found existing test user:');
          console.log(`   ID: ${existingUser.id}`);
          console.log(`   Email: ${existingUser.email}`);
          console.log(`   Created: ${existingUser.created_at}`);

          // Generate session token
          const { data: session, error: sessionError } = await supabaseAdmin.auth.admin.generateLink({
            type: 'magiclink',
            email: existingUser.email
          });

          if (sessionError) {
            console.log('\n⚠️  Could not generate session token:', sessionError.message);
          }

          return existingUser;
        }
      }

      throw error;
    }

    console.log('✅ Test user created successfully:');
    console.log(`   ID: ${user.user.id}`);
    console.log(`   Email: ${user.user.email}`);
    console.log(`   Created: ${user.user.created_at}`);

    return user.user;
  } catch (err) {
    console.error('❌ Error creating test user:', err.message);
    throw err;
  }
}

createTestUser()
  .then(user => {
    console.log('\n📝 To use this user in API tests, you need to:');
    console.log('   1. Get a JWT token by signing in');
    console.log('   2. Use the token in Authorization: Bearer <token>');
    console.log(`   3. User ID: ${user.id}`);
    process.exit(0);
  })
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
