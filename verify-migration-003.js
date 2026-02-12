#!/usr/bin/env node

/**
 * Verify Migration 003: Feedback & Sequel System
 *
 * Checks if the database has all required tables and columns
 * for the feedback and sequel generation system.
 */

require('dotenv').config();
const { supabaseAdmin } = require('./src/config/supabase');

console.log('╔═══════════════════════════════════════════════════╗');
console.log('║   Migration 003 Verification                     ║');
console.log('╚═══════════════════════════════════════════════════╝\n');

async function checkTableExists(tableName) {
  try {
    const { data, error } = await supabaseAdmin
      .from(tableName)
      .select('*')
      .limit(0); // Don't fetch data, just check if table exists

    if (error) {
      if (error.code === '42P01' || error.message.includes('does not exist')) {
        return { exists: false, error: 'Table does not exist' };
      }
      return { exists: false, error: error.message };
    }

    return { exists: true };
  } catch (err) {
    return { exists: false, error: err.message };
  }
}

async function checkColumnExists(tableName, columnName) {
  try {
    const { data, error } = await supabaseAdmin
      .from(tableName)
      .select(columnName)
      .limit(0);

    if (error) {
      if (error.message.includes(`column "${columnName}" does not exist`)) {
        return { exists: false, error: `Column ${columnName} does not exist` };
      }
      return { exists: false, error: error.message };
    }

    return { exists: true };
  } catch (err) {
    return { exists: false, error: err.message };
  }
}

async function verifyMigration() {
  const results = {
    newTables: [],
    newColumns: [],
    missing: [],
    total: 0,
    passed: 0
  };

  console.log('📊 Checking new tables...\n');

  // Check new tables
  const newTables = [
    { name: 'story_feedback', description: 'Checkpoint feedback (Ch 3, 6, 9)' },
    { name: 'book_completion_interviews', description: 'Post-book voice interviews' },
    { name: 'story_series_context', description: 'Sequel continuity data' }
  ];

  for (const table of newTables) {
    results.total++;
    const check = await checkTableExists(table.name);

    if (check.exists) {
      console.log(`✅ ${table.name}`);
      console.log(`   ${table.description}`);
      results.newTables.push(table.name);
      results.passed++;
    } else {
      console.log(`❌ ${table.name} - MISSING`);
      console.log(`   ${check.error}`);
      results.missing.push({ type: 'table', name: table.name });
    }
  }

  console.log('\n📊 Checking new columns in stories table...\n');

  // Check new columns in stories table
  const newColumns = [
    { name: 'series_id', description: 'Links books in same series' },
    { name: 'book_number', description: 'Position in series (1, 2, 3...)' },
    { name: 'parent_story_id', description: 'Previous book reference' }
  ];

  for (const column of newColumns) {
    results.total++;
    const check = await checkColumnExists('stories', column.name);

    if (check.exists) {
      console.log(`✅ stories.${column.name}`);
      console.log(`   ${column.description}`);
      results.newColumns.push(column.name);
      results.passed++;
    } else {
      console.log(`❌ stories.${column.name} - MISSING`);
      console.log(`   ${check.error}`);
      results.missing.push({ type: 'column', table: 'stories', name: column.name });
    }
  }

  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║   SUMMARY                                        ║');
  console.log('╚═══════════════════════════════════════════════════╝\n');

  console.log(`Total checks: ${results.total}`);
  console.log(`Passed: ${results.passed} ✅`);
  console.log(`Failed: ${results.total - results.passed} ❌\n`);

  if (results.missing.length === 0) {
    console.log('🎉 Migration 003 is FULLY APPLIED!\n');
    console.log('All feedback & sequel system tables and columns exist.\n');
    return true;
  } else {
    console.log('⚠️  Migration 003 is NOT FULLY APPLIED\n');
    console.log('Missing components:');
    results.missing.forEach(item => {
      if (item.type === 'table') {
        console.log(`  - Table: ${item.name}`);
      } else {
        console.log(`  - Column: ${item.table}.${item.name}`);
      }
    });
    console.log('\nTo apply migration 003:');
    console.log('1. Connect to your Supabase database');
    console.log('2. Run: database/migrations/003_feedback_and_series.sql\n');
    return false;
  }
}

verifyMigration()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(err => {
    console.error('❌ Fatal error:', err.message);
    console.error('\nMake sure:');
    console.error('- .env file exists with SUPABASE_URL and SUPABASE_SERVICE_KEY');
    console.error('- Database is accessible');
    process.exit(1);
  });
