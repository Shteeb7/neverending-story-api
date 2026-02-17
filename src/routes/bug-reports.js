const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { asyncHandler } = require('../middleware/error-handler');
const { authenticateUser } = require('../middleware/auth');
const { isAdmin } = require('../config/admin');

const router = express.Router();

// Cost tracking constants for Peggy operations
const PEGGY_VOICE_OPERATION = 'peggy_interview';
const PEGGY_TEXT_OPERATION = 'peggy_interview_text';
const PEGGY_ANALYSIS_OPERATION = 'peggy_analysis';  // For future Edge Function usage

/**
 * Log Peggy operation cost to api_costs table
 */
async function logPeggyCost(userId, operation, inputTokens, outputTokens, metadata = {}) {
  const totalTokens = inputTokens + outputTokens;

  // OpenAI Realtime pricing (voice) or Claude pricing (text) - set appropriately
  // For now, using placeholder costs - update when actual implementation is done
  const cost = operation === PEGGY_VOICE_OPERATION
    ? 0.01  // Placeholder for OpenAI Realtime cost
    : (inputTokens / 1_000_000) * 5 + (outputTokens / 1_000_000) * 25;  // Claude Opus 4.6

  try {
    await supabaseAdmin
      .from('api_costs')
      .insert({
        user_id: userId,
        story_id: null,  // Bug reports aren't associated with stories
        provider: operation === PEGGY_VOICE_OPERATION ? 'openai' : 'claude',
        model: operation === PEGGY_VOICE_OPERATION ? 'gpt-4o-realtime' : 'claude-opus-4-6',
        operation,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        cost,
        metadata,
        created_at: new Date().toISOString()
      });
  } catch (error) {
    console.error('Failed to log Peggy cost:', error);
  }
}

/**
 * Ensure the bug-report-screenshots storage bucket exists (idempotent).
 */
async function ensureBucketExists() {
  try {
    const { data: buckets } = await supabaseAdmin.storage.listBuckets();
    const exists = buckets?.some(b => b.name === 'bug-report-screenshots');

    if (!exists) {
      console.log('📦 Creating bug-report-screenshots storage bucket...');
      const { error } = await supabaseAdmin.storage.createBucket('bug-report-screenshots', {
        public: false,  // Bug reports are private
        fileSizeLimit: 10485760  // 10MB
      });

      if (error && !error.message.includes('already exists')) {
        console.error('Failed to create bug-report-screenshots bucket:', error.message);
        throw error;
      }

      console.log('✅ bug-report-screenshots bucket created');
    }
  } catch (error) {
    console.error('Error checking/creating bucket:', error.message);
    throw error;
  }
}

/**
 * Calculate user age at report time from user's date of birth
 */
async function getUserAgeAtReport(userId) {
  try {
    const { data: prefs, error } = await supabaseAdmin
      .from('user_preferences')
      .select('birth_year, birth_month')
      .eq('user_id', userId)
      .single();

    if (error || !prefs?.birth_year) {
      return null;  // Age unknown
    }

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;  // JavaScript months are 0-indexed

    let age = currentYear - prefs.birth_year;

    // Adjust if birthday hasn't happened yet this year
    if (prefs.birth_month && currentMonth < prefs.birth_month) {
      age -= 1;
    }

    return age;
  } catch (error) {
    console.error('Failed to calculate user age:', error);
    return null;
  }
}

/**
 * POST /bug-reports
 * Submit a new bug report or suggestion
 */
