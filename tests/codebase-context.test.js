const codebaseContextService = require('../src/services/codebase-context');

// Mock dependencies
jest.mock('../src/config/supabase', () => ({
  supabaseAdmin: {
    storage: {
      listBuckets: jest.fn(),
      createBucket: jest.fn(),
      from: jest.fn(() => ({
        upload: jest.fn().mockResolvedValue({ error: null })
      }))
    },
    rpc: jest.fn(),
    from: jest.fn()
  }
}));

// Mock global fetch for GitHub API
global.fetch = jest.fn();

const { supabaseAdmin } = require('../src/config/supabase');

describe('Codebase Context Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Mock GitHub API responses
    global.fetch.mockImplementation((url) => {
      // Mock tree API
      if (url.includes('/git/trees/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            tree: [
              { path: 'NeverendingStory/NeverendingStory/AuthManager.swift', type: 'blob' },
              { path: 'src/config/peggy.js', type: 'blob' },
              { path: 'CLAUDE.md', type: 'blob' }
            ]
          })
        });
      }

      // Mock file content API
      if (url.includes('/contents/')) {
        const mockContent = 'const test = "example file content";\n'.repeat(10);
        const base64Content = Buffer.from(mockContent).toString('base64');

        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            content: base64Content,
            encoding: 'base64'
          })
        });
      }

      return Promise.reject(new Error('Unknown URL'));
    });

    // Mock Supabase storage bucket check
    supabaseAdmin.storage.listBuckets.mockResolvedValue({
      data: []
    });

    supabaseAdmin.storage.createBucket.mockResolvedValue({
      error: null
    });

    // Mock database schema query
    supabaseAdmin.rpc.mockResolvedValue({
      data: [
        { table_name: 'bug_reports', column_name: 'id', data_type: 'uuid', is_nullable: 'NO', column_default: 'uuid_generate_v4()' },
        { table_name: 'bug_reports', column_name: 'user_id', data_type: 'uuid', is_nullable: 'NO', column_default: null },
        { table_name: 'stories', column_name: 'id', data_type: 'uuid', is_nullable: 'NO', column_default: 'uuid_generate_v4()' }
      ]
    });
  });

  describe('buildCodebaseContext()', () => {
    test('returns minimal package when GITHUB_TOKEN is not set', async () => {
      const originalToken = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;

      const result = await codebaseContextService.buildCodebaseContext();

      expect(result.success).toBe(true);
      expect(result.size_bytes).toBe(0);
      expect(result.file_count).toBe(0);
      expect(result.message).toContain('GITHUB_TOKEN not set');

      process.env.GITHUB_TOKEN = originalToken;
    });

    test('builds context package with correct structure when GITHUB_TOKEN is set', async () => {
      process.env.GITHUB_TOKEN = 'mock-token-12345';

      const result = await codebaseContextService.buildCodebaseContext();

      expect(result.success).toBe(true);
      expect(result.size_bytes).toBeGreaterThan(0);
      expect(result.file_count).toBeGreaterThan(0);
      expect(result.built_at).toBeDefined();
      expect(typeof result.built_at).toBe('string');

      // Verify storage operations were called
      expect(supabaseAdmin.storage.listBuckets).toHaveBeenCalled();
      expect(supabaseAdmin.storage.from).toHaveBeenCalledWith('codebase-context');
    });

    test('creates codebase-context bucket if it does not exist', async () => {
      process.env.GITHUB_TOKEN = 'mock-token-12345';

      supabaseAdmin.storage.listBuckets.mockResolvedValue({
        data: []  // No buckets exist
      });

      await codebaseContextService.buildCodebaseContext();

      expect(supabaseAdmin.storage.createBucket).toHaveBeenCalledWith(
        'codebase-context',
        expect.objectContaining({
          public: false,
          fileSizeLimit: 1048576
        })
      );
    });

    test('does not create bucket if it already exists', async () => {
      process.env.GITHUB_TOKEN = 'mock-token-12345';

      supabaseAdmin.storage.listBuckets.mockResolvedValue({
        data: [{ name: 'codebase-context' }]
      });

      await codebaseContextService.buildCodebaseContext();

      expect(supabaseAdmin.storage.createBucket).not.toHaveBeenCalled();
    });

    test('fetches files from GitHub with correct headers', async () => {
      process.env.GITHUB_TOKEN = 'mock-token-12345';

      await codebaseContextService.buildCodebaseContext();

      expect(global.fetch).toHaveBeenCalled();

      // Check that some fetch calls included auth headers
      const fetchCalls = global.fetch.mock.calls;
      const authHeaderExists = fetchCalls.some(call =>
        call[1]?.headers?.Authorization === 'Bearer mock-token-12345'
      );

      expect(authHeaderExists).toBe(true);
    });

    test('verifies truncation logic activates for large files', async () => {
      process.env.GITHUB_TOKEN = 'mock-token-12345';

      // Mock file content with 600 lines (will trigger truncation logic)
      const largeLines = Array(600).fill('// This is a line of code').join('\n');
      const base64Content = Buffer.from(largeLines).toString('base64');

      global.fetch.mockImplementation((url) => {
        if (url.includes('/git/trees/')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              tree: [
                { path: 'NeverendingStory/NeverendingStory/AuthManager.swift', type: 'blob' },
                { path: 'src/config/peggy.js', type: 'blob' }
              ]
            })
          });
        }

        if (url.includes('/contents/')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              content: base64Content,
              encoding: 'base64'
            })
          });
        }

        return Promise.reject(new Error('Unknown URL'));
      });

      // Capture the uploaded package
      let uploadedPackage = null;
      supabaseAdmin.storage.from.mockReturnValue({
        upload: jest.fn((filename, buffer) => {
          uploadedPackage = JSON.parse(buffer.toString('utf-8'));
          return Promise.resolve({ error: null });
        })
      });

      const result = await codebaseContextService.buildCodebaseContext();

      expect(result.success).toBe(true);

      // Verify that truncation was applied to files over 500 lines
      if (uploadedPackage && uploadedPackage.always_included.files.length > 0) {
        uploadedPackage.always_included.files.forEach(file => {
          // Files should be truncated to max 500 lines (or 300 if still too large)
          expect(file.line_count).toBeLessThanOrEqual(500);
        });

        // Check that at least one file shows truncation message
        const hasTruncation = uploadedPackage.always_included.files.some(
          file => file.content.includes('truncated')
        );
        expect(hasTruncation).toBe(true);
      }
    });
  });

  describe('Context Package Structure', () => {
    test('context package has all required top-level keys', async () => {
      process.env.GITHUB_TOKEN = 'mock-token-12345';

      // Capture the uploaded package
      let uploadedPackage = null;
      supabaseAdmin.storage.from.mockReturnValue({
        upload: jest.fn((filename, buffer) => {
          uploadedPackage = JSON.parse(buffer.toString('utf-8'));
          return Promise.resolve({ error: null });
        })
      });

      await codebaseContextService.buildCodebaseContext();

      expect(uploadedPackage).not.toBeNull();
      expect(uploadedPackage).toHaveProperty('built_at');
      expect(uploadedPackage).toHaveProperty('categories');
      expect(uploadedPackage).toHaveProperty('always_included');
      expect(uploadedPackage).toHaveProperty('schema');
      expect(uploadedPackage).toHaveProperty('rules');
    });

    test('categories contain expected bug categories', async () => {
      process.env.GITHUB_TOKEN = 'mock-token-12345';

      let uploadedPackage = null;
      supabaseAdmin.storage.from.mockReturnValue({
        upload: jest.fn((filename, buffer) => {
          uploadedPackage = JSON.parse(buffer.toString('utf-8'));
          return Promise.resolve({ error: null });
        })
      });

      await codebaseContextService.buildCodebaseContext();

      expect(uploadedPackage.categories).toHaveProperty('navigation');
      expect(uploadedPackage.categories).toHaveProperty('generation');
      expect(uploadedPackage.categories).toHaveProperty('reading');
      expect(uploadedPackage.categories).toHaveProperty('interview');
      expect(uploadedPackage.categories).toHaveProperty('visual');
      expect(uploadedPackage.categories).toHaveProperty('performance');
    });

    test('always_included section has files array', async () => {
      process.env.GITHUB_TOKEN = 'mock-token-12345';

      let uploadedPackage = null;
      supabaseAdmin.storage.from.mockReturnValue({
        upload: jest.fn((filename, buffer) => {
          uploadedPackage = JSON.parse(buffer.toString('utf-8'));
          return Promise.resolve({ error: null });
        })
      });

      await codebaseContextService.buildCodebaseContext();

      expect(uploadedPackage.always_included).toHaveProperty('files');
      expect(Array.isArray(uploadedPackage.always_included.files)).toBe(true);
    });

    test('schema section has tables object', async () => {
      process.env.GITHUB_TOKEN = 'mock-token-12345';

      let uploadedPackage = null;
      supabaseAdmin.storage.from.mockReturnValue({
        upload: jest.fn((filename, buffer) => {
          uploadedPackage = JSON.parse(buffer.toString('utf-8'));
          return Promise.resolve({ error: null });
        })
      });

      await codebaseContextService.buildCodebaseContext();

      expect(uploadedPackage.schema).toHaveProperty('tables');
      expect(typeof uploadedPackage.schema.tables).toBe('object');
    });

    test('files have required structure (path, content, line_count)', async () => {
      process.env.GITHUB_TOKEN = 'mock-token-12345';

      let uploadedPackage = null;
      supabaseAdmin.storage.from.mockReturnValue({
        upload: jest.fn((filename, buffer) => {
          uploadedPackage = JSON.parse(buffer.toString('utf-8'));
          return Promise.resolve({ error: null });
        })
      });

      await codebaseContextService.buildCodebaseContext();

      // Check a file from always_included
      if (uploadedPackage.always_included.files.length > 0) {
        const file = uploadedPackage.always_included.files[0];
        expect(file).toHaveProperty('path');
        expect(file).toHaveProperty('content');
        expect(file).toHaveProperty('line_count');
        expect(typeof file.path).toBe('string');
        expect(typeof file.content).toBe('string');
        expect(typeof file.line_count).toBe('number');
      }
    });
  });
});

