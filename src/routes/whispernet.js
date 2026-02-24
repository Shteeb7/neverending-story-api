const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /whispernet/library
 * Get all WhisperNet books for the authenticated user
 */
router.get('/library', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;

  // Fetch whispernet_library records with story details
  const { data: whispernetBooks, error } = await supabaseAdmin
    .from('whispernet_library')
    .select(`
      id,
      story_id,
      source,
      shared_by,
      added_at,
      seen,
      stories:story_id (
        id,
        user_id,
        title,
        genre,
        premise,
        status,
        current_chapter,
        created_at,
        last_read_at,
        total_read_time,
        bible_id,
        generation_progress,
        error_message,
        premise_id,
        current_arc_id,
        series_id,
        book_number,
        parent_story_id,
        cover_image_url,
        premise_tier,
        generation_config,
        archived_at,
        whispernet_published,
        maturity_rating
      )
    `)
    .eq('user_id', userId)
    .order('added_at', { ascending: false });

  if (error) {
    console.error('Failed to fetch WhisperNet library:', error);
    throw new Error(`Failed to fetch WhisperNet library: ${error.message}`);
  }

  // Collect unique sender IDs (shared_by values that are not null)
  const senderIds = [...new Set(
    whispernetBooks
      .map(entry => entry.shared_by)
      .filter(id => id !== null)
  )];

  // Fetch sender display names in a separate query
  let senderDisplayNames = {};
  if (senderIds.length > 0) {
    const { data: senderPrefs, error: senderError } = await supabaseAdmin
      .from('user_preferences')
      .select('user_id, whispernet_display_name')
      .in('user_id', senderIds);

    if (senderError) {
      console.error('Failed to fetch sender preferences:', senderError);
      // Continue with empty map - will use fallback names
    } else if (senderPrefs) {
      // Build lookup map
      senderDisplayNames = senderPrefs.reduce((acc, pref) => {
        acc[pref.user_id] = pref.whispernet_display_name;
        return acc;
      }, {});
    }
  }

  // Transform the data to match the expected format
  const stories = whispernetBooks.map(entry => {
    const story = entry.stories;
    const senderDisplayName = entry.shared_by
      ? (senderDisplayNames[entry.shared_by] || 'A Fellow Reader')
      : 'A Fellow Reader';

    return {
      ...story,
      // Add WhisperNet-specific metadata
      whispernet_metadata: {
        library_id: entry.id,
        source: entry.source,
        shared_by: entry.shared_by,
        sender_display_name: senderDisplayName,
        added_at: entry.added_at,
        seen: entry.seen
      }
    };
  });

  res.json({
    success: true,
    stories
  });
}));

/**
 * GET /whispernet/library/check?user_id=X&story_id=Y
 * Check if a book is already on the user's WhisperNet shelf
 */
router.get('/library/check', authenticateUser, asyncHandler(async (req, res) => {
  const { user_id, story_id } = req.query;
  const { userId } = req;

  // Verify user can only check their own shelf
  if (user_id !== userId) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden'
    });
  }

  if (!story_id) {
    return res.status(400).json({
      success: false,
      error: 'story_id required'
    });
  }

  const { data: entry, error } = await supabaseAdmin
    .from('whispernet_library')
    .select('id')
    .eq('user_id', userId)
    .eq('story_id', story_id)
    .maybeSingle();

  if (error) {
    console.error('Error checking shelf:', error);
    throw new Error(`Failed to check shelf: ${error.message}`);
  }

  res.json({
    success: true,
    exists: !!entry
  });
}));

/**
 * POST /whispernet/library
 * Add a book to the user's WhisperNet shelf
 */
router.post('/library', authenticateUser, asyncHandler(async (req, res) => {
  const { user_id, story_id, source } = req.body;
  const { userId } = req;

  // Verify user can only add to their own shelf
  if (user_id !== userId) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden'
    });
  }

  if (!story_id || !source) {
    return res.status(400).json({
      success: false,
      error: 'story_id and source required'
    });
  }

  // Validate source
  if (!['shared', 'browsed'].includes(source)) {
    return res.status(400).json({
      success: false,
      error: 'source must be "shared" or "browsed"'
    });
  }

  // Check if already exists (prevent duplicates per CLAUDE.md Rule 3)
  const { data: existing, error: checkError } = await supabaseAdmin
    .from('whispernet_library')
    .select('id')
    .eq('user_id', userId)
    .eq('story_id', story_id)
    .maybeSingle();

  if (checkError) {
    console.error('Error checking for existing entry:', checkError);
    throw new Error(`Failed to check for existing entry: ${checkError.message}`);
  }

  if (existing) {
    return res.status(409).json({
      success: false,
      error: 'Book already on shelf'
    });
  }

  // Insert new entry
  const { error: insertError } = await supabaseAdmin
    .from('whispernet_library')
    .insert({
      user_id: userId,
      story_id,
      source,
      shared_by: source === 'shared' ? req.body.shared_by : null,
      seen: true // Mark as seen immediately for browsed books
    });

  if (insertError) {
    console.error('Error adding to shelf:', insertError);
    throw new Error(`Failed to add to shelf: ${insertError.message}`);
  }

  res.json({
    success: true,
    message: 'Added to WhisperNet shelf'
  });
}));

/**
 * PUT /whispernet/library/:libraryId/mark-seen
 * Mark a WhisperNet book as seen (after entrance animation)
 */
router.put('/library/:libraryId/mark-seen', authenticateUser, asyncHandler(async (req, res) => {
  const { libraryId } = req.params;
  const { userId } = req;

  // Verify the library entry belongs to the user
  const { data: entry, error: verifyError } = await supabaseAdmin
    .from('whispernet_library')
    .select('id')
    .eq('id', libraryId)
    .eq('user_id', userId)
    .single();

  if (verifyError || !entry) {
    return res.status(404).json({
      success: false,
      error: 'Library entry not found'
    });
  }

  // Update seen flag
  const { error: updateError } = await supabaseAdmin
    .from('whispernet_library')
    .update({ seen: true })
    .eq('id', libraryId);

  if (updateError) {
    throw new Error(`Failed to mark as seen: ${updateError.message}`);
  }

  res.json({
    success: true,
    message: 'Marked as seen'
  });
}));

module.exports = router;
