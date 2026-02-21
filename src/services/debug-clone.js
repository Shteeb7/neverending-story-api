/**
 * Debug Account Cloner
 *
 * Creates a temporary debug account seeded with a real user's state.
 * Used to reproduce and verify bug fixes without touching real user data.
 *
 * SAFETY:
 *   - Creates a NEW auth user with a debug email — never touches the source user
 *   - All cloned rows get new UUIDs — no primary key collisions
 *   - cleanup() deletes ALL data for the debug user across every table
 *   - cleanup() refuses to delete accounts that aren't debug clones
 *   - Debug accounts have email pattern: debug-clone-{timestamp}@mythweaver.app
 */

const { supabaseAdmin } = require('../config/supabase');
const crypto = require('crypto');

// Tables that have user_id and can be queried/cloned by user_id
const USER_OWNED_TABLES = [
  'user_preferences',
  'user_writing_preferences',
  'stories',
  'story_bibles',
  'story_premises',
  'generated_premises',
  'story_feedback',
  'reading_progress',
  'reading_sessions',
  'text_chat_sessions',
  'feedback_sessions',
  'series'
];

// Tables that DON'T have user_id — queried by story_id instead
const STORY_OWNED_TABLES = ['story_arcs', 'chapters'];

// Predefined cloning profiles
const CLONE_PROFILES = {
  // For testing story generation, reading, checkpoints
  'story-reading': {
    user_tables: ['user_preferences', 'stories', 'story_bibles', 'story_feedback',
                  'reading_progress', 'reading_sessions', 'text_chat_sessions'],
    story_tables: ['story_arcs', 'chapters']
  },
  // For testing onboarding flow
  'onboarding': {
    user_tables: ['user_preferences', 'story_premises', 'generated_premises'],
    story_tables: []
  },
  // Full account clone
  'full': {
    user_tables: USER_OWNED_TABLES,
    story_tables: STORY_OWNED_TABLES
  }
};

/**
 * Clone a real user's state into a new debug account.
 *
 * @param {string} sourceUserId - The real user's UUID
 * @param {Object} options
 * @param {string} options.profile - Clone profile: 'story-reading' | 'onboarding' | 'full'
 * @param {string} [options.storyId] - If set, only clone data for this specific story
 * @returns {Object} { userId, email, password, storyIdMap, summary }
 */
async function cloneUserState(sourceUserId, options = {}) {
  const { profile: profileName = 'story-reading', storyId = null } = options;

  const profile = CLONE_PROFILES[profileName];
  if (!profile) {
    throw new Error(`Unknown clone profile: ${profileName}. Options: ${Object.keys(CLONE_PROFILES).join(', ')}`);
  }

  const timestamp = Date.now();
  const debugEmail = `debug-clone-${timestamp}@mythweaver.app`;
  const debugPassword = crypto.randomBytes(16).toString('hex');

  console.log(`🧪 [Debug Clone] Starting clone of user ${sourceUserId}`);
  console.log(`🧪 [Debug Clone] Profile: ${profileName}, Story filter: ${storyId || 'all'}`);

  // Step 1: Create debug auth user
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email: debugEmail,
    password: debugPassword,
    email_confirm: true,
    user_metadata: {
      display_name: 'Debug Clone Account',
      is_debug_clone: true,
      source_user_id: sourceUserId,
      cloned_at: new Date().toISOString()
    }
  });

  if (authError) throw new Error(`Failed to create debug user: ${authError.message}`);

  const debugUserId = authData.user.id;
  console.log(`🧪 [Debug Clone] Created debug user: ${debugUserId} (${debugEmail})`);

  // Step 1b: Ensure debug user exists in public.users table (stories FK)
  await supabaseAdmin.from('users').upsert({
    id: debugUserId,
    email: debugEmail,
    created_at: new Date().toISOString()
  }, { onConflict: 'id' });

  // Track ID mappings for FK remapping
  const storyIdMap = {};
  const bibleIdMap = {};
  const arcIdMap = {};
  const seriesIdMap = {};
  const summary = { tables: {}, total_rows: 0 };

  try {
    // Step 2: Clone user-owned tables (have user_id column)
    for (const table of profile.user_tables) {
      const count = await cloneUserTable(table, sourceUserId, debugUserId, {
        storyId, storyIdMap, bibleIdMap, arcIdMap, seriesIdMap
      });
      summary.tables[table] = count;
      summary.total_rows += count;
    }

    // Step 3: Clone story-owned tables (have story_id, NOT user_id)
    // These need to be cloned per-story using the storyIdMap
    for (const table of profile.story_tables) {
      let totalCount = 0;
      for (const [oldStoryId, newStoryId] of Object.entries(storyIdMap)) {
        const count = await cloneStoryTable(table, oldStoryId, newStoryId, {
          bibleIdMap, arcIdMap
        });
        totalCount += count;
      }
      summary.tables[table] = totalCount;
      summary.total_rows += totalCount;
    }

    // Log summary
    for (const [table, count] of Object.entries(summary.tables)) {
      if (count > 0) console.log(`🧪 [Debug Clone] ${table}: ${count} rows`);
    }
    console.log(`🧪 [Debug Clone] ✅ Complete — ${summary.total_rows} total rows cloned`);

    return { userId: debugUserId, email: debugEmail, password: debugPassword, storyIdMap, summary };

  } catch (err) {
    console.error(`🧪 [Debug Clone] ❌ Failed: ${err.message}`);
    await cleanupDebugAccount(debugUserId);
    throw err;
  }
}