describe('Codebase Context Route', () => {
  // Mock Express app and dependencies for route testing
  const express = require('express');
  const request = require('supertest');

  let app;
  let mockAuthMiddleware;
  let mockUser;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create Express app for testing
    app = express();
    app.use(express.json());

    // Mock authentication middleware
    mockAuthMiddleware = (req, res, next) => {
      if (!req.headers.authorization) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized'
        });
      }

      req.userId = mockUser?.id;
      req.user = mockUser;
      next();
    };

    // Mock the route with our middleware
    const codebaseContextRoutes = require('../src/routes/codebase-context');

    // Replace authenticateUser middleware in the route
    jest.mock('../src/middleware/auth', () => ({
      authenticateUser: mockAuthMiddleware
    }));

    app.use('/', codebaseContextRoutes);
  });

  test('POST /admin/build-context returns 401 for unauthenticated requests', async () => {
    const response = await request(app)
      .post('/admin/build-context')
      .send({});

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
  });

  test('POST /admin/build-context returns 403 for non-admin users', async () => {
    mockUser = {
      id: 'user-123',
      email: 'regular-user@example.com'
    };

    const response = await request(app)
      .post('/admin/build-context')
      .set('Authorization', 'Bearer mock-token')
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('admin');
  });

  test('POST /admin/build-context returns 200 for admin users', async () => {
    process.env.GITHUB_TOKEN = 'mock-token-12345';

    mockUser = {
      id: 'admin-123',
      email: 'steven.labrum@gmail.com'
    };

    // Mock successful build
    jest.spyOn(codebaseContextService, 'buildCodebaseContext').mockResolvedValue({
      success: true,
      size_bytes: 150000,
      file_count: 12,
      built_at: '2026-02-16T12:00:00Z'
    });

    const response = await request(app)
      .post('/admin/build-context')
      .set('Authorization', 'Bearer mock-token')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body).toHaveProperty('size_bytes');
    expect(response.body).toHaveProperty('file_count');
    expect(response.body).toHaveProperty('built_at');
  });
});
