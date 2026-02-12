require('dotenv').config();
const { supabaseAdmin } = require('./src/config/supabase');

async function checkSchema() {
  console.log('🔍 Querying actual database schema from Supabase...\n');

  // Get columns for story_bibles table
  const { data: bibleColumns, error: bibleError } = await supabaseAdmin
    .from('information_schema.columns')
    .select('column_name, is_nullable, data_type, column_default')
    .eq('table_name', 'story_bibles')
    .eq('table_schema', 'public');

  if (bibleError) {
    console.error('Error querying story_bibles schema:', bibleError);
  } else {
    console.log('📖 story_bibles table columns:');
    bibleColumns.forEach(col => {
      const nullable = col.is_nullable === 'NO' ? '❌ NOT NULL' : '✅ nullable';
      console.log(`   ${col.column_name.padEnd(25)} ${col.data_type.padEnd(20)} ${nullable}`);
    });
  }

  // Get columns for stories table
  const { data: storyColumns, error: storyError } = await supabaseAdmin
    .from('information_schema.columns')
    .select('column_name, is_nullable, data_type, column_default')
    .eq('table_name', 'stories')
    .eq('table_schema', 'public');

  if (storyError) {
    console.error('\nError querying stories schema:', storyError);
  } else {
    console.log('\n📚 stories table columns:');
    storyColumns.forEach(col => {
      const nullable = col.is_nullable === 'NO' ? '❌ NOT NULL' : '✅ nullable';
      console.log(`   ${col.column_name.padEnd(25)} ${col.data_type.padEnd(20)} ${nullable}`);
    });
  }

  // Check for CHECK constraints
  const { data: constraints, error: constraintError } = await supabaseAdmin
    .from('information_schema.check_constraints')
    .select('constraint_name, check_clause')
    .eq('constraint_schema', 'public');

  if (!constraintError && constraints) {
    console.log('\n🔒 CHECK constraints:');
    constraints.forEach(c => {
      console.log(`   ${c.constraint_name}:`);
      console.log(`      ${c.check_clause}`);
    });
  }
}

checkSchema()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
