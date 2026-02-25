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
  const { story_id, parent_link_id } = req.body;
  const { userId } = req;

  if (!story_id) {
    return res.status(400).json({
      success: false,
      error: 'story_id is required'
    });
  }

  // Verify story exists and belongs to user OR is in user's WhisperNet library
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('id, title, user_id')
    .eq('id', story_id)
    .single();

  if (storyError || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  // Check if user owns the story OR has it in their WhisperNet library
  const isOwner = story.user_id === userId;
  const { data: libraryEntry } = await supabaseAdmin
    .from('whispernet_library')
    .select('id')
    .eq('user_id', userId)
    .eq('story_id', story_id)
    .maybeSingle();

  if (!isOwner && !libraryEntry) {
    return res.status(403).json({
      success: false,
      error: 'You do not have permission to share this story'
    });
  }

  // Compute share chain depth
  let shareChainDepth = 0;
  if (parent_link_id) {
    // Fetch parent link to get its depth
    const { data: parentLink, error: parentError } = await supabaseAdmin
      .from('share_links')
      .select('share_chain_depth')
      .eq('id', parent_link_id)
      .single();

    if (parentError || !parentLink) {
      console.warn(`Parent link ${parent_link_id} not found, using depth 0`);
    } else {
      shareChainDepth = (parentLink.share_chain_depth || 0) + 1;
    }
  }

  // Create share link with 7-day expiry and chain tracking
  const { data: shareLink, error: createError} = await supabaseAdmin
    .from('share_links')
    .insert({
      story_id,
      sender_id: userId,
      parent_link_id: parent_link_id || null,
      share_chain_depth: shareChainDepth
    })
    .select('id, token, expires_at, share_chain_depth')
    .single();

  if (createError) {
    console.error('Failed to create share link:', createError);
    throw new Error(`Failed to create share link: ${createError.message}`);
  }

  const share_url = `https://themythweaver.com/gift/${shareLink.token}`;

  console.log(`📤 Share link created for story "${story.title}" by user ${userId} (chain depth: ${shareChainDepth})`);

  // Create whisper_event for book_gifted
  const { data: userPrefs } = await supabaseAdmin
    .from('user_preferences')
    .select('whispernet_display_name')
    .eq('user_id', userId)
    .maybeSingle();

  const displayName = userPrefs?.whispernet_display_name || 'A Reader';

  const { error: eventError } = await supabaseAdmin
    .from('whisper_events')
    .insert({
      event_type: 'book_gifted',
      actor_id: userId,
      story_id: story_id,
      metadata: {
        display_name: displayName,
        story_title: story.title,
        share_chain_depth: shareChainDepth
      },
      is_public: true
    });

  if (eventError) {
    console.error('Error creating whisper_event:', eventError);
    // Non-fatal - share link was still created
  }

  // Check for badge eligibility (fire-and-forget)
  const { checkBadgeEligibility } = require('../services/badges');
  checkBadgeEligibility('book_gifted', userId, story_id).catch(err => {
    console.error('Badge check failed (non-blocking):', err.message);
  });

  res.json({
    success: true,
    token: shareLink.token,
    share_url,
    expires_at: shareLink.expires_at
  });
}));

/**
 * GET /share-links/:token/preview
 * Public endpoint for web landing page - NO AUTH REQUIRED
 * Returns book info for display before claiming
 */
router.get('/:token/preview', asyncHandler(async (req, res) => {
  const { token } = req.params;

  // Fetch share link with story and sender details
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
      ),
      sender:sender_id (
        id,
        user_preferences (
          whispernet_display_name
        )
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

  const now = new Date();
  const expiresAt = new Date(shareLink.expires_at);
  const isExpired = expiresAt < now;
  const isClaimed = !!shareLink.claimed_by;

  // Get sender display name (fallback to "A friend" if not available)
  const senderDisplayName = shareLink.sender?.user_preferences?.whispernet_display_name || 'A friend';

  res.json({
    success: true,
    title: shareLink.stories.title,
    genre: shareLink.stories.genre,
    cover_image_url: shareLink.stories.cover_image_url,
    sender_display_name: senderDisplayName,
    expires_at: shareLink.expires_at,
    is_expired: isExpired,
    is_claimed: isClaimed
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
      error: 'expired',
      message: 'This gift has returned to the Mists.'
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

  // Create whisper_event for book_claimed
  const { data: userPrefs } = await supabaseAdmin
    .from('user_preferences')
    .select('whispernet_display_name')
    .eq('user_id', userId)
    .maybeSingle();

  const displayName = userPrefs?.whispernet_display_name || 'A Reader';

  const { error: eventError } = await supabaseAdmin
    .from('whisper_events')
    .insert({
      event_type: 'book_claimed',
      actor_id: userId,
      story_id: shareLink.story_id,
      metadata: {
        display_name: displayName,
        story_title: shareLink.stories.title,
        sender_id: shareLink.sender_id
      },
      is_public: true
    });

  if (eventError) {
    console.error('Error creating whisper_event:', eventError);
    // Non-fatal - book was still added to library
  }

  // Check for badge eligibility (fire-and-forget)
  const { checkBadgeEligibility } = require('../services/badges');
  checkBadgeEligibility('book_claimed', userId, shareLink.story_id).catch(err => {
    console.error('Badge check failed (non-blocking):', err.message);
  });

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
      share_url: `https://themythweaver.com/gift/${link.token}`
    };
  });

  res.json({
    success: true,
    share_links: linksWithStatus
  });
}));