/**
 * Clone rows from a user-owned table (has user_id column).
 */
async function cloneUserTable(table, sourceUserId, debugUserId, maps) {
  const { storyId, storyIdMap, bibleIdMap, arcIdMap, seriesIdMap } = maps;

  let query = supabaseAdmin.from(table).select('*').eq('user_id', sourceUserId);

  // Filter by specific story if requested
  if (storyId) {
    if (table === 'stories') {
      query = query.eq('id', storyId);
    } else if (['story_bibles', 'story_feedback', 'reading_progress',
                'reading_sessions', 'text_chat_sessions'].includes(table)) {
      query = query.eq('story_id', storyId);
    }
  }

  const { data: rows, error } = await query;
  if (error || !rows?.length) return 0;

  const clonedRows = rows.map(row => {
    const cloned = { ...row };
    cloned.user_id = debugUserId;

    // Generate new primary key and track mappings
    if (cloned.id && typeof cloned.id === 'string') {
      const oldId = cloned.id;
      const newId = crypto.randomUUID();
      cloned.id = newId;
      if (table === 'stories') storyIdMap[oldId] = newId;
      if (table === 'story_bibles') bibleIdMap[oldId] = newId;
      if (table === 'series') seriesIdMap[oldId] = newId;
    } else if (cloned.id && typeof cloned.id === 'number') {
      delete cloned.id; // let DB auto-assign serial
    }

    // Remap foreign keys
    if (cloned.story_id && storyIdMap[cloned.story_id]) cloned.story_id = storyIdMap[cloned.story_id];
    if (cloned.bible_id && bibleIdMap[cloned.bible_id]) cloned.bible_id = bibleIdMap[cloned.bible_id];
    if (cloned.series_id && seriesIdMap[cloned.series_id]) cloned.series_id = seriesIdMap[cloned.series_id];
    if (cloned.parent_story_id && storyIdMap[cloned.parent_story_id]) {
      cloned.parent_story_id = storyIdMap[cloned.parent_story_id];
    }

    return cloned;
  });

  const { error: insertError } = await supabaseAdmin.from(table).insert(clonedRows);
  if (insertError) {
    console.warn(`🧪 [Debug Clone] ⚠️ ${table}: ${insertError.message}`);
    return 0;
  }
  return clonedRows.length;
}

/**
 * Clone rows from a story-owned table (no user_id — uses story_id).
 */
