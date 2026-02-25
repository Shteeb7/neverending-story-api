/**
 * CONTENT REPORTS ROUTES
 *
 * Handles user-submitted content reports for inappropriate stories on WhisperNet.
 * Auto-escalates to content_reviews when threshold is reached.
 */

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');

const VALID_REASONS = [
  'inappropriate_content',
  'wrong_maturity_rating',
  'spam',
  'other'
];

/**
 * POST /api/content-reports
 * Submit a content report for a story
 */
router.post('/', authenticateUser, asyncHandler(async (req, res) => {
  const { story_id, reason, detail } = req.body;
  const { userId } = req;

  // Validate required fields
  if (!story_id || !reason) {
    return res.status(400).json({
      success: false,
      error: 'story_id and reason are required'
    });
  }

  // Validate reason
  if (!VALID_REASONS.includes(reason)) {
    return res.status(400).json({
      success: false,
      error: `reason must be one of: ${VALID_REASONS.join(', ')}`
    });
  }

  // Verify story exists
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('id, title')
    .eq('id', story_id)
    .single();

  if (storyError || !story) {
    return res.status(404).json({
      success: false,
      error: 'Story not found'
    });
  }

  // Check for existing report (deduplication via UNIQUE constraint on story_id + reporter_id)
  const { data: existingReport, error: checkError } = await supabaseAdmin
    .from('content_reports')
    .select('id')
    .eq('story_id', story_id)
    .eq('reporter_id', userId)
    .maybeSingle();

  if (checkError) {
    console.error('Error checking for existing report:', checkError);
    throw new Error(`Failed to check for existing report: ${checkError.message}`);
  }

  if (existingReport) {
    return res.status(409).json({
      success: false,
      error: 'You have already reported this story'
    });
  }

  // Create content report
  const { data: report, error: insertError } = await supabaseAdmin
    .from('content_reports')
    .insert({
      story_id,
      reporter_id: userId,
      reason,
      detail: detail || null,
      status: 'pending'
    })
    .select()
    .single();

  if (insertError) {
    console.error('Error creating content report:', insertError);
    throw new Error(`Failed to create report: ${insertError.message}`);
  }

  console.log(`🚩 Content report filed for story "${story.title}" by user ${userId} (reason: ${reason})`);

  // Check if this story now has 3+ reports (auto-escalation threshold)
  const { count: reportCount, error: countError } = await supabaseAdmin
    .from('content_reports')
    .select('id', { count: 'exact', head: true })
    .eq('story_id', story_id);

  if (countError) {
    console.error('Error counting reports:', countError);
    // Non-fatal - report was created
  } else if (reportCount >= 3) {
    // Auto-escalate to content_reviews
    const { data: existingReview, error: reviewCheckError } = await supabaseAdmin
      .from('content_reviews')
      .select('id, status')
      .eq('story_id', story_id)
      .maybeSingle();

    if (reviewCheckError) {
      console.error('Error checking for existing review:', reviewCheckError);
      // Non-fatal
    } else if (!existingReview) {
      // Create new content review with escalated status
      const { error: reviewInsertError } = await supabaseAdmin
        .from('content_reviews')
        .insert({
          story_id,
          status: 'escalated',
          ai_suggested_rating: null, // Not from AI classification
          escalated_from_reports: true,
          report_count: reportCount
        });

      if (reviewInsertError) {
        console.error('Error creating content review:', reviewInsertError);
        // Non-fatal
      } else {
        console.log(`🚨 Story "${story.title}" auto-escalated to content_reviews (${reportCount} reports)`);
      }
    } else if (existingReview.status !== 'escalated') {
      // Update existing review to escalated status
      const { error: reviewUpdateError } = await supabaseAdmin
        .from('content_reviews')
        .update({
          status: 'escalated',
          escalated_from_reports: true,
          report_count: reportCount
        })
        .eq('id', existingReview.id);

      if (reviewUpdateError) {
        console.error('Error updating content review:', reviewUpdateError);
        // Non-fatal
      } else {
        console.log(`🚨 Story "${story.title}" escalated to review (${reportCount} reports)`);
      }
    }
  }

  res.json({
    success: true,
    report_id: report.id,
    message: "Report submitted. We'll review this story."
  });
}));

module.exports = router;