router.post('/', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const {
    report_type,
    interview_mode,
    transcript,
    peggy_summary,
    category,
    severity_hint,
    user_description,
    steps_to_reproduce,
    expected_behavior,
    screenshot,  // base64 encoded image
    metadata
  } = req.body;

  // Validation
  if (!report_type || !['bug', 'suggestion'].includes(report_type)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid or missing report_type (must be "bug" or "suggestion")'
    });
  }

  if (!interview_mode || !['voice', 'text'].includes(interview_mode)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid or missing interview_mode (must be "voice" or "text")'
    });
  }

  if (!transcript || !peggy_summary || !category) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: transcript, peggy_summary, category'
    });
  }

  console.log(`🐞 Bug report: user=${userId}, type=${report_type}, mode=${interview_mode}, category=${category}`);

  // Calculate user age at report time
  const userAge = await getUserAgeAtReport(userId);

  // Generate report ID upfront for screenshot upload
  const reportId = crypto.randomUUID();

  // Upload screenshot if provided
  let screenshotUrl = null;
  if (screenshot) {
    try {
      await ensureBucketExists();

      // Decode base64 to buffer
      const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');

      // Upload to Supabase Storage
      const fileName = `${userId}/${reportId}.png`;
      const { error: uploadError } = await supabaseAdmin
        .storage
        .from('bug-report-screenshots')
        .upload(fileName, imageBuffer, {
          contentType: 'image/png',
          upsert: false
        });

      if (uploadError) {
        console.error(`⚠️ Failed to upload screenshot: ${uploadError.message}`);
        // Non-fatal — continue without screenshot
      } else {
        // Get signed URL (private bucket, so we need signed URLs for access)
        const { data: urlData } = await supabaseAdmin
          .storage
          .from('bug-report-screenshots')
          .createSignedUrl(fileName, 31536000);  // 1 year expiry

        screenshotUrl = urlData?.signedUrl || null;
        console.log(`📸 Screenshot uploaded: ${fileName}`);
      }
    } catch (error) {
      console.error('Screenshot upload error:', error);
      // Non-fatal — continue without screenshot
    }
  }

  // Insert bug report
  const { data: report, error: insertError } = await supabaseAdmin
    .from('bug_reports')
    .insert({
      id: reportId,
      user_id: userId,
      report_type,
      interview_mode,
      peggy_summary,
      category,
      severity_hint: severity_hint || null,
      user_description: user_description || null,
      steps_to_reproduce: steps_to_reproduce || null,
      expected_behavior: expected_behavior || null,
      transcript,
      screenshot_url: screenshotUrl,
      metadata: metadata || {},
      user_age_at_report: userAge,
      status: 'pending'
    })
    .select()
    .single();

  if (insertError) {
    throw new Error(`Failed to insert bug report: ${insertError.message}`);
  }

  console.log(`✅ Bug report created: ${reportId}`);

  res.json({
    success: true,
    reportId: report.id
  });
}));

/**
 * GET /bug-reports/updates
 * Get recent status updates for the authenticated user's bug reports
 * NOTE: Must be defined BEFORE the generic GET / handler (Express matches top-to-bottom)
 */
router.get('/updates', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { since } = req.query;

  // Default to 7 days ago if not provided
  const sinceDate = since
    ? new Date(since).toISOString()
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Query for reviewed reports updated since the timestamp
  const { data: updates, error } = await supabaseAdmin
    .from('bug_reports')
    .select('id, peggy_summary, status, ai_priority, category, reviewed_at, created_at')
    .eq('user_id', userId)
    .in('status', ['approved', 'fixed', 'denied', 'deferred'])
    .gt('reviewed_at', sinceDate)
    .order('reviewed_at', { ascending: false })
    .limit(10);

  if (error) {
    throw new Error(`Failed to fetch bug report updates: ${error.message}`);
  }

  console.log(`📬 Bug report updates: user=${userId}, since=${sinceDate}, found=${updates?.length || 0}`);

  res.json({
    updates: updates || []
  });
}));

/**
 * GET /bug-reports
 * List bug reports with filtering and pagination
 */