async function cloneStoryTable(table, oldStoryId, newStoryId, maps) {
  const { bibleIdMap, arcIdMap } = maps;

  const { data: rows, error } = await supabaseAdmin
    .from(table).select('*').eq('story_id', oldStoryId);

  if (error || !rows?.length) return 0;

  const clonedRows = rows.map(row => {
    const cloned = { ...row };
    cloned.story_id = newStoryId;

    // Generate new primary key and track mappings
    if (cloned.id && typeof cloned.id === 'string') {
      const oldId = cloned.id;
      const newId = crypto.randomUUID();
      cloned.id = newId;
      if (table === 'story_arcs') arcIdMap[oldId] = newId;
    } else if (cloned.id && typeof cloned.id === 'number') {
      delete cloned.id;
    }

    // Remap FKs within story tables
    if (cloned.bible_id && bibleIdMap[cloned.bible_id]) cloned.bible_id = bibleIdMap[cloned.bible_id];
    if (cloned.arc_id && arcIdMap[cloned.arc_id]) cloned.arc_id = arcIdMap[cloned.arc_id];

    return cloned;
  });

  const { error: insertError } = await supabaseAdmin.from(table).insert(clonedRows);
  if (insertError) {
    console.warn(`🧪 [Debug Clone] ⚠️ ${table}: ${insertError.message}`);
    return 0;
  }
  return clonedRows.length;
}

/**
 * Delete ALL data for a debug account and remove the auth user.
 * SAFETY: Refuses to delete non-debug accounts.
 */
async function cleanupDebugAccount(debugUserId) {
  console.log(`🧪 [Debug Cleanup] Removing all data for user ${debugUserId}`);

  // Verify this is actually a debug account
  const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.getUserById(debugUserId);
  if (authError) return { success: false, reason: 'user_not_found' };

  const isDebug = authUser?.user?.user_metadata?.is_debug_clone === true
    || authUser?.user?.email?.startsWith('debug-clone-');

  if (!isDebug) {
    console.error(`🧪 [Debug Cleanup] ❌ SAFETY: ${debugUserId} is NOT a debug clone! Aborting.`);
    return { success: false, reason: 'not_a_debug_account' };
  }

  // Get all story IDs for this user (needed for story-owned tables)
  const { data: stories } = await supabaseAdmin
    .from('stories').select('id').eq('user_id', debugUserId);
  const storyIds = (stories || []).map(s => s.id);

  // Delete story-owned tables first (no user_id column)
  for (const storyId of storyIds) {
    for (const table of STORY_OWNED_TABLES) {
      await supabaseAdmin.from(table).delete().eq('story_id', storyId);
    }
  }

  // Delete user-owned tables
  const deletionOrder = [
    'reading_progress', 'reading_sessions', 'chapter_reading_stats',
    'story_feedback', 'feedback_sessions', 'text_chat_sessions',
    'story_bibles', 'stories', 'story_premises', 'generated_premises',
    'premise_discards', 'user_writing_preferences', 'user_preferences',
    'series', 'bug_reports', 'deletion_requests', 'error_events',
    'api_costs', 'cost_tracking'
  ];

  let totalDeleted = 0;
  for (const table of deletionOrder) {
    try {
      const { data } = await supabaseAdmin
        .from(table).delete().eq('user_id', debugUserId).select('id');
      if (data?.length) {
        totalDeleted += data.length;
        console.log(`🧪 [Debug Cleanup] ${table}: ${data.length} rows`);
      }
    } catch (e) { /* table might not exist or have no data */ }
  }

  // Delete from public.users
  await supabaseAdmin.from('users').delete().eq('id', debugUserId);

  // Delete auth user
  const { error: deleteErr } = await supabaseAdmin.auth.admin.deleteUser(debugUserId);
  if (deleteErr) console.error(`🧪 [Debug Cleanup] Auth delete failed: ${deleteErr.message}`);

  console.log(`🧪 [Debug Cleanup] ✅ Complete — ${totalDeleted} rows + auth user removed`);
  return { success: true, rows_deleted: totalDeleted };
}

module.exports = { cloneUserState, cleanupDebugAccount, CLONE_PROFILES };
