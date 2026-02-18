const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /library/:userId
 * Get all stories for a user
 */
router.get('/:userId', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req.params;

  // Verify requesting user matches or is admin (case-insensitive UUID comparison)
  if (req.userId.toLowerCase() !== userId.toLowerCase()) {
    console.log('User ID mismatch:', { reqUserId: req.userId, paramUserId: userId });
    return res.status(403).json({
      success: false,
      error: 'Unauthorized access'
    });
  }

  // Fetch all stories for user with series names
  const { data: stories, error } = await supabaseAdmin
    .from('stories')
    .select('*, series:series_id(name)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch library: ${error.message}`);
  }

  // Fetch chapter counts for each story and flatten series data
  const storiesWithCounts = await Promise.all(
    (stories || []).map(async (story) => {
      const { count } = await supabaseAdmin
        .from('chapters')
        .select('*', { count: 'exact', head: true })
        .eq('story_id', story.id);

      return {
        ...story,
        chapterCount: count || 0,
        series_name: story.series?.name || null
      };
    })
  );

  res.json({
    success: true,
    stories: storiesWithCounts
  });
}));

/**
 * PUT /story/:storyId/archive
 * Archive a story (soft delete)
 */
router.put('/:storyId/archive', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;

  // Verify story belongs to user
  const { data: story, error: verifyError } = await supabaseAdmin
    .from('stories')
    .select('id')
    .eq('id', storyId)
    .eq('user_id', userId)
    .single();

  if (verifyError || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  // Archive the story (soft delete by setting status)
  const { data, error } = await supabaseAdmin
    .from('stories')
    .update({
      status: 'archived',
      updated_at: new Date().toISOString()
    })
    .eq('id', storyId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to archive story: ${error.message}`);
  }

  res.json({
    success: true,
    story: data,
    message: 'Story archived successfully'
  });
}));

/**
 * DELETE /story/:storyId
 * Permanently delete a story and all associated data
 */
router.delete('/:storyId', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;

  // Verify story belongs to user
  const { data: story, error: verifyError } = await supabaseAdmin
    .from('stories')
    .select('id')
    .eq('id', storyId)
    .eq('user_id', userId)
    .single();

  if (verifyError || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  // Delete associated data (cascading deletes should handle this, but being explicit)
  await supabaseAdmin.from('chapters').delete().eq('story_id', storyId);
  await supabaseAdmin.from('feedback').delete().eq('story_id', storyId);

  // Delete the story
  const { error } = await supabaseAdmin
    .from('stories')
    .delete()
    .eq('id', storyId);

  if (error) {
    throw new Error(`Failed to delete story: ${error.message}`);
  }

  res.json({
    success: true,
    message: 'Story deleted successfully'
  });
}));

module.exports = router;