router.get('/', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const {
    status,
    priority,
    type,
    sort = 'date',
    page = 1,
    limit = 20
  } = req.query;

  // Build query
  let query = supabaseAdmin
    .from('bug_reports')
    .select('*', { count: 'exact' });

  // For non-admin users, filter to their own reports only
  // Admins can see all reports
  if (!isAdmin(req.user)) {
    query = query.eq('user_id', userId);
  }

  // Apply filters
  if (status) {
    query = query.eq('status', status);
  }

  if (priority) {
    query = query.eq('ai_priority', priority);
  }

  if (type) {
    query = query.eq('report_type', type);
  }

  // Apply sorting
  if (sort === 'priority') {
    query = query.order('ai_priority', { ascending: true, nullsFirst: false });
  } else if (sort === 'cluster') {
    query = query.order('ai_cluster_id', { ascending: true, nullsFirst: false });
  } else {
    // Default: sort by date (newest first)
    query = query.order('created_at', { ascending: false });
  }

  // Apply pagination
  const offset = (parseInt(page) - 1) * parseInt(limit);
  query = query.range(offset, offset + parseInt(limit) - 1);

  const { data: reports, error, count } = await query;

  if (error) {
    throw new Error(`Failed to fetch bug reports: ${error.message}`);
  }

  res.json({
    success: true,
    reports: reports || [],
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: count || 0,
      totalPages: Math.ceil((count || 0) / parseInt(limit))
    }
  });
}));

/**
 * GET /bug-reports/stats
 * Get summary statistics for bug reports
 */
router.get('/stats', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;

  // Base query - filter by user if not admin
  const baseFilter = isAdmin(req.user) ? {} : { user_id: userId };

  // Query 1: Group by status
  const { data: statusData, error: statusError } = await supabaseAdmin
    .from('bug_reports')
    .select('status')
    .match(baseFilter);

  if (statusError) {
    throw new Error(`Failed to fetch status stats: ${statusError.message}`);
  }

  // Query 2: Group by priority
  const { data: priorityData, error: priorityError } = await supabaseAdmin
    .from('bug_reports')
    .select('ai_priority')
    .match(baseFilter);

  if (priorityError) {
    throw new Error(`Failed to fetch priority stats: ${priorityError.message}`);
  }

  // Aggregate counts manually
  const byStatus = {};
  const byPriority = {};

  statusData.forEach(row => {
    const status = row.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
  });

  priorityData.forEach(row => {
    if (row.ai_priority === null) {
      byPriority['unanalyzed'] = (byPriority['unanalyzed'] || 0) + 1;
    } else {
      const priority = row.ai_priority;
      byPriority[priority] = (byPriority[priority] || 0) + 1;
    }
  });

  // Calculate derived stats
  const total = statusData.length;
  const needsReview = byStatus['ready'] || 0;

  res.json({
    success: true,
    stats: {
      by_status: byStatus,
      by_priority: byPriority,
      total,
      needs_review: needsReview
    }
  });
}));

/**
 * PATCH /bug-reports/:id
 * Update a bug report (status, review notes, etc.)
 */
router.patch('/:id', authenticateUser, asyncHandler(async (req, res) => {
  const { userId } = req;
  const { id } = req.params;
  const {
    status,
    review_notes,
    reviewed_by,
    prompt_modified
  } = req.body;

  // Verify report exists
  const { data: existingReport, error: fetchError } = await supabaseAdmin
    .from('bug_reports')
    .select('user_id, status')
    .eq('id', id)
    .single();

  if (fetchError || !existingReport) {
    return res.status(404).json({
      success: false,
      error: 'Bug report not found'
    });
  }

  // Check permissions: admins can update any report, users can only update their own
  if (!isAdmin(req.user) && existingReport.user_id !== userId) {
    return res.status(403).json({
      success: false,
      error: 'Unauthorized to update this report'
    });
  }

  // Build update object
  const updates = {
    updated_at: new Date().toISOString()
  };

  if (status) {
    // Validate status
    const validStatuses = ['pending', 'analyzing', 'ready', 'approved', 'denied', 'deferred', 'fixed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }
    updates.status = status;
    updates.reviewed_at = new Date().toISOString();
  }

  if (review_notes) {
    updates.review_notes = review_notes;
  }

  if (reviewed_by) {
    updates.reviewed_by = reviewed_by;
  }

  if (typeof prompt_modified === 'boolean') {
    updates.prompt_modified = prompt_modified;
  }

  // Update the report
  const { data: updatedReport, error: updateError } = await supabaseAdmin
    .from('bug_reports')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (updateError) {
    throw new Error(`Failed to update bug report: ${updateError.message}`);
  }

  console.log(`✅ Bug report updated: ${id}, new status: ${status || 'unchanged'}`);

  res.json({
    success: true,
    report: updatedReport
  });
}));

module.exports = router;
