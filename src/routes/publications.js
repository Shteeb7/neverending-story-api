/**
 * WHISPERNET PUBLICATIONS ROUTES
 *
 * Handles publication of stories to WhisperNet discovery portal and content classification.
 */

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');
const { processWhisperEvent } = require('../services/notifications');

/**
 * POST /api/publications
 * Publish a story to WhisperNet
 */
router.post('/', authenticateUser, asyncHandler(async (req, res) => {
  const { story_id, genre, mood_tags, maturity_rating } = req.body;
  const { userId } = req;

  // Validate required fields
  if (!story_id || !genre || !mood_tags || !maturity_rating) {
    return res.status(400).json({
      success: false,
      error: 'story_id, genre, mood_tags, and maturity_rating required'
    });
  }

  // Validate maturity_rating
  if (!['All Ages', 'Teen 13+', 'Mature 17+'].includes(maturity_rating)) {
    return res.status(400).json({
      success: false,
      error: 'maturity_rating must be "All Ages", "Teen 13+", or "Mature 17+"'
    });
  }

  // Map display values to database values
  const maturityMap = {
    'All Ages': 'all_ages',
    'Teen 13+': 'teen_13',
    'Mature 17+': 'mature_17'
  };
  const dbMaturityRating = maturityMap[maturity_rating];

  // Verify story ownership
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('id, user_id, title, whispernet_published')
    .eq('id', story_id)
    .single();

  if (storyError || !story) {
    console.error('Story not found:', storyError);
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  if (story.user_id !== userId) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden: not story owner'
    });
  }

  // Check if already published (CLAUDE.md Rule 3)
  if (story.whispernet_published) {
    return res.status(409).json({
      success: false,
      error: 'Story already published to WhisperNet'
    });
  }

  // Check if publication already exists
  const { data: existingPub, error: checkError } = await supabaseAdmin
    .from('whispernet_publications')
    .select('id, is_active, updated_at')
    .eq('story_id', story_id)
    .maybeSingle();

  if (checkError) {
    console.error('Error checking for existing publication:', checkError);
    throw new Error(`Failed to check for existing publication: ${checkError.message}`);
  }

  if (existingPub) {
    // If publication is active, it's already published
    if (existingPub.is_active) {
      return res.status(409).json({
        success: false,
        error: 'Publication already exists'
      });
    }

    // Publication was recalled - check 24-hour cooldown
    const recalledAt = new Date(existingPub.updated_at);
    const now = new Date();
    const hoursSinceRecall = (now - recalledAt) / (1000 * 60 * 60);
    const cooldownHours = 24;

    if (hoursSinceRecall < cooldownHours) {
      const secondsRemaining = Math.ceil((cooldownHours - hoursSinceRecall) * 3600);
      return res.status(429).json({
        success: false,
        error: 'Cannot re-publish yet. 24-hour cooldown after recall.',
        retry_after: secondsRemaining
      });
    }

    // Cooldown passed - allow re-publish by updating existing record
    const { data: republishedPub, error: updateError } = await supabaseAdmin
      .from('whispernet_publications')
      .update({
        is_active: true,
        genre,
        mood_tags,
        maturity_rating: dbMaturityRating,
        updated_at: new Date().toISOString()
      })
      .eq('id', existingPub.id)
      .select()
      .single();

    if (updateError) {
      console.error('Error re-publishing:', updateError);
      throw new Error(`Failed to re-publish: ${updateError.message}`);
    }

    // Update story record
    await supabaseAdmin
      .from('stories')
      .update({
        whispernet_published: true,
        maturity_rating: dbMaturityRating
      })
      .eq('id', story_id);

    console.log(`📤 Story "${story.title}" re-published to WhisperNet after cooldown`);

    return res.json({
      success: true,
      publication_id: republishedPub.id,
      published_at: republishedPub.updated_at,
      is_republish: true
    });
  }

  // Create publication record
  const { data: publication, error: insertError } = await supabaseAdmin
    .from('whispernet_publications')
    .insert({
      story_id,
      publisher_id: userId,
      genre,
      mood_tags,
      maturity_rating: dbMaturityRating,
      is_active: true
    })
    .select()
    .single();

  if (insertError) {
    console.error('Error creating publication:', insertError);
    throw new Error(`Failed to create publication: ${insertError.message}`);
  }

  // Update story record
  const { error: updateError } = await supabaseAdmin
    .from('stories')
    .update({
      whispernet_published: true,
      maturity_rating: dbMaturityRating
    })
    .eq('id', story_id);

  if (updateError) {
    console.error('Error updating story:', updateError);
    // Publication exists but story update failed - log and continue
    // The publication record is the source of truth
  }

  // Create whisper_event for book_published
  const { data: userPrefs } = await supabaseAdmin
    .from('user_preferences')
    .select('whispernet_display_name')
    .eq('user_id', userId)
    .maybeSingle();

  const displayName = userPrefs?.whispernet_display_name || 'A Reader';

  const { error: eventError } = await supabaseAdmin
    .from('whisper_events')
    .insert({
      event_type: 'book_published',
      actor_id: userId,
      story_id: story_id,
      metadata: {
        display_name: displayName,
        story_title: story.title,
        genre,
        maturity_rating: dbMaturityRating
      },
      is_public: true
    });

  if (eventError) {
    console.error('Error creating whisper_event:', eventError);
    // Non-fatal - publication was still created
  } else {
    // Process notification routing (fire-and-forget)
    processWhisperEvent({
      event_type: 'book_published',
      actor_id: userId,
      story_id: story_id,
      metadata: {
        display_name: displayName,
        story_title: story.title,
        genre,
        maturity_rating: dbMaturityRating
      }
    }).catch(err => {
      console.error('Notification processing failed:', err.message);
    });
  }

  res.json({
    success: true,
    publication_id: publication.id,
    published_at: publication.published_at
  });
}));