/**
 * POST /share-links/:token/defer
 * Store a pending claim for a user who hasn't signed up yet
 * NO AUTH REQUIRED - called from web landing page
 */
router.post('/:token/defer', asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      success: false,
      error: 'email is required'
    });
  }

  // Validate share link exists and is not expired
  const { data: shareLink, error: fetchError } = await supabaseAdmin
    .from('share_links')
    .select('id, story_id, expires_at')
    .eq('token', token)
    .single();

  if (fetchError || !shareLink) {
    return res.status(404).json({
      success: false,
      error: 'Share link not found'
    });
  }

  if (new Date(shareLink.expires_at) < new Date()) {
    return res.status(400).json({
      success: false,
      error: 'expired',
      message: 'This gift has returned to the Mists.'
    });
  }

  // Check if pending claim already exists (CLAUDE.md Rule 3)
  const { data: existing } = await supabaseAdmin
    .from('pending_claims')
    .select('id')
    .eq('token', token)
    .eq('email', email.toLowerCase())
    .eq('claimed', false)
    .maybeSingle();

  if (existing) {
    return res.json({
      success: true,
      message: 'This gift will be waiting for you when you sign up'
    });
  }

  // Create pending claim
  const { error: insertError } = await supabaseAdmin
    .from('pending_claims')
    .insert({
      token,
      email: email.toLowerCase(),
      claimed: false
    });

  if (insertError) {
    console.error('Failed to create pending claim:', insertError);
    throw new Error(`Failed to save pending claim: ${insertError.message}`);
  }

  console.log(`🔖 Pending claim saved for email ${email} (token: ${token})`);

  res.json({
    success: true,
    message: 'This gift will be waiting for you when you sign up'
  });
}));

/**
 * POST /share-links/check-pending-claims
 * Called after signup - auto-claims all pending share links for the user's email
 */
router.post('/check-pending-claims', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;

  // Get user's email
  const { data: user, error: userError } = await supabaseAdmin
    .from('users')
    .select('email')
    .eq('id', userId)
    .single();

  if (userError || !user) {
    return res.status(404).json({
      success: false,
      error: 'User not found'
    });
  }

  // Find all unclaimed pending claims for this email
  const { data: pendingClaims, error: fetchError } = await supabaseAdmin
    .from('pending_claims')
    .select('id, token')
    .eq('email', user.email.toLowerCase())
    .eq('claimed', false);

  if (fetchError) {
    console.error('Failed to fetch pending claims:', fetchError);
    throw new Error(`Failed to fetch pending claims: ${fetchError.message}`);
  }

  if (!pendingClaims || pendingClaims.length === 0) {
    return res.json({
      success: true,
      claimed_count: 0,
      stories: []
    });
  }

  const claimedStories = [];

  // Auto-claim each share link
  for (const claim of pendingClaims) {
    try {
      // Fetch share link details
      const { data: shareLink, error: shareLinkError } = await supabaseAdmin
        .from('share_links')
        .select(`
          id,
          token,
          story_id,
          sender_id,
          expires_at,
          claimed_by,
          stories:story_id (
            id,
            title
          )
        `)
        .eq('token', claim.token)
        .single();

      if (shareLinkError || !shareLink) {
        console.warn(`Share link not found for pending claim ${claim.id}`);
        continue;
      }

      // Skip if expired or already claimed
      if (new Date(shareLink.expires_at) < new Date() || shareLink.claimed_by) {
        continue;
      }

      // Skip if sender is the user (shouldn't happen, but safety check)
      if (shareLink.sender_id === userId) {
        continue;
      }

      // Check if already in library (CLAUDE.md Rule 3)
      const { data: existing } = await supabaseAdmin
        .from('whispernet_library')
        .select('id')
        .eq('user_id', userId)
        .eq('story_id', shareLink.story_id)
        .maybeSingle();

      if (existing) {
        continue;
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
        console.error(`Failed to add story ${shareLink.story_id} to library:`, libraryError);
        continue;
      }

      // Update share link as claimed
      await supabaseAdmin
        .from('share_links')
        .update({
          claimed_by: userId,
          claimed_at: new Date().toISOString()
        })
        .eq('id', shareLink.id);

      // Mark pending claim as claimed
      await supabaseAdmin
        .from('pending_claims')
        .update({ claimed: true })
        .eq('id', claim.id);

      claimedStories.push({
        story_id: shareLink.story_id,
        title: shareLink.stories.title
      });

      console.log(`📥 Auto-claimed pending share link: "${shareLink.stories.title}" for user ${userId}`);
    } catch (error) {
      console.error(`Error processing pending claim ${claim.id}:`, error);
      // Continue with next claim
    }
  }

  res.json({
    success: true,
    claimed_count: claimedStories.length,
    stories: claimedStories
  });
}));

module.exports = router;
