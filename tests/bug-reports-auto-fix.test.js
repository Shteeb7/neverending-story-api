/**
 * Bug Reports Auto-Fix Pipeline - Test Suite
 * Tests for Phase 5A-2:
 * - GitHub issue creation on approve
 * - Fix-status webhook endpoint
 * - PII sanitization
 */

const request = require('supertest');
const express = require('express');

// Store original fetch
const originalFetch = global.fetch;

// Mock fetch for GitHub API calls
global.fetch = jest.fn();

// Mock Supabase admin client
const mockSupabaseUpdate = jest.fn();
const mockSupabaseSelect = jest.fn();
const mockSupabaseSingle = jest.fn();
const mockSupabaseMaybeSingle = jest.fn();

jest.mock('../src/config/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn((table) => ({
      select: jest.fn((columns) => {
        mockSupabaseSelect(columns);
        return {
          eq: jest.fn(() => ({
            single: jest.fn(() => {
              mockSupabaseSingle();
              return Promise.resolve({
                data: {
                  user_id: 'test-user-id',
                  status: 'pending',
                  category: 'generation',
                  ai_cc_prompt: 'BUG REPORT SUMMARY:\nTest bug\n\nuser_id: 12345678-1234-1234-1234-123456789abc',
                  peggy_summary: 'Test bug summary'
                },
                error: null
              });
            })
          }))
        };
      }),
      update: jest.fn((updates) => {
        mockSupabaseUpdate(updates);
        return {
          eq: jest.fn(() => ({
            select: jest.fn(() => ({
              single: jest.fn(() => {
                mockSupabaseSingle();
                return Promise.resolve({
                  data: {
                    id: 'test-report-id',
                    status: updates.status || 'approved',
                    category: 'generation',
                    ai_cc_prompt: 'BUG REPORT SUMMARY:\\nTest bug\\n\\nuser_id: 12345678-1234-1234-1234-123456789abc',
                    peggy_summary: 'Test summary'
                  },
                  error: null
                });
              }),
              maybeSingle: jest.fn(() => {
                mockSupabaseMaybeSingle();
                return Promise.resolve({
                  data: { id: 'test-report-id', fix_status: updates.fix_status },
                  error: null
                });
              })
            }))
          }))
        };
      })
    }))
  }
}));

// Mock admin check
jest.mock('../src/config/admin', () => ({
  isAdmin: jest.fn(() => true)
}));

// Mock auth middleware
jest.mock('../src/middleware/auth', () => ({
  authenticateUser: (req, res, next) => {
    req.userId = 'test-user-id';
    req.user = { id: 'test-user-id', email: 'test@test.com' };
    next();
  }
}));

// Import after mocking
const bugReportsRouter = require('../src/routes/bug-reports');

// Create test app
const app = express();
app.use(express.json());
app.use('/bug-reports', bugReportsRouter);

// Save the original mock implementation
const { supabaseAdmin } = require('../src/config/supabase');
const originalFromImplementation = supabaseAdmin.from.getMockImplementation();

