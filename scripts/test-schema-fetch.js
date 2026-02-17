/**
 * Test script to verify get_public_schema_info() function works
 * Run with: node scripts/test-schema-fetch.js
 */

require('dotenv').config();
const { supabaseAdmin } = require('../src/config/supabase');

async function testSchemaFetch() {
  console.log('🧪 Testing get_public_schema_info() function...\n');

  try {
    const { data, error } = await supabaseAdmin.rpc('get_public_schema_info');

    if (error) {
      console.error('❌ Error calling get_public_schema_info():', error.message);
      process.exit(1);
    }

    console.log(`✅ Function call successful! Retrieved ${data.length} columns\n`);

    // Filter to target tables
    const targetTables = [
      'bug_reports',
      'chapters',
      'stories',
      'error_events',
      'story_arcs',
      'story_bibles',
      'reading_sessions',
      'reading_heartbeats',
      'user_preferences'
    ];

    const filtered = data.filter(row => targetTables.includes(row.table_name));

    // Group by table
    const byTable = {};
    filtered.forEach(row => {
      if (!byTable[row.table_name]) {
        byTable[row.table_name] = [];
      }
      byTable[row.table_name].push(row.column_name);
    });

    console.log('📊 Schema summary for target tables:\n');
    Object.entries(byTable).forEach(([table, columns]) => {
      console.log(`  ${table}: ${columns.length} columns`);
    });

    console.log('\n✅ All 9 target tables found:', Object.keys(byTable).length === 9);

    // Sample a few columns from bug_reports
    console.log('\n📝 Sample columns from bug_reports:');
    const bugReportColumns = filtered
      .filter(r => r.table_name === 'bug_reports')
      .slice(0, 5)
      .map(r => `  - ${r.column_name} (${r.data_type})`);
    console.log(bugReportColumns.join('\n'));

    console.log('\n✅ Schema fetch test passed!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed:', err.message);
    process.exit(1);
  }
}

testSchemaFetch();