/**
 * GET /api/publications/activity?user_id=X
 * Get recent activity on user's published stories
 */
router.get('/activity', authenticateUser, asyncHandler(async (req, res) => {
  const { user_id } = req.query;
  const { userId } = req;

  // Verify user can only see their own activity
  if (user_id !== userId) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden'
    });
  }

  // Get user's published stories
  const { data: publications, error: pubError } = await supabaseAdmin
    .from('whispernet_publications')
    .select('story_id, stories:story_id (title)')
    .eq('stories.user_id', userId)
    .eq('is_active', true);

  if (pubError) {
    console.error('Error fetching publications:', pubError);
    throw new Error(`Failed to fetch publications: ${pubError.message}`);
  }

  if (!publications || publications.length === 0) {
    return res.json({
      success: true,
      activity: []
    });
  }

  const storyIds = publications.map(p => p.story_id);
  const storyTitles = {};
  publications.forEach(p => {
    if (p.stories) {
      storyTitles[p.story_id] = p.stories.title;
    }
  });

  // Get reading events from last 24 hours
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: sessions, error: sessionsError } = await supabaseAdmin
    .from('reading_sessions')
    .select(`
      id,
      story_id,
      user_id,
      started_at,
      chapter_number,
      user_preferences:user_id (
        whispernet_display_name,
        whispernet_show_city,
        city
      ),
      users:user_id (
        is_minor
      )
    `)
    .in('story_id', storyIds)
    .gte('started_at', oneDayAgo)
    .order('started_at', { ascending: false })
    .limit(20);

  if (sessionsError) {
    console.error('Error fetching reading sessions:', sessionsError);
    throw new Error(`Failed to fetch reading sessions: ${sessionsError.message}`);
  }

  // Transform sessions into activity items
  const activity = (sessions || []).map(session => {
    // Privacy: always use "A Fellow Reader" for minors
    const isMinor = session.users?.is_minor ?? false;
    const displayName = isMinor
      ? 'A Fellow Reader'
      : (session.user_preferences?.whispernet_display_name || 'A Fellow Reader');
    const showCity = isMinor ? false : (session.user_preferences?.whispernet_show_city ?? false);
    const city = showCity ? session.user_preferences?.city : null;
    const storyTitle = storyTitles[session.story_id] || 'your story';

    let message;
    if (session.chapter_number === 1) {
      message = city
        ? `${displayName} in ${city} just started reading ${storyTitle}`
        : `${displayName} just started reading ${storyTitle}`;
    } else {
      message = city
        ? `${displayName} in ${city} is reading ${storyTitle}`
        : `${displayName} is reading ${storyTitle}`;
    }

    return {
      id: session.id,
      type: 'reading',
      message,
      story_id: session.story_id,
      story_title: storyTitle,
      timestamp: session.started_at
    };
  });

  res.json({
    success: true,
    activity
  });
}));

