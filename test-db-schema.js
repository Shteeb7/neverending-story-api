require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function checkDatabaseSchema() {
  console.log('🔍 Checking Database Schema...\n');

  const tables = [
    'user_preferences',
    'story_premises',
    'stories',
    'story_bibles',
    'story_arcs',
    'chapters',
    'api_costs',
    'reading_progress',
    'feedback',
    'feedback_sessions'
  ];

  const results = {
    existing: [],
    missing: [],
    errors: []
  };

  for (const table of tables) {
    try {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .limit(1);

      if (error) {
        if (error.message.includes('does not exist') || error.code === '42P01') {
          results.missing.push(table);
          console.log(`❌ ${table} - NOT FOUND`);
        } else {
          results.errors.push({ table, error: error.message });
          console.log(`⚠️  ${table} - ERROR: ${error.message}`);
        }
      } else {
        results.existing.push(table);
        console.log(`✅ ${table} - EXISTS`);
      }
    } catch (err) {
      results.errors.push({ table, error: err.message });
      console.log(`⚠️  ${table} - ERROR: ${err.message}`);
    }
  }

  console.log('\n📊 SUMMARY:');
  console.log(`✅ Existing tables: ${results.existing.length}`);
  console.log(`❌ Missing tables: ${results.missing.length}`);
  console.log(`⚠️  Errors: ${results.errors.length}`);

  if (results.missing.length > 0) {
    console.log('\n❌ Missing tables:');
    results.missing.forEach(t => console.log(`   - ${t}`));
  }

  if (results.errors.length > 0) {
    console.log('\n⚠️  Errors encountered:');
    results.errors.forEach(e => console.log(`   - ${e.table}: ${e.error}`));
  }

  return results;
}

checkDatabaseSchema()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
