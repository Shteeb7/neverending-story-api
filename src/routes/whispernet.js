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

  // Fetch whispernet_library records with story details and sender info
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
      ),
      sender:shared_by (
        id,
        user_preferences!inner (
          whispernet_display_name
        )
      )
    `)
    .eq('user_id', userId)
    .order('added_at', { ascending: false });

  if (error) {
    console.error('Failed to fetch WhisperNet library:', error);
    throw new Error(`Failed to fetch WhisperNet library: ${error.message}`);
  }

  // Transform the data to match the expected format
  const stories = whispernetBooks.map(entry => {
    const story = entry.stories;
    const senderDisplayName = entry.sender?.user_preferences?.whispernet_display_name;

    return {
      ...story,
      // Add WhisperNet-specific metadata
      whispernet_metadata: {
        library_id: entry.id,
        source: entry.source,
        shared_by: entry.shared_by,
        sender_display_name: senderDisplayName || 'A Fellow Reader',
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
