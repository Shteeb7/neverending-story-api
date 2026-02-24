const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /share-links
 * Generate a share link for a story
 */
router.post('/', authenticateUser, asyncHandler(async (req, res) => {
  const { story_id } = req.body;
  const { userId } = req;

  if (!story_id) {
    return res.status(400).json({
      success: false,
      error: 'story_id is required'
    });
  }

  // Verify story exists and belongs to user
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('id, title, user_id')
    .eq('id', story_id)
    .eq('user_id', userId)
    .single();

  if (storyError || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found or you do not have permission to share it'
    });
  }

  // Create share link with 7-day expiry
  const { data: shareLink, error: createError } = await supabaseAdmin
    .from('share_links')
    .insert({
      story_id,
      sender_id: userId
    })
    .select('id, token, expires_at')
    .single();

  if (createError) {
    console.error('Failed to create share link:', createError);
    throw new Error(`Failed to create share link: ${createError.message}`);
  }

  const share_url = `https://themythweaver.com/share/${shareLink.token}`;

  console.log(`📤 Share link created for story "${story.title}" by user ${userId}`);

  res.json({
    success: true,
    token: shareLink.token,
    share_url,
    expires_at: shareLink.expires_at
  });
}));

/**
 * POST /share-links/:token/claim
 * Claim a share link
 */
router.post('/:token/claim', authenticateUser, asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { userId } = req;

  // Fetch share link with story details
  const { data: shareLink, error: fetchError } = await supabaseAdmin
    .from('share_links')
    .select(`
      id,
      token,
      story_id,
      sender_id,
      expires_at,
      claimed_by,
      claimed_at,
      stories:story_id (
        id,
        title,
        genre,
        cover_image_url
      )
    `)
    .eq('token', token)
    .single();

  if (fetchError || !shareLink) {
    return res.status(404).json({
      success: false,
      error: 'Share link not found'
    });
  }

  // Validate: not expired
  if (new Date(shareLink.expires_at) < new Date()) {
    return res.status(400).json({
      success: false,
      error: 'This share link has expired'
    });
  }

  // Validate: not already claimed
  if (shareLink.claimed_by) {
    return res.status(400).json({
      success: false,
      error: 'This share link has already been claimed'
    });
  }

  // Validate: claimer is not sender
  if (shareLink.sender_id === userId) {
    return res.status(400).json({
      success: false,
      error: 'You cannot claim your own share link'
    });
  }

  // Check if book is already on user's WhisperNet shelf (CLAUDE.md Rule 3: prevent duplicate entries)
  const { data: existing, error: checkError } = await supabaseAdmin
    .from('whispernet_library')
    .select('id')
    .eq('user_id', userId)
    .eq('story_id', shareLink.story_id)
    .maybeSingle();

  if (checkError) {
    console.error('Failed to check for existing library entry:', checkError);
    throw new Error(`Failed to check library: ${checkError.message}`);
  }

  if (existing) {
    return res.status(400).json({
      success: false,
      error: 'This book is already in your WhisperNet library'
    });
  }

  // Add to WhisperNet library
  const { error: libraryError } = await supabaseAdmin
    .from('whispernet_library')
    .insert({
      user_id: userId,
      story_id: shareLink.story_id,
      source: 'shared',
      shared_by: shareLink.sender_id,
      seen: false
    });

  if (libraryError) {
    console.error('Failed to add to library:', libraryError);
    throw new Error(`Failed to add book to library: ${libraryError.message}`);
  }

  // Update share link as claimed
  const { error: updateError } = await supabaseAdmin
    .from('share_links')
    .update({
      claimed_by: userId,
      claimed_at: new Date().toISOString()
    })
    .eq('id', shareLink.id);

  if (updateError) {
    console.error('Failed to update share link:', updateError);
    // Non-fatal - book is already added to library
  }

  console.log(`📥 Share link claimed: "${shareLink.stories.title}" sent to user ${userId}`);

  res.json({
    success: true,
    story_id: shareLink.story_id,
    title: shareLink.stories.title,
    message: 'Story added to your WhisperNet shelf'
  });
}));

/**
 * GET /share-links/mine
 * List all share links created by the authenticated user
 */
router.get('/mine', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;

  const { data: shareLinks, error } = await supabaseAdmin
    .from('share_links')
    .select(`
      id,
      token,
      created_at,
      expires_at,
      claimed_by,
      claimed_at,
      stories:story_id (
        id,
        title,
        cover_image_url
      )
    `)
    .eq('sender_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch share links: ${error.message}`);
  }

  // Add status field to each link
  const now = new Date();
  const linksWithStatus = shareLinks.map(link => {
    let status;
    if (link.claimed_by) {
      status = 'claimed';
    } else if (new Date(link.expires_at) < now) {
      status = 'expired';
    } else {
      status = 'active';
    }

    return {
      ...link,
      status,
      share_url: `https://themythweaver.com/share/${link.token}`
    };
  });

  res.json({
    success: true,
    share_links: linksWithStatus
  });
}));

module.exports = router;
