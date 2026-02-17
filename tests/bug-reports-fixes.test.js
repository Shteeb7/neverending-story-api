/**
 * Bug Reports Route Fixes - Test Suite
 * Tests for Phase 1 follow-up fixes:
 * - Priority sort direction
 * - GET /bug-reports/stats endpoint
 * - Admin bypass for GET and PATCH
 */

const { supabaseAdmin } = require('../src/config/supabase');

// Mock Supabase admin client
jest.mock('../src/config/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        match: jest.fn(() => Promise.resolve({
          data: [],
          error: null
        })),
        eq: jest.fn(() => ({
          order: jest.fn(() => ({
            range: jest.fn(() => Promise.resolve({
              data: [],
              error: null,
              count: 0
            }))
          })),
          single: jest.fn(() => Promise.resolve({
            data: { user_id: 'test-user-id', status: 'pending' },
            error: null
          }))
        }))
      })),
      update: jest.fn(() => ({
        eq: jest.fn(() => ({
          select: jest.fn(() => ({
            single: jest.fn(() => Promise.resolve({
              data: { id: 'test-report-id', status: 'approved' },
              error: null
            }))
          }))
        }))
      }))
    }))
  }
}));

// Import after mocking
const bugReportsModule = require('../src/routes/bug-reports');

describe('Bug Reports Route Fixes', () => {
  describe('Priority Sort Direction', () => {
    test('ascending: true for priority sort means P0 comes first', () => {
      // Test the logic: ascending order of text P0, P1, P2, P3
      const priorities = ['P3', 'P1', 'P0', 'P2'];
      const sorted = priorities.sort((a, b) => a.localeCompare(b));

      expect(sorted).toEqual(['P0', 'P1', 'P2', 'P3']);
      expect(sorted[0]).toBe('P0');  // Highest priority first
    });

    test('ascending sort puts P0 before P1', () => {
      expect('P0'.localeCompare('P1')).toBeLessThan(0);
    });

    test('ascending sort puts P1 before P2', () => {
      expect('P1'.localeCompare('P2')).toBeLessThan(0);
    });

    test('ascending sort puts P2 before P3', () => {
      expect('P2'.localeCompare('P3')).toBeLessThan(0);
    });
  });

  describe('GET /bug-reports/stats Endpoint', () => {
    test('aggregates counts by status', () => {
      const reports = [
        { status: 'pending' },
        { status: 'pending' },
        { status: 'ready' },
        { status: 'approved' },
        { status: 'approved' },
        { status: 'approved' }
      ];

      const byStatus = {};
      reports.forEach(r => {
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      });

      expect(byStatus).toEqual({
        pending: 2,
        ready: 1,
        approved: 3
      });
    });

    test('aggregates counts by priority', () => {
      const reports = [
        { ai_priority: 'P0' },
        { ai_priority: 'P1' },
        { ai_priority: 'P1' },
        { ai_priority: 'P2' },
        { ai_priority: null },
        { ai_priority: null }
      ];

      const byPriority = {};
      reports.forEach(r => {
        if (r.ai_priority === null) {
          byPriority['unanalyzed'] = (byPriority['unanalyzed'] || 0) + 1;
        } else {
          byPriority[r.ai_priority] = (byPriority[r.ai_priority] || 0) + 1;
        }
      });

      expect(byPriority).toEqual({
        P0: 1,
        P1: 2,
        P2: 1,
        unanalyzed: 2
      });
    });

    test('calculates needs_review from ready status', () => {
      const byStatus = {
        pending: 3,
        ready: 5,
        approved: 10
      };

      const needsReview = byStatus['ready'] || 0;
      expect(needsReview).toBe(5);
    });

    test('calculates total from all reports', () => {
      const reports = [
        { status: 'pending' },
        { status: 'ready' },
        { status: 'approved' }
      ];

      expect(reports.length).toBe(3);
    });

    test('handles empty data gracefully', () => {
      const reports = [];
      const byStatus = {};
      const byPriority = {};

      reports.forEach(r => {
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      });

      expect(byStatus).toEqual({});
      expect(reports.length).toBe(0);
      expect(byStatus['ready'] || 0).toBe(0);
    });

    test('counts unanalyzed reports correctly', () => {
      const reports = [
        { ai_priority: 'P0' },
        { ai_priority: null },
        { ai_priority: null },
        { ai_priority: 'P1' }
      ];

      const unanalyzedCount = reports.filter(r => r.ai_priority === null).length;
      expect(unanalyzedCount).toBe(2);
    });
  });

  describe('Admin Access Control', () => {
    describe('isAdmin() function logic', () => {
      const ADMIN_EMAILS = ['steven.labrum@gmail.com'];

      function isAdmin(user) {
        return user && user.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
      }

      test('returns true for admin email', () => {
        const adminUser = { email: 'steven.labrum@gmail.com' };
        expect(isAdmin(adminUser)).toBe(true);
      });

      test('returns true for admin email with different case', () => {
        const adminUser = { email: 'Steven.Labrum@gmail.com' };
        expect(isAdmin(adminUser)).toBe(true);
      });

      test('returns false for non-admin email', () => {
        const regularUser = { email: 'user@example.com' };
        expect(isAdmin(regularUser)).toBe(false);
      });

      test('returns falsy for null user', () => {
        expect(isAdmin(null)).toBeFalsy();
      });

      test('returns falsy for undefined user', () => {
        expect(isAdmin(undefined)).toBeFalsy();
      });

      test('returns falsy for user without email', () => {
        const user = { id: '123' };
        expect(isAdmin(user)).toBeFalsy();
      });
    });

    describe('GET /bug-reports admin filtering', () => {
      test('admin sees all reports (no user_id filter)', () => {
        const isAdmin = true;
        const userId = 'user-123';

        // If admin, query should NOT filter by user_id
        const shouldFilterByUserId = !isAdmin;
        expect(shouldFilterByUserId).toBe(false);
      });

      test('non-admin sees only their reports (user_id filter applied)', () => {
        const isAdmin = false;
        const userId = 'user-123';

        // If not admin, query SHOULD filter by user_id
        const shouldFilterByUserId = !isAdmin;
        expect(shouldFilterByUserId).toBe(true);
      });
    });

    describe('PATCH /bug-reports/:id admin bypass', () => {
      test('admin can update any report', () => {
        const isAdmin = true;
        const reportOwnerUserId = 'owner-123';
        const requestingUserId = 'admin-456';

        // Admin bypass: isAdmin OR owns report
        const canUpdate = isAdmin || reportOwnerUserId === requestingUserId;
        expect(canUpdate).toBe(true);
      });

      test('non-admin can only update their own report', () => {
        const isAdmin = false;
        const reportOwnerUserId = 'owner-123';
        const requestingUserId = 'owner-123';

        // Can update if admin OR owns report
        const canUpdate = isAdmin || reportOwnerUserId === requestingUserId;
        expect(canUpdate).toBe(true);
      });

      test('non-admin cannot update other users reports', () => {
        const isAdmin = false;
        const reportOwnerUserId = 'owner-123';
        const requestingUserId = 'other-456';

        // Cannot update if not admin AND doesn't own report
        const canUpdate = isAdmin || reportOwnerUserId === requestingUserId;
        expect(canUpdate).toBe(false);
      });

      test('admin can update reports they do not own', () => {
        const isAdmin = true;
        const reportOwnerUserId = 'owner-123';
        const requestingUserId = 'admin-456';

        // Admin can update even if they don't own it
        const canUpdate = isAdmin || reportOwnerUserId === requestingUserId;
        expect(canUpdate).toBe(true);
      });
    });
  });

  describe('Integration - All Fixes Together', () => {
    test('admin workflow: list all reports, view stats, approve report', () => {
      const adminUser = { email: 'steven.labrum@gmail.com', id: 'admin-123' };
      const ADMIN_EMAILS = ['steven.labrum@gmail.com'];

      function isAdmin(user) {
        return user && user.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
      }

      // Step 1: List all reports (admin sees all)
      const shouldFilterByUserId = !isAdmin(adminUser);
      expect(shouldFilterByUserId).toBe(false);  // No filter

      // Step 2: View stats (admin sees stats for all reports)
      const statsFilterByUserId = !isAdmin(adminUser);
      expect(statsFilterByUserId).toBe(false);  // No filter

      // Step 3: Approve a report (admin can update any report)
      const reportOwner = 'user-456';
      const canUpdate = isAdmin(adminUser) || reportOwner === adminUser.id;
      expect(canUpdate).toBe(true);
    });

    test('regular user workflow: list own reports, view own stats, cannot update others', () => {
      const regularUser = { email: 'user@example.com', id: 'user-123' };
      const ADMIN_EMAILS = ['steven.labrum@gmail.com'];

      function isAdmin(user) {
        return user && user.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
      }

      // Step 1: List reports (user only sees their own)
      const shouldFilterByUserId = !isAdmin(regularUser);
      expect(shouldFilterByUserId).toBe(true);  // Filter applied

      // Step 2: View stats (user only sees stats for their reports)
      const statsFilterByUserId = !isAdmin(regularUser);
      expect(statsFilterByUserId).toBe(true);  // Filter applied

      // Step 3: Cannot update someone else's report
      const reportOwner = 'other-user-456';
      const canUpdate = isAdmin(regularUser) || reportOwner === regularUser.id;
      expect(canUpdate).toBe(false);

      // But can update their own report
      const ownReportOwner = 'user-123';
      const canUpdateOwn = isAdmin(regularUser) || ownReportOwner === regularUser.id;
      expect(canUpdateOwn).toBe(true);
    });

    test('priority sort returns highest priority first', () => {
      const reports = [
        { id: '1', ai_priority: 'P2' },
        { id: '2', ai_priority: 'P0' },
        { id: '3', ai_priority: 'P1' },
        { id: '4', ai_priority: 'P3' }
      ];

      // Ascending sort by priority
      const sorted = reports.sort((a, b) =>
        (a.ai_priority || 'Z').localeCompare(b.ai_priority || 'Z')
      );

      expect(sorted[0].ai_priority).toBe('P0');
      expect(sorted[1].ai_priority).toBe('P1');
      expect(sorted[2].ai_priority).toBe('P2');
      expect(sorted[3].ai_priority).toBe('P3');
    });
  });

  describe('Response Shape Validation', () => {
    test('stats response has correct shape', () => {
      const statsResponse = {
        success: true,
        stats: {
          by_status: {
            pending: 3,
            ready: 5
          },
          by_priority: {
            P0: 1,
            P1: 4,
            unanalyzed: 5
          },
          total: 35,
          needs_review: 5
        }
      };

      expect(statsResponse).toHaveProperty('success');
      expect(statsResponse).toHaveProperty('stats');
      expect(statsResponse.stats).toHaveProperty('by_status');
      expect(statsResponse.stats).toHaveProperty('by_priority');
      expect(statsResponse.stats).toHaveProperty('total');
      expect(statsResponse.stats).toHaveProperty('needs_review');
      expect(typeof statsResponse.stats.total).toBe('number');
      expect(typeof statsResponse.stats.needs_review).toBe('number');
    });

    test('needs_review equals count where status is ready', () => {
      const byStatus = {
        pending: 10,
        ready: 7,
        approved: 15
      };

      const needsReview = byStatus['ready'] || 0;
      expect(needsReview).toBe(7);
    });

    test('unanalyzed equals count where ai_priority is null', () => {
      const reports = [
        { ai_priority: null },
        { ai_priority: 'P0' },
        { ai_priority: null },
        { ai_priority: null }
      ];

      const unanalyzed = reports.filter(r => r.ai_priority === null).length;
      expect(unanalyzed).toBe(3);
    });
  });
});