/**
 * POST /api/publications/:id/classify
 *
 * Content classification stub endpoint.
 * For now, accepts publisher self-classification.
 * Full classification pipeline (AI, reviewer, or hybrid) is owned by WhisperNet team.
 */
router.post('/:id/classify', authenticateUser, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { maturity_rating } = req.body;
  const { userId } = req;

  // Validate maturity_rating
  const validRatings = ['all_ages', 'teen_13', 'mature_17'];
  if (!maturity_rating || !validRatings.includes(maturity_rating)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid maturity_rating. Must be one of: all_ages, teen_13, mature_17'
    });
  }

  // Verify publication exists and belongs to user
  const { data: publication, error: pubError } = await supabaseAdmin
    .from('whispernet_publications')
    .select('publisher_id')
    .eq('id', id)
    .maybeSingle();

  if (pubError) {
    console.error('Error fetching publication:', pubError);
    throw new Error(`Failed to fetch publication: ${pubError.message}`);
  }

  if (!publication) {
    return res.status(404).json({ success: false, error: 'Publication not found' });
  }

  if (publication.publisher_id !== userId) {
    return res.status(403).json({ success: false, error: 'Forbidden: not the publisher' });
  }

  // Update maturity rating (stub - full classification pipeline is WhisperNet team scope)
  const { error: updateError } = await supabaseAdmin
    .from('whispernet_publications')
    .update({ maturity_rating })
    .eq('id', id);

  if (updateError) {
    console.error('Error updating maturity rating:', updateError);
    throw new Error(`Failed to update classification: ${updateError.message}`);
  }

  res.json({
    success: true,
    maturity_rating,
    message: 'Classification updated (self-classified by publisher)'
  });
}));

/**
 * POST /api/publications/classify
 * Run AI content classification on a story
 */
