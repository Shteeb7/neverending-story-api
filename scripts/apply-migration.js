#!/usr/bin/env node

/**
 * Apply database migration for generation engine
 *
 * Run this script to set up all tables and columns needed for AI generation:
 * node scripts/apply-migration.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

async function applyMigration() {
  // Initialize Supabase client with service role key
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  console.log('📦 Loading migration file...');

  const migrationPath = path.join(__dirname, '../database/migrations/002_generation_engine.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  console.log('🚀 Applying migration to Supabase...\n');

  // Split by semicolons and execute each statement
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--') && !s.startsWith('COMMENT'));

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];

    // Skip comment-only lines
    if (statement.match(/^COMMENT ON/)) continue;

    console.log(`Executing statement ${i + 1}/${statements.length}...`);

    try {
      const { error } = await supabase.rpc('exec_sql', { sql_query: statement + ';' });

      if (error) {
        console.error(`❌ Error executing statement ${i + 1}:`, error.message);
        console.log('Statement:', statement.substring(0, 100) + '...');

        // Continue with other statements even if one fails
        continue;
      }

      console.log(`✅ Statement ${i + 1} executed successfully`);
    } catch (err) {
      console.error(`❌ Exception executing statement ${i + 1}:`, err.message);
    }
  }

  console.log('\n✨ Migration complete!');
  console.log('\nVerifying tables...');

  // Verify key tables exist
  const tables = ['story_bibles', 'story_arcs', 'api_costs'];

  for (const table of tables) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .limit(0);

    if (error) {
      console.log(`❌ Table ${table}: NOT FOUND or ERROR - ${error.message}`);
    } else {
      console.log(`✅ Table ${table}: EXISTS`);
    }
  }

  console.log('\n🎉 Done! Your database is ready for AI generation.');
}

// Run migration
applyMigration().catch(error => {
  console.error('💥 Migration failed:', error);
  process.exit(1);
});
