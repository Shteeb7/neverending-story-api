-- Migration 014: Add admin/service_role RLS policies for WhisperNet content moderation
--
-- PROBLEM: content_reviews and content_reports tables only have user-facing policies.
--          No policies exist for admin access via service_role (used by server-side admin endpoints).
--
-- SOLUTION: Add SELECT/UPDATE policies for service_role on both tables.
--           These enable admin endpoints to view and manage escalated reviews and reports.

-- ============================================================================
-- content_reviews: Add admin policies
-- ============================================================================

-- Allow service_role to SELECT all reviews (for admin review management)
CREATE POLICY content_reviews_select_admin
  ON content_reviews
  FOR SELECT
  TO service_role
  USING (true);

-- Allow service_role to UPDATE reviews (for resolving escalated reviews)
CREATE POLICY content_reviews_update_admin
  ON content_reviews
  FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- content_reports: Add admin policies
-- ============================================================================

-- Allow service_role to SELECT all reports (for admin report review)
CREATE POLICY content_reports_select_admin
  ON content_reports
  FOR SELECT
  TO service_role
  USING (true);

-- Allow service_role to UPDATE reports (for dismissing or taking action)
CREATE POLICY content_reports_update_admin
  ON content_reports
  FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);