router.post('/classify', authenticateUser, asyncHandler(async (req, res) => {
  const { story_id } = req.body;
  const { userId } = req;

  if (!story_id) {
    return res.status(400).json({
      success: false,
      error: 'story_id required'
    });
  }

  // Verify story ownership
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('id, user_id')
    .eq('id', story_id)
    .single();

  if (storyError || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  if (story.user_id !== userId) {
    return res.status(403).json({
      success: false,
      error: 'You can only classify your own stories'
    });
  }

  // Run AI classification
  const { classifyStoryContent } = require('../services/content-classification');
  const { rating, reason } = await classifyStoryContent(story_id);

  // Store in content_reviews table
  const { data: contentReview, error: reviewError } = await supabaseAdmin
    .from('content_reviews')
    .insert({
      story_id,
      publisher_id: userId,
      ai_rating: rating,
      status: 'pending',
      prospero_conversation: {
        messages: []
      }
    })
    .select()
    .single();

  if (reviewError) {
    console.error('Error creating content_review:', reviewError);
    throw new Error('Failed to create content review record');
  }

  // Update story classification status
  await supabaseAdmin
    .from('stories')
    .update({ content_classification_status: 'ai_classified' })
    .eq('id', story_id);

  res.json({
    success: true,
    content_review_id: contentReview.id,
    rating,
    reason
  });
}));

/**
 * POST /api/publications/classify/respond
 * Handle publisher response to AI classification (agree or dispute)
 */
router.post('/classify/respond', authenticateUser, asyncHandler(async (req, res) => {
  const { content_review_id, action, publisher_rating, argument } = req.body;
  const { userId } = req;

  if (!content_review_id || !action) {
    return res.status(400).json({
      success: false,
      error: 'content_review_id and action required'
    });
  }

  if (!['agree', 'dispute'].includes(action)) {
    return res.status(400).json({
      success: false,
      error: 'action must be "agree" or "dispute"'
    });
  }

  // Fetch content review
  const { data: review, error: reviewError } = await supabaseAdmin
    .from('content_reviews')
    .select('*')
    .eq('id', content_review_id)
    .single();

  if (reviewError || !review) {
    return res.status(404).json({
      success: false,
      error: 'Content review not found'
    });
  }

  if (review.publisher_id !== userId) {
    return res.status(403).json({
      success: false,
      error: 'Not authorized'
    });
  }

  if (action === 'agree') {
    // Publisher agrees with AI rating
    await supabaseAdmin
      .from('content_reviews')
      .update({
        status: 'resolved',
        final_rating: review.ai_rating
      })
      .eq('id', content_review_id);

    await supabaseAdmin
      .from('stories')
      .update({
        content_classification_status: 'publisher_confirmed',
        maturity_rating: review.ai_rating
      })
      .eq('id', review.story_id);

    return res.json({
      success: true,
      status: 'resolved',
      final_rating: review.ai_rating
    });
  }

  // action === 'dispute'
  if (!publisher_rating || !argument) {
    return res.status(400).json({
      success: false,
      error: 'publisher_rating and argument required for dispute'
    });
  }

  // Validate publisher_rating
  if (!['all_ages', 'teen_13', 'mature_17'].includes(publisher_rating)) {
    return res.status(400).json({
      success: false,
      error: 'publisher_rating must be all_ages, teen_13, or mature_17'
    });
  }

  // Get conversation history
  const conversation = review.prospero_conversation || { messages: [] };
  const exchangeCount = Math.floor(conversation.messages.length / 2); // publisher/prospero pairs

  if (exchangeCount >= 3) {
    // Max exchanges reached, escalate
    return res.status(400).json({
      success: false,
      error: 'Maximum exchanges reached. Please escalate.',
      should_escalate: true
    });
  }

  // Add publisher's message to conversation
  conversation.messages.push({
    role: 'publisher',
    content: argument,
    timestamp: new Date().toISOString()
  });

  // Call Claude to get Prospero's response
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });

  const prosperoPrompt = `You are Prospero, the AI storyteller for Mythweaver. You classified a story as "${review.ai_rating}" (all_ages/teen_13/mature_17).

The publisher wants it classified as "${publisher_rating}" instead.

Their argument: "${argument}"

Consider their perspective carefully. You can:
1. Change your rating if they make a valid point: "You make a fair point. I'll update it to [new_rating]."
2. Stand firm if you believe your rating is correct: "I understand your perspective, but I believe [rating] is appropriate because [explanation]. If you'd still like to contest this, I can flag it for our team to review."

Be thoughtful, respectful, and clear in your reasoning. Respond in 2-3 sentences.`;

  const messages = [{ role: 'user', content: prosperoPrompt }];

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-20250514',
    max_tokens: 512,
    messages
  });

  const prosperoResponse = response.content[0].text;

  // Check if Prospero changed the rating
  const ratingChangeMatch = prosperoResponse.match(/update it to (all_ages|teen_13|mature_17)/i);
  const newRating = ratingChangeMatch ? ratingChangeMatch[1].toLowerCase() : null;

  // Add Prospero's response to conversation
  conversation.messages.push({
    role: 'prospero',
    content: prosperoResponse,
    timestamp: new Date().toISOString(),
    rating_changed: !!newRating,
    new_rating: newRating
  });

  // Update content review
  await supabaseAdmin
    .from('content_reviews')
    .update({
      publisher_rating,
      prospero_conversation: conversation,
      status: newRating ? 'resolved' : 'disputed',
      final_rating: newRating || undefined
    })
    .eq('id', content_review_id);

  // Update story status
  await supabaseAdmin
    .from('stories')
    .update({
      content_classification_status: newRating ? 'publisher_confirmed' : 'disputed',
      maturity_rating: newRating || undefined
    })
    .eq('id', review.story_id);

  res.json({
    success: true,
    prospero_response: prosperoResponse,
    status: newRating ? 'resolved' : 'disputed',
    final_rating: newRating,
    exchange_count: exchangeCount + 1,
    max_exchanges_reached: exchangeCount + 1 >= 3
  });
}));

