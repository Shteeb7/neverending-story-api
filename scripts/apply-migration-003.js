#!/usr/bin/env node

/**
 * Apply Migration 003: Feedback & Sequel System
 *
 * Run this script to add tables and columns for the feedback and sequel system:
 * node scripts/apply-migration-003.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

async function applyMigration() {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║   Applying Migration 003: Feedback & Sequels     ║');
  console.log('╚═══════════════════════════════════════════════════╝\n');

  // Initialize Supabase client with service role key
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  console.log('📦 Loading migration file...');

  const migrationPath = path.join(__dirname, '../database/migrations/003_feedback_and_series.sql');

  if (!fs.existsSync(migrationPath)) {
    console.error('❌ Migration file not found:', migrationPath);
    process.exit(1);
  }

  const sql = fs.readFileSync(migrationPath, 'utf8');

  console.log('✅ Migration file loaded');
  console.log('🚀 Applying migration to Supabase...\n');

  // Split by semicolons and execute each statement
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  console.log(`Found ${statements.length} SQL statements to execute\n`);

  let successCount = 0;
  let errorCount = 0;
  const errors = [];

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];

    // Skip COMMENT statements (they often fail via RPC)
    if (statement.match(/^COMMENT ON/i)) {
      console.log(`⏭️  Skipping statement ${i + 1}: COMMENT (not critical)`);
      continue;
    }

    console.log(`⚙️  Executing statement ${i + 1}/${statements.length}...`);

    // Show preview of statement
    const preview = statement.substring(0, 80).replace(/\s+/g, ' ');
    console.log(`   ${preview}${statement.length > 80 ? '...' : ''}`);

    try {
      const { error } = await supabase.rpc('exec_sql', { sql_query: statement + ';' });

      if (error) {
        console.log(`   ❌ Error: ${error.message}\n`);
        errorCount++;
        errors.push({ statement: i + 1, error: error.message, sql: preview });

        // Continue with other statements (some errors are acceptable like "already exists")
        continue;
      }

      console.log(`   ✅ Success\n`);
      successCount++;
    } catch (err) {
      console.log(`   ❌ Exception: ${err.message}\n`);
      errorCount++;
      errors.push({ statement: i + 1, error: err.message, sql: preview });
    }
  }

  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║   Migration Summary                              ║');
  console.log('╚═══════════════════════════════════════════════════╝\n');

  console.log(`✅ Successful: ${successCount}`);
  console.log(`❌ Errors: ${errorCount}\n`);

  if (errors.length > 0) {
    console.log('⚠️  Errors encountered (may be non-critical):');
    errors.forEach(err => {
      console.log(`   ${err.statement}. ${err.error}`);
    });
    console.log('');
  }

  console.log('🔍 Verifying tables...\n');

  // Verify key tables exist
  const tables = [
    { name: 'story_feedback', description: 'Checkpoint feedback' },
    { name: 'book_completion_interviews', description: 'Post-book interviews' },
    { name: 'story_series_context', description: 'Sequel continuity' }
  ];

  let allTablesExist = true;

  for (const table of tables) {
    const { data, error } = await supabase
      .from(table.name)
      .select('*')
      .limit(0);

    if (error) {
      console.log(`❌ ${table.name}: ${error.message}`);
      allTablesExist = false;
    } else {
      console.log(`✅ ${table.name} (${table.description})`);
    }
  }

  console.log('\n🔍 Verifying new columns in stories table...\n');

  const columns = ['series_id', 'book_number', 'parent_story_id'];
  let allColumnsExist = true;

  for (const column of columns) {
    const { data, error } = await supabase
      .from('stories')
      .select(column)
      .limit(0);

    if (error) {
      console.log(`❌ stories.${column}: ${error.message}`);
      allColumnsExist = false;
    } else {
      console.log(`✅ stories.${column}`);
    }
  }

  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║   Result                                         ║');
  console.log('╚═══════════════════════════════════════════════════╝\n');

  if (allTablesExist && allColumnsExist) {
    console.log('🎉 Migration 003 SUCCESSFULLY APPLIED!\n');
    console.log('Your database now supports:');
    console.log('  ✅ Reader feedback at checkpoints');
    console.log('  ✅ Post-book voice interviews');
    console.log('  ✅ Unlimited sequels with continuity\n');
    process.exit(0);
  } else {
    console.log('⚠️  Migration PARTIALLY applied or failed\n');
    console.log('Some tables or columns may be missing.');
    console.log('Try applying the migration manually via Supabase Dashboard.\n');
    process.exit(1);
  }
}

// Run migration
applyMigration().catch(error => {
  console.error('\n💥 Migration failed:', error.message);
  console.error('\nPossible solutions:');
  console.error('1. Check your .env file has valid SUPABASE_URL and SUPABASE_SERVICE_KEY');
  console.error('2. Verify the service role key has sufficient permissions');
  console.error('3. Apply migration manually via Supabase Dashboard SQL Editor\n');
  process.exit(1);
});
