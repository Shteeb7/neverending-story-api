/**
 * Build initial codebase context package
 * Calls POST /admin/build-context with admin authentication
 */

require('dotenv').config();
const { supabaseAdmin } = require('../src/config/supabase');

async function buildInitialContext() {
  console.log('🔨 Building initial codebase context package...\n');

  try {
    // Call the service directly (no HTTP auth needed for script)
    const { buildCodebaseContext } = require('../src/services/codebase-context');

    console.log('📦 Calling buildCodebaseContext service...\n');
    const result = await buildCodebaseContext();

    if (result.success) {
      console.log('✅ Context package built successfully!\n');
      console.log(`   Size: ${(result.size_bytes / 1024).toFixed(2)}KB`);
      console.log(`   Files: ${result.file_count}`);
      console.log(`   Built at: ${result.built_at}\n`);

      // Verify the file exists in Storage
      console.log('🔍 Verifying latest.json exists in codebase-context bucket...');

      const { data: fileData, error: downloadError } = await supabaseAdmin
        .storage
        .from('codebase-context')
        .download('latest.json');

      if (downloadError) {
        console.error('❌ Failed to verify file:', downloadError.message);
        process.exit(1);
      }

      console.log(`✅ File verified! Size: ${(fileData.size / 1024).toFixed(2)}KB\n`);

      // Parse and show summary
      const content = await fileData.text();
      const parsed = JSON.parse(content);

      console.log('📊 Context package summary:');
      console.log(`   Categories: ${Object.keys(parsed.categories).length}`);
      console.log(`   Always-included files: ${parsed.always_included.files.length}`);
      console.log(`   Schema tables: ${Object.keys(parsed.schema.tables).length}`);
      console.log(`   Rules (CLAUDE.md): ${parsed.rules.length} chars\n`);

      console.log('✅ Prerequisite 1 complete: Context package ready!');
      process.exit(0);
    } else {
      console.error('❌ Context build failed:', result.message || result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

buildInitialContext();
