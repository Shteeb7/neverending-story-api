const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { anthropic } = require('../config/ai-clients');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /story/select-premise
 * User selects a premise and triggers pre-generation of first chapters
 */
router.post('/select-premise', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { premiseId, customPremise } = req.body;

  if (!premiseId && !customPremise) {
    return res.status(400).json({
      success: false,
      error: 'Either premiseId or customPremise is required'
    });
  }

  // Create new story record
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .insert({
      user_id: userId,
      premise_id: premiseId,
      custom_premise: customPremise,
      status: 'generating',
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  if (storyError) {
    throw new Error(`Failed to create story: ${storyError.message}`);
  }

  // TODO: Trigger background job to pre-generate first 3 chapters
  // For now, we'll simulate this with a status update

  res.json({
    success: true,
    storyId: story.id,
    status: 'generating',
    message: 'Story generation started'
  });
}));

/**
 * GET /story/generation-status/:storyId
 * Check the pre-generation progress
 */
router.get('/generation-status/:storyId', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;

  const { data: story, error } = await supabaseAdmin
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .eq('user_id', userId)
    .single();

  if (error || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  // TODO: Check actual generation progress from background job
  res.json({
    success: true,
    storyId: story.id,
    status: story.status,
    chaptersGenerated: story.chapters_generated || 0,
    totalChapters: story.total_chapters || null,
    progress: story.generation_progress || 0
  });
}));

/**
 * GET /story/:storyId/chapters
 * Retrieve available chapters for a story
 */
router.get('/:storyId/chapters', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;

  // Verify story belongs to user
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('id')
    .eq('id', storyId)
    .eq('user_id', userId)
    .single();

  if (storyError || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  // Fetch all chapters
  const { data: chapters, error: chaptersError } = await supabaseAdmin
    .from('chapters')
    .select('*')
    .eq('story_id', storyId)
    .order('chapter_number', { ascending: true });

  if (chaptersError) {
    throw new Error(`Failed to fetch chapters: ${chaptersError.message}`);
  }

  res.json({
    success: true,
    storyId,
    chapters: chapters || []
  });
}));

/**
 * POST /story/:storyId/generate-next
 * Generate next chapter(s) in the story
 */
router.post('/:storyId/generate-next', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;
  const { count = 1 } = req.body; // Number of chapters to generate

  // Verify story belongs to user
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .eq('user_id', userId)
    .single();

  if (storyError || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  // Get current chapter count
  const { count: chapterCount } = await supabaseAdmin
    .from('chapters')
    .select('*', { count: 'exact', head: true })
    .eq('story_id', storyId);

  const nextChapterNumber = (chapterCount || 0) + 1;

  // TODO: Use Claude API to generate next chapter(s)
  // This should consider:
  // - Previous chapters for continuity
  // - User's reading preferences
  // - Story arc and pacing

  res.json({
    success: true,
    message: `Generating ${count} chapter(s)`,
    nextChapterNumber,
    status: 'generating'
  });
}));

/**
 * POST /story/:storyId/progress
 * Update user's reading position in a story
 */
router.post('/:storyId/progress', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;
  const { chapterId, position, percentComplete } = req.body;

  const { data, error } = await supabaseAdmin
    .from('reading_progress')
    .upsert({
      user_id: userId,
      story_id: storyId,
      chapter_id: chapterId,
      position,
      percent_complete: percentComplete,
      updated_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update progress: ${error.message}`);
  }

  res.json({
    success: true,
    progress: data
  });
}));

/**
 * GET /story/:storyId/current-state
 * Get current reading state (position, available chapters, etc.)
 */
router.get('/:storyId/current-state', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;

  // Get story details
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .eq('user_id', userId)
    .single();

  if (storyError || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  // Get reading progress
  const { data: progress } = await supabaseAdmin
    .from('reading_progress')
    .select('*')
    .eq('story_id', storyId)
    .eq('user_id', userId)
    .single();

  // Get chapter count
  const { count: chapterCount } = await supabaseAdmin
    .from('chapters')
    .select('*', { count: 'exact', head: true })
    .eq('story_id', storyId);

  res.json({
    success: true,
    story,
    progress: progress || null,
    chaptersAvailable: chapterCount || 0
  });
}));

module.exports = router;
