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
 * Helper: Convert rating to numeric value for comparison
 */
function ratingToNum(rating) {
  const map = { 'all_ages': 0, 'teen_13': 1, 'mature_17': 2 };
  return map[rating] !== undefined ? map[rating] : 1;
}

/**
 * Helper: Generate instant Prospero acknowledgment for dispute
 */
function generateProsperoAcknowledgment(aiRating, publisherRating, argument) {
  const acknowledgments = [
    `You raise a fair point about the content. Let me reconsider — `,
    `I appreciate you sharing your perspective on this. `,
    `That's a thoughtful argument, and I want to give it proper weight. `,
  ];
  const ack = acknowledgments[Math.floor(Math.random() * acknowledgments.length)];

  // If publisher wants LOWER rating
  if (ratingToNum(publisherRating) < ratingToNum(aiRating)) {
    return `${ack}You know your story's intent better than anyone. I'm taking another careful look at the content now with your points in mind. Give me just a moment to reconsider.`;
  }
  // If publisher wants HIGHER rating (rare but possible)
  return `${ack}I want to make sure readers are appropriately prepared. Let me review the content again with your perspective in mind.`;
}

/**
 * Helper: Re-evaluate classification with publisher's argument (background task)
 */
async function reEvaluateClassification(reviewId, review, publisherRating, argument) {
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Fetch story chapters
  const { data: chapters, error } = await supabaseAdmin
    .from('chapters')
    .select('chapter_number, content')
    .eq('story_id', review.story_id)
    .order('chapter_number', { ascending: true });

  if (error || !chapters || chapters.length === 0) {
    throw new Error('Failed to fetch chapters for re-evaluation');
  }

  const fullStoryText = chapters
    .map(ch => `CHAPTER ${ch.chapter_number}\n\n${ch.content}`)
    .join('\n\n---\n\n');

  // Re-evaluation prompt with calibrated criteria + publisher argument
  const reEvalPrompt = `You are re-evaluating a story's maturity rating. The publisher has disputed the original classification.

ORIGINAL CLASSIFICATION: ${review.ai_rating}
PUBLISHER'S REQUESTED RATING: ${publisherRating}
PUBLISHER'S ARGUMENT: "${argument}"

MATURITY LEVELS (use the LOWEST appropriate tier):

all_ages — Suitable for all readers. May include:
- Mild conflict, cartoon-style action, pratfalls
- Characters in peril that resolves safely
- Themes of friendship, courage, discovery
- No profanity, no romantic content beyond hand-holding
- Examples: Charlotte's Web, Percy Jackson (book 1), Narnia

teen_13 — Suitable for teens 13+. May include:
- Action violence (sword fights, battles, explosions) without graphic gore or torture
- Characters can die, but death is not dwelt on with graphic physical detail
- Mild profanity (damn, hell) used sparingly
- Romantic tension, kissing, implied attraction — but no explicit sexual content
- Dark themes (war, loss, injustice, moral ambiguity) handled without nihilism
- Horror atmosphere and tension without sustained graphic body horror
- Examples: Harry Potter (books 4-7), Hunger Games, Pirates of the Caribbean, Lord of the Rings

mature_17 — For mature readers 17+. Contains one or more of:
- Graphic violence with detailed physical descriptions of injury, torture, or gore
- Explicit sexual content or detailed nudity
- Heavy/frequent profanity (f-word, slurs)
- Sustained psychological horror, graphic body horror
- Detailed depictions of drug use, self-harm, or abuse
- Examples: Game of Thrones, The Road, American Psycho

IMPORTANT: Lean toward the LOWER rating when content is borderline. Action-adventure violence (battles, chases, peril) is teen_13, not mature_17, unless it includes graphic gore or torture. Fantasy/sci-fi tropes (monsters, magical combat, post-apocalyptic settings) are not inherently mature.

Consider the publisher's argument carefully. They know their story's intent. However, your job is to protect readers — if the content genuinely warrants a higher rating, maintain it.

Return EXACTLY ONE of: all_ages, teen_13, mature_17

Then provide a brief explanation (2-3 sentences) of why you chose this rating, citing specific content from the story.

Format your response EXACTLY like this:
RATING: [rating]
REASON: [explanation]

Story to re-evaluate:

${fullStoryText}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    messages: [{ role: 'user', content: reEvalPrompt }]
  });

  const responseText = response.content[0].text;
  const ratingMatch = responseText.match(/RATING:\s*(all_ages|teen_13|mature_17)/i);
  const reasonMatch = responseText.match(/REASON:\s*(.+?)(?=\n\n|$)/is);

  if (!ratingMatch) {
    throw new Error('Failed to parse re-evaluation rating');
  }

  const newRating = ratingMatch[1].toLowerCase();
  const newReason = reasonMatch ? reasonMatch[1].trim() : 'Re-evaluated after publisher feedback';

  // Update content_reviews with final rating
  await supabaseAdmin
    .from('content_reviews')
    .update({
      final_rating: newRating,
      status: 'resolved',
      updated_at: new Date().toISOString()
    })
    .eq('id', reviewId);

  console.log(`📋 Re-evaluation complete for review ${reviewId}: ${newRating}`);

  return { rating: newRating, reason: newReason, changed: newRating !== review.ai_rating };
}

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

  // Verify story is complete before publishing
  const { data: storyWithProgress, error: progressError } = await supabaseAdmin
    .from('stories')
    .select('generation_progress')
    .eq('id', story_id)
    .single();

  if (progressError) {
    console.error('Error fetching generation progress:', progressError);
    return res.status(500).json({
      success: false,
      error: 'Failed to verify story completion status'
    });
  }

  const currentStep = storyWithProgress?.generation_progress?.current_step;
  if (currentStep !== 'complete') {
    return res.status(403).json({
      success: false,
      error: 'Story must be fully complete before publishing to WhisperNet'
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

  // Verify story is complete before classification
  const { data: storyWithProgress, error: progressError } = await supabaseAdmin
    .from('stories')
    .select('generation_progress')
    .eq('id', story_id)
    .single();

  if (progressError) {
    console.error('Error fetching generation progress:', progressError);
    return res.status(500).json({
      success: false,
      error: 'Failed to verify story completion status'
    });
  }

  const currentStep = storyWithProgress?.generation_progress?.current_step;
  if (currentStep !== 'complete') {
    return res.status(403).json({
      success: false,
      error: 'Story must be fully complete before classification'
    });
  }

  // Check if a content_review already exists (from pre-classification)
  const { data: existingReview } = await supabaseAdmin
    .from('content_reviews')
    .select('*')
    .eq('story_id', story_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingReview) {
    console.log(`📋 Using existing classification for story ${story_id}`);
    // Return existing classification
    const rating = existingReview.final_rating || existingReview.ai_rating;
    return res.json({
      success: true,
      content_review_id: existingReview.id,
      rating,
      reason: 'Previously classified',
      cached: true
    });
  }

  // No existing review - run AI classification (fallback for old stories)
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
    reason,
    cached: false
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

  // PHASE 1: Generate instant acknowledgment (no AI call)
  const acknowledgment = generateProsperoAcknowledgment(review.ai_rating, publisher_rating, argument);

  // Add acknowledgment to conversation
  conversation.messages.push({
    role: 'prospero',
    content: acknowledgment,
    timestamp: new Date().toISOString(),
    is_acknowledgment: true
  });

  // Update review with acknowledgment and set status to 'reviewing'
  await supabaseAdmin
    .from('content_reviews')
    .update({
      publisher_rating,
      prospero_conversation: conversation,
      status: 'reviewing'
    })
    .eq('id', content_review_id);

  // PHASE 2: Fire background re-evaluation (fire-and-forget)
  reEvaluateClassification(content_review_id, review, publisher_rating, argument)
    .catch(err => console.error('❌ Re-evaluation failed:', err));

  // Return instant response
  res.json({
    success: true,
    prospero_response: acknowledgment,
    status: 'reviewing',
    final_rating: null,
    exchange_count: exchangeCount + 1,
    max_exchanges_reached: exchangeCount + 1 >= 3
  });
}));

/**
 * GET /api/publications/classify/review-status/:reviewId
 * Check status of a classification review (for polling after dispute)
 */
router.get('/classify/review-status/:reviewId', authenticateUser, asyncHandler(async (req, res) => {
  const { reviewId } = req.params;
  const { userId } = req;

  const { data: review, error } = await supabaseAdmin
    .from('content_reviews')
    .select('id, status, final_rating, ai_rating, publisher_id, prospero_conversation')
    .eq('id', reviewId)
    .single();

  if (error || !review) {
    return res.status(404).json({
      success: false,
      error: 'Review not found'
    });
  }

  if (review.publisher_id !== userId) {
    return res.status(403).json({
      success: false,
      error: 'Not authorized'
    });
  }

  // If status is 'resolved', return the final rating with explanation
  if (review.status === 'resolved') {
    const rating = review.final_rating || review.ai_rating;
    const ratingChanged = review.final_rating && review.final_rating !== review.ai_rating;

    // Generate Prospero's follow-up message
    let followUpMessage;
    if (ratingChanged) {
      followUpMessage = `After a closer look, I agree — ${rating} is more appropriate for this story. Updated!`;
    } else {
      followUpMessage = `I've looked again carefully, and I still believe ${rating} is the right call. If you'd like, you can escalate this for a human review.`;
    }

    return res.json({
      success: true,
      status: 'resolved',
      final_rating: rating,
      rating_changed: ratingChanged,
      follow_up_message: followUpMessage
    });
  }

  // Still reviewing
  res.json({
    success: true,
    status: review.status,
    final_rating: null
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