describe('Bug Reports Auto-Fix Pipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch.mockReset();
    process.env.GITHUB_WRITE_TOKEN = 'test-token';
    process.env.PEGGY_WEBHOOK_SECRET = 'test-secret';
    // Restore original mock implementation
    supabaseAdmin.from.mockImplementation(originalFromImplementation);
  });

  afterAll(() => {
    global.fetch = originalFetch;
    delete process.env.GITHUB_WRITE_TOKEN;
    delete process.env.PEGGY_WEBHOOK_SECRET;
  });

  describe('PATCH /bug-reports/:id - GitHub Issue Creation', () => {

    test('creates GitHub issue for approved server-side bug', async () => {
      // Mock successful GitHub API response
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/Shteeb7/neverending-story-api/issues/123'
        })
      });

      const response = await request(app)
        .patch('/bug-reports/test-report-id')
        .send({ status: 'approved' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify GitHub API was called
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/Shteeb7/neverending-story-api/issues',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
            'Accept': 'application/vnd.github.v3+json'
          })
        })
      );

      // Verify issue body was sanitized (PII removed)
      const fetchCall = global.fetch.mock.calls[0][1];
      const body = JSON.parse(fetchCall.body);
      expect(body.body).toContain('[REDACTED]');
      expect(body.body).not.toMatch(/[0-9a-f-]{36}/);
      expect(body.labels).toContain('peggy-fix');
      expect(body.title).toMatch(/🐛 Peggy Fix:/);
    });

    test('does NOT create GitHub issue for iOS category bug', async () => {
      // Mock both SELECT and UPDATE to return iOS category
      const supabaseMock = require('../src/config/supabase');

      const mockFrom = jest.fn((table) => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(() => Promise.resolve({
              data: {
                user_id: 'test-user-id',
                status: 'pending',
                category: 'reading', // iOS category
                ai_cc_prompt: 'Test iOS bug',
                peggy_summary: 'Test iOS bug summary'
              },
              error: null
            }))
          }))
        })),
        update: jest.fn((updates) => ({
          eq: jest.fn(() => ({
            select: jest.fn(() => ({
              single: jest.fn(() => Promise.resolve({
                data: {
                  id: 'test-report-id',
                  status: 'approved',
                  category: 'reading', // iOS category
                  ai_cc_prompt: 'Test iOS bug',
                  peggy_summary: 'Test iOS bug summary'
                },
                error: null
              })),
              maybeSingle: jest.fn(() => Promise.resolve({
                data: {
                  id: 'test-report-id',
                  fix_status: updates.fix_status
                },
                error: null
              }))
            }))
          }))
        }))
      }));

      supabaseMock.supabaseAdmin.from.mockImplementation(mockFrom);

      const response = await request(app)
        .patch('/bug-reports/test-report-id')
        .send({ status: 'approved' });

      expect(response.status).toBe(200);
      // GitHub API should NOT be called for iOS bugs
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('approval succeeds even if GitHub API fails', async () => {
      // Mock failed GitHub API response
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Server error'
      });

      const response = await request(app)
        .patch('/bug-reports/test-report-id')
        .send({ status: 'approved' });

      // PATCH should still succeed
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    test('approval succeeds even if GITHUB_WRITE_TOKEN is missing', async () => {
      delete process.env.GITHUB_WRITE_TOKEN;

      const response = await request(app)
        .patch('/bug-reports/test-report-id')
        .send({ status: 'approved' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('POST /bug-reports/fix-status - Webhook', () => {
    test('updates fix status with valid webhook secret', async () => {
      const response = await request(app)
        .post('/bug-reports/fix-status')
        .set('x-webhook-secret', 'test-secret')
        .send({
          github_issue_url: 'https://github.com/Shteeb7/neverending-story-api/issues/123',
          fix_status: 'in_progress'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockSupabaseUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          fix_status: 'in_progress'
        })
      );
    });

    test('rejects request with invalid webhook secret', async () => {
      const response = await request(app)
        .post('/bug-reports/fix-status')
        .set('x-webhook-secret', 'wrong-secret')
        .send({
          github_issue_url: 'https://github.com/Shteeb7/neverending-story-api/issues/123',
          fix_status: 'in_progress'
        });

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Unauthorized');
    });

    test('rejects request with missing webhook secret', async () => {
      const response = await request(app)
        .post('/bug-reports/fix-status')
        .send({
          github_issue_url: 'https://github.com/Shteeb7/neverending-story-api/issues/123',
          fix_status: 'in_progress'
        });

      expect(response.status).toBe(401);
    });

    test('validates fix_status values', async () => {
      const response = await request(app)
        .post('/bug-reports/fix-status')
        .set('x-webhook-secret', 'test-secret')
        .send({
          github_issue_url: 'https://github.com/Shteeb7/neverending-story-api/issues/123',
          fix_status: 'invalid_status'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid fix_status');
    });

    test('includes github_pr_url when provided', async () => {
      const response = await request(app)
        .post('/bug-reports/fix-status')
        .set('x-webhook-secret', 'test-secret')
        .send({
          github_issue_url: 'https://github.com/Shteeb7/neverending-story-api/issues/123',
          fix_status: 'pr_ready',
          github_pr_url: 'https://github.com/Shteeb7/neverending-story-api/pull/456'
        });

      expect(response.status).toBe(200);
      expect(mockSupabaseUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          fix_status: 'pr_ready',
          github_pr_url: 'https://github.com/Shteeb7/neverending-story-api/pull/456',
          fix_completed_at: expect.any(String)
        })
      );
    });

    test('sets fix_completed_at for pr_ready status', async () => {
      const response = await request(app)
        .post('/bug-reports/fix-status')
        .set('x-webhook-secret', 'test-secret')
        .send({
          github_issue_url: 'https://github.com/Shteeb7/neverending-story-api/issues/123',
          fix_status: 'pr_ready'
        });

      expect(response.status).toBe(200);
      expect(mockSupabaseUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          fix_completed_at: expect.any(String)
        })
      );
    });

    test('sets fix_completed_at for fix_failed status', async () => {
      const response = await request(app)
        .post('/bug-reports/fix-status')
        .set('x-webhook-secret', 'test-secret')
        .send({
          github_issue_url: 'https://github.com/Shteeb7/neverending-story-api/issues/123',
          fix_status: 'fix_failed'
        });

      expect(response.status).toBe(200);
      expect(mockSupabaseUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          fix_completed_at: expect.any(String)
        })
      );
    });
  });

  describe('POST /bug-reports/:id/merge-pr - Dashboard PR Merge', () => {
    test('successfully merges PR and updates bug report', async () => {
      // Mock successful GitHub merge response
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ merged: true, sha: 'abc123' })
      });

      const response = await request(app)
        .post('/bug-reports/test-report-id/merge-pr')
        .send({
          github_pr_url: 'https://github.com/Shteeb7/neverending-story-api/pull/123'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify GitHub API was called with correct merge parameters
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/Shteeb7/neverending-story-api/pulls/123/merge',
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
            'Accept': 'application/vnd.github.v3+json'
          })
        })
      );

      // Verify merge method is squash
      const fetchCall = global.fetch.mock.calls[0][1];
      const body = JSON.parse(fetchCall.body);
      expect(body.merge_method).toBe('squash');
      expect(body.commit_title).toMatch(/Peggy Fix/);

      // Verify bug report was updated
      expect(mockSupabaseUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          fix_status: 'pr_merged',
          status: 'fixed',
          fix_completed_at: expect.any(String)
        })
      );
    });

    test('returns 400 for invalid PR URL', async () => {
      const response = await request(app)
        .post('/bug-reports/test-report-id/merge-pr')
        .send({
          github_pr_url: 'not-a-valid-url'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid PR URL format');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('returns 400 when github_pr_url is missing', async () => {
      const response = await request(app)
        .post('/bug-reports/test-report-id/merge-pr')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing github_pr_url');
    });

    test('handles GitHub merge failure (merge conflict)', async () => {
      // Mock GitHub merge failure
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 405,
        text: async () => 'Merge conflict'
      });

      const response = await request(app)
        .post('/bug-reports/test-report-id/merge-pr')
        .send({
          github_pr_url: 'https://github.com/Shteeb7/neverending-story-api/pull/123'
        });

      expect(response.status).toBe(405);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('GitHub merge failed');
    });

    test('returns 500 when GITHUB_WRITE_TOKEN is missing', async () => {
      delete process.env.GITHUB_WRITE_TOKEN;

      const response = await request(app)
        .post('/bug-reports/test-report-id/merge-pr')
        .send({
          github_pr_url: 'https://github.com/Shteeb7/neverending-story-api/pull/123'
        });

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('GitHub token not configured');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
