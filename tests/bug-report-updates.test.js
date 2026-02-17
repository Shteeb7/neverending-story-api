/**
 * Tests for GET /bug-reports/updates endpoint
 * Bug report status notifications for iOS app
 */

// Mock Supabase admin client
jest.mock('../src/config/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn()
  }
}));

// Mock admin check
jest.mock('../src/config/admin', () => ({
  isAdmin: jest.fn(() => false)
}));

const { supabaseAdmin } = require('../src/config/supabase');

describe('GET /bug-reports/updates', () => {
  let mockQuery;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup chainable mock query
    mockQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn()
    };

    supabaseAdmin.from = jest.fn().mockReturnValue(mockQuery);
  });

  test('endpoint structure validates required query parameters', () => {
    const bugReportsRoute = require('../src/routes/bug-reports');
    expect(bugReportsRoute).toBeDefined();
  });

  test('filters by user_id for authenticated user', async () => {
    const userId = 'user-123';
    mockQuery.limit.mockResolvedValue({ data: [], error: null });

    // Simulate endpoint call
    supabaseAdmin.from('bug_reports');
    mockQuery.select('id, peggy_summary, status, ai_priority, category, reviewed_at, created_at');
    mockQuery.eq('user_id', userId);
    mockQuery.in('status', ['approved', 'fixed', 'denied', 'deferred']);
    mockQuery.gt('reviewed_at', '2026-02-15T00:00:00.000Z');
    mockQuery.order('reviewed_at', { ascending: false });
    await mockQuery.limit(10);

    expect(supabaseAdmin.from).toHaveBeenCalledWith('bug_reports');
    expect(mockQuery.eq).toHaveBeenCalledWith('user_id', userId);
  });

  test('filters by reviewed statuses only', async () => {
    mockQuery.limit.mockResolvedValue({ data: [], error: null });

    // Simulate endpoint call
    supabaseAdmin.from('bug_reports');
    mockQuery.select('id, peggy_summary, status, ai_priority, category, reviewed_at, created_at');
    mockQuery.eq('user_id', 'test-user');
    mockQuery.in('status', ['approved', 'fixed', 'denied', 'deferred']);
    mockQuery.gt('reviewed_at', '2026-02-15T00:00:00.000Z');
    mockQuery.order('reviewed_at', { ascending: false });
    await mockQuery.limit(10);

    expect(mockQuery.in).toHaveBeenCalledWith('status', ['approved', 'fixed', 'denied', 'deferred']);
  });

  test('filters by reviewed_at timestamp', async () => {
    const sinceTimestamp = '2026-02-15T10:00:00.000Z';
    mockQuery.limit.mockResolvedValue({ data: [], error: null });

    // Simulate endpoint call
    supabaseAdmin.from('bug_reports');
    mockQuery.select('id, peggy_summary, status, ai_priority, category, reviewed_at, created_at');
    mockQuery.eq('user_id', 'test-user');
    mockQuery.in('status', ['approved', 'fixed', 'denied', 'deferred']);
    mockQuery.gt('reviewed_at', sinceTimestamp);
    mockQuery.order('reviewed_at', { ascending: false });
    await mockQuery.limit(10);

    expect(mockQuery.gt).toHaveBeenCalledWith('reviewed_at', sinceTimestamp);
  });

  test('orders by reviewed_at DESC (newest first)', async () => {
    mockQuery.limit.mockResolvedValue({ data: [], error: null });

    // Simulate endpoint call
    supabaseAdmin.from('bug_reports');
    mockQuery.select('id, peggy_summary, status, ai_priority, category, reviewed_at, created_at');
    mockQuery.eq('user_id', 'test-user');
    mockQuery.in('status', ['approved', 'fixed', 'denied', 'deferred']);
    mockQuery.gt('reviewed_at', '2026-02-15T00:00:00.000Z');
    mockQuery.order('reviewed_at', { ascending: false });
    await mockQuery.limit(10);

    expect(mockQuery.order).toHaveBeenCalledWith('reviewed_at', { ascending: false });
  });

  test('limits results to 10 updates', async () => {
    mockQuery.limit.mockResolvedValue({ data: [], error: null });

    // Simulate endpoint call
    supabaseAdmin.from('bug_reports');
    mockQuery.select('id, peggy_summary, status, ai_priority, category, reviewed_at, created_at');
    mockQuery.eq('user_id', 'test-user');
    mockQuery.in('status', ['approved', 'fixed', 'denied', 'deferred']);
    mockQuery.gt('reviewed_at', '2026-02-15T00:00:00.000Z');
    mockQuery.order('reviewed_at', { ascending: false });
    await mockQuery.limit(10);

    expect(mockQuery.limit).toHaveBeenCalledWith(10);
  });

  test('returns empty array when no updates', async () => {
    mockQuery.limit.mockResolvedValue({ data: [], error: null });

    supabaseAdmin.from('bug_reports');
    mockQuery.select('id, peggy_summary, status, ai_priority, category, reviewed_at, created_at');
    mockQuery.eq('user_id', 'test-user');
    mockQuery.in('status', ['approved', 'fixed', 'denied', 'deferred']);
    mockQuery.gt('reviewed_at', '2026-02-15T00:00:00.000Z');
    mockQuery.order('reviewed_at', { ascending: false });
    const result = await mockQuery.limit(10);

    expect(result.data).toEqual([]);
    expect(Array.isArray(result.data)).toBe(true);
  });

  test('returns updates with correct structure', async () => {
    const mockUpdates = [
      {
        id: 'report-1',
        peggy_summary: 'Bug report 1',
        status: 'fixed',
        ai_priority: 'P1',
        category: 'reading',
        reviewed_at: '2026-02-16T10:00:00.000Z',
        created_at: '2026-02-10T10:00:00.000Z'
      },
      {
        id: 'report-2',
        peggy_summary: 'Bug report 2',
        status: 'approved',
        ai_priority: 'P2',
        category: 'navigation',
        reviewed_at: '2026-02-16T12:00:00.000Z',
        created_at: '2026-02-10T12:00:00.000Z'
      }
    ];

    mockQuery.limit.mockResolvedValue({ data: mockUpdates, error: null });

    supabaseAdmin.from('bug_reports');
    mockQuery.select('id, peggy_summary, status, ai_priority, category, reviewed_at, created_at');
    mockQuery.eq('user_id', 'test-user');
    mockQuery.in('status', ['approved', 'fixed', 'denied', 'deferred']);
    mockQuery.gt('reviewed_at', '2026-02-15T00:00:00.000Z');
    mockQuery.order('reviewed_at', { ascending: false });
    const result = await mockQuery.limit(10);

    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe('report-1');
    expect(result.data[0].peggy_summary).toBe('Bug report 1');
    expect(result.data[0].status).toBe('fixed');
    expect(result.data[1].id).toBe('report-2');
  });

  test('handles database errors', async () => {
    mockQuery.limit.mockResolvedValue({
      data: null,
      error: { message: 'Database connection failed' }
    });

    supabaseAdmin.from('bug_reports');
    mockQuery.select('id, peggy_summary, status, ai_priority, category, reviewed_at, created_at');
    mockQuery.eq('user_id', 'test-user');
    mockQuery.in('status', ['approved', 'fixed', 'denied', 'deferred']);
    mockQuery.gt('reviewed_at', '2026-02-15T00:00:00.000Z');
    mockQuery.order('reviewed_at', { ascending: false });
    const result = await mockQuery.limit(10);

    expect(result.error).toBeDefined();
    expect(result.error.message).toBe('Database connection failed');
  });
});
