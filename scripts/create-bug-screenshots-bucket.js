require('dotenv').config();
const { supabaseAdmin } = require('../src/config/supabase');

(async () => {
  try {
    // Check if bucket exists
    const { data: buckets } = await supabaseAdmin.storage.listBuckets();
    const exists = buckets?.some(b => b.name === 'bug-report-screenshots');

    if (exists) {
      console.log('✅ bug-report-screenshots bucket already exists');
      process.exit(0);
    }

    // Create the bucket
    const { error } = await supabaseAdmin.storage.createBucket('bug-report-screenshots', {
      public: false,  // Bug reports should not be publicly accessible
      fileSizeLimit: 10485760  // 10MB limit for screenshots
    });

    if (error) {
      console.error('❌ Failed to create bucket:', error.message);
      process.exit(1);
    }

    console.log('✅ bug-report-screenshots bucket created successfully');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