/**
 * POST /api/publications/classify/escalate
 * Escalate disputed classification to internal review
 */
router.post('/classify/escalate', authenticateUser, asyncHandler(async (req, res) => {
  const { content_review_id } = req.body;
  const { userId } = req;

  if (!content_review_id) {
    return res.status(400).json({
      success: false,
      error: 'content_review_id required'
    });
  }

  // Fetch content review
  const { data: review, error: reviewError } = await supabaseAdmin
    .from('content_reviews')
    .select('*')
    .eq('id', content_review_id)
    .single();

  if (reviewError || !review) {
    return res.status(404).json({
      success: false,
      error: 'Content review not found'
    });
  }

  if (review.publisher_id !== userId) {
    return res.status(403).json({
      success: false,
      error: 'Not authorized'
    });
  }

  // Update content review status to escalated
  await supabaseAdmin
    .from('content_reviews')
    .update({
      status: 'escalated'
    })
    .eq('id', content_review_id);

  // Update story status
  await supabaseAdmin
    .from('stories')
    .update({
      content_classification_status: 'escalated',
      maturity_rating: review.ai_rating // Publish with AI rating pending review
    })
    .eq('id', review.story_id);

  res.json({
    success: true,
    message: 'Flagged for review. The team will resolve this within 48 hours.'
  });
}));

/**
 * POST /api/publications/:storyId/recall
 * Recall a story from WhisperNet (unpublish)
 */
router.post('/:storyId/recall', authenticateUser, asyncHandler(async (req, res) => {
  const { storyId } = req.params;
  const { userId } = req;

  // Verify story ownership
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('id, user_id, title, whispernet_published')
    .eq('id', storyId)
    .single();

  if (storyError || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  if (story.user_id !== userId) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden: not story owner'
    });
  }

  if (!story.whispernet_published) {
    return res.status(400).json({
      success: false,
      error: 'Story is not published to WhisperNet'
    });
  }

  // Get the publication record
  const { data: publication, error: pubError } = await supabaseAdmin
    .from('whispernet_publications')
    .select('id, is_active')
    .eq('story_id', storyId)
    .single();

  if (pubError || !publication) {
    return res.status(404).json({
      success: false,
      error: 'Publication record not found'
    });
  }

  if (!publication.is_active) {
    return res.status(400).json({
      success: false,
      error: 'Story is already recalled'
    });
  }

  // Recall the publication (set is_active = false, preserve all data)
  const recalledAt = new Date().toISOString();

  const { error: updateError } = await supabaseAdmin
    .from('whispernet_publications')
    .update({
      is_active: false,
      updated_at: recalledAt
    })
    .eq('id', publication.id);

  if (updateError) {
    console.error('Error recalling publication:', updateError);
    throw new Error(`Failed to recall publication: ${updateError.message}`);
  }

  // Update story record
  const { error: storyUpdateError } = await supabaseAdmin
    .from('stories')
    .update({
      whispernet_published: false
    })
    .eq('id', storyId);

  if (storyUpdateError) {
    console.error('Error updating story:', storyUpdateError);
    // Non-fatal - publication is already recalled
  }

  console.log(`📥 Story "${story.title}" recalled from WhisperNet by user ${userId}`);

  res.json({
    success: true,
    recalled_at: recalledAt,
    message: 'Your story has been recalled from the WhisperNet.'
  });
}));

module.exports = router;
