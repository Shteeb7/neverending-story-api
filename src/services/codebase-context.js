const { supabaseAdmin } = require('../config/supabase');

/**
 * File mapping by bug report category
 * Each category maps to relevant iOS and server files
 */
const CATEGORY_FILES = {
  navigation: {
    ios: ['ReadingStateManager.swift', 'LibraryView.swift', 'BookReaderView.swift'],
    server: ['src/routes/story.js']
  },
  generation: {
    ios: [],
    server: ['src/services/generation.js', 'src/services/cover-generation.js']
  },
  reading: {
    ios: ['BookReaderView.swift', 'ReadingStateManager.swift'],
    server: ['src/routes/story.js', 'src/routes/feedback.js']
  },
  interview: {
    ios: ['VoiceSessionManager.swift', 'BookCompletionInterviewView.swift', 'OnboardingView.swift'],
    server: ['src/routes/onboarding.js', 'src/routes/feedback.js']
  },
  visual: {
    ios: ['BookReaderView.swift', 'LibraryView.swift'],
    server: []
  },
  performance: {
    ios: ['ReadingStateManager.swift', 'APIManager.swift'],
    server: ['src/services/generation.js']
  }
};

const ALWAYS_INCLUDED = {
  ios: ['AuthManager.swift', 'APIManager.swift'],
  server: ['src/config/peggy.js', 'src/config/prospero.js', 'src/server.js']
};

const RULES_FILE = 'CLAUDE.md';

const GITHUB_REPOS = {
  api: { owner: 'Shteeb7', repo: 'neverending-story-api' },
  ios: { owner: 'Shteeb7', repo: 'neverending-story-ios' }
};

const DB_TABLES = [
  'bug_reports',
  'chapters',
  'stories',
  'error_events',
  'story_arcs',
  'story_bibles',
  'reading_sessions',
  'reading_heartbeats',
  'user_preferences'
];

/**
 * GitHub file cache to avoid duplicate fetches
 */
let fileCache = {};
let treeCache = {};

/**
 * Fetch file tree from GitHub to search for files by name
 */
async function fetchGitHubTree(repoKey) {
  if (treeCache[repoKey]) {
    return treeCache[repoKey];
  }

  const { owner, repo } = GITHUB_REPOS[repoKey];
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`;

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Mythweaver-Peggy-QA'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    treeCache[repoKey] = data.tree || [];
    return treeCache[repoKey];
  } catch (error) {
    console.error(`Failed to fetch tree for ${repoKey}:`, error.message);
    return [];
  }
}

/**
 * Find file path in GitHub tree by filename
 */
async function findFileInTree(repoKey, filename) {
  const tree = await fetchGitHubTree(repoKey);
  const match = tree.find(item => item.path.endsWith(filename) && item.type === 'blob');
  return match ? match.path : null;
}

/**
 * Fetch a single file from GitHub
 * Returns { path, content, line_count } or null if not found
 */
async function fetchGitHubFile(repoKey, filePath) {
  // Check cache first
  const cacheKey = `${repoKey}:${filePath}`;
  if (fileCache[cacheKey]) {
    return fileCache[cacheKey];
  }

  const { owner, repo } = GITHUB_REPOS[repoKey];

  // Try common paths first for iOS files
  let pathsToTry = [filePath];
  if (repoKey === 'ios' && !filePath.includes('/')) {
    // Try common iOS file locations
    pathsToTry = [
      `NeverendingStory/NeverendingStory/${filePath}`,
      `NeverendingStory/NeverendingStory/Services/${filePath}`,
      `NeverendingStory/NeverendingStory/Managers/${filePath}`,
      `NeverendingStory/NeverendingStory/Views/${filePath}`,
      `NeverendingStory/NeverendingStory/Views/Library/${filePath}`,
      `NeverendingStory/NeverendingStory/Views/Reader/${filePath}`,
      `NeverendingStory/NeverendingStory/Views/Interview/${filePath}`,
      `NeverendingStory/NeverendingStory/Views/Onboarding/${filePath}`
    ];
  }

  for (const tryPath of pathsToTry) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${tryPath}`;

    try {
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Mythweaver-Peggy-QA'
        }
      });

      if (response.ok) {
        const data = await response.json();

        // Decode base64 content
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const lineCount = content.split('\n').length;

        const fileData = {
          path: tryPath,
          content,
          line_count: lineCount
        };

        fileCache[cacheKey] = fileData;
        return fileData;
      }
    } catch (error) {
      // Continue to next path
    }
  }

  // If not found in common paths, search the tree
  if (repoKey === 'ios') {
    const foundPath = await findFileInTree(repoKey, filePath);
    if (foundPath) {
      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${foundPath}`;
      try {
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Mythweaver-Peggy-QA'
          }
        });

        if (response.ok) {
          const data = await response.json();
          const content = Buffer.from(data.content, 'base64').toString('utf-8');
          const lineCount = content.split('\n').length;

          const fileData = {
            path: foundPath,
            content,
            line_count: lineCount
          };

          fileCache[cacheKey] = fileData;
          return fileData;
        }
      } catch (error) {
        console.error(`Failed to fetch ${foundPath}:`, error.message);
      }
    }
  }

  console.warn(`⚠️ File not found: ${repoKey}/${filePath}`);
  return null;
}

/**
 * Fetch database schema for specified tables
 * Uses the get_public_schema_info() database function
 */
async function fetchDatabaseSchema() {
  try {
    const { data, error } = await supabaseAdmin.rpc('get_public_schema_info');

    if (error) {
      throw new Error(`Schema query failed: ${error.message}`);
    }

    // Filter to only our target tables
    const filtered = (data || []).filter(row => DB_TABLES.includes(row.table_name));
    return buildSchemaObject(filtered);
  } catch (error) {
    console.error('Failed to fetch database schema:', error.message);
    return { tables: {} };
  }
}

/**
 * Build schema object from query results
 */
function buildSchemaObject(rows) {
  const tables = {};

  rows.forEach(row => {
    if (!tables[row.table_name]) {
      tables[row.table_name] = [];
    }

    tables[row.table_name].push({
      column: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable,
      default: row.column_default
    });
  });

  return { tables };
}

/**
 * Truncate file content to specified max lines
 */
function truncateFile(file, maxLines) {
  const lines = file.content.split('\n');
  if (lines.length <= maxLines) {
    return file;
  }

  return {
    ...file,
    content: lines.slice(0, maxLines).join('\n') + `\n\n[... truncated ${lines.length - maxLines} lines ...]`,
    line_count: maxLines
  };
}

/**
 * Build codebase context package
 * Fetches source files, schema, and rules, assembles into JSON blob
 * Enforces 200KB size limit
 * Uploads to Supabase Storage
 */
async function buildCodebaseContext() {
  console.log('📦 Building codebase context package...');

  // Check for GITHUB_TOKEN
  if (!process.env.GITHUB_TOKEN) {
    console.warn('⚠️ GITHUB_TOKEN not set - returning minimal context package');
    return {
      success: true,
      size_bytes: 0,
      file_count: 0,
      built_at: new Date().toISOString(),
      message: 'GITHUB_TOKEN not set - no files fetched'
    };
  }

  // Reset caches for fresh fetch
  fileCache = {};
  treeCache = {};

  // Collect all unique files to fetch
  const filesToFetch = {
    ios: new Set(),
    server: new Set()
  };

  // Add category files
  Object.values(CATEGORY_FILES).forEach(category => {
    category.ios.forEach(file => filesToFetch.ios.add(file));
    category.server.forEach(file => filesToFetch.server.add(file));
  });

  // Add always-included files
  ALWAYS_INCLUDED.ios.forEach(file => filesToFetch.ios.add(file));
  ALWAYS_INCLUDED.server.forEach(file => filesToFetch.server.add(file));

  console.log(`📥 Fetching ${filesToFetch.ios.size} iOS files and ${filesToFetch.server.size} server files...`);

  // Fetch all files in parallel
  const iosFetchPromises = Array.from(filesToFetch.ios).map(file =>
    fetchGitHubFile('ios', file)
  );
  const serverFetchPromises = Array.from(filesToFetch.server).map(file =>
    fetchGitHubFile('api', file)
  );

  const [iosFiles, serverFiles] = await Promise.all([
    Promise.all(iosFetchPromises),
    Promise.all(serverFetchPromises)
  ]);

  // Filter out nulls (files not found)
  const iosFileMap = {};
  const serverFileMap = {};

  iosFiles.forEach((file, index) => {
    if (file) {
      const filename = Array.from(filesToFetch.ios)[index];
      iosFileMap[filename] = file;
    }
  });

  serverFiles.forEach((file, index) => {
    if (file) {
      const filename = Array.from(filesToFetch.server)[index];
      serverFileMap[filename] = file;
    }
  });

  // Fetch rules file (CLAUDE.md)
  const rulesFile = await fetchGitHubFile('api', RULES_FILE);
  const rules = rulesFile ? rulesFile.content : '';

  // Fetch database schema
  console.log('📊 Fetching database schema...');
  const schema = await fetchDatabaseSchema();

  // Assemble context package
  const categories = {};
  Object.entries(CATEGORY_FILES).forEach(([categoryName, categoryFiles]) => {
    const files = [];

    categoryFiles.ios.forEach(filename => {
      if (iosFileMap[filename]) {
        files.push(iosFileMap[filename]);
      }
    });

    categoryFiles.server.forEach(filename => {
      if (serverFileMap[filename]) {
        files.push(serverFileMap[filename]);
      }
    });

    categories[categoryName] = { files };
  });

  // Always-included files
  const alwaysIncludedFiles = [];
  ALWAYS_INCLUDED.ios.forEach(filename => {
    if (iosFileMap[filename]) {
      alwaysIncludedFiles.push(iosFileMap[filename]);
    }
  });
  ALWAYS_INCLUDED.server.forEach(filename => {
    if (serverFileMap[filename]) {
      alwaysIncludedFiles.push(serverFileMap[filename]);
    }
  });

  const contextPackage = {
    built_at: new Date().toISOString(),
    categories,
    always_included: {
      files: alwaysIncludedFiles
    },
    schema,
    rules
  };

  // Enforce 200KB size limit
  const MAX_SIZE_BYTES = 200 * 1024; // 200KB
  let packageJson = JSON.stringify(contextPackage);
  let packageSize = Buffer.byteLength(packageJson, 'utf-8');

  console.log(`📦 Initial package size: ${(packageSize / 1024).toFixed(2)}KB`);

  if (packageSize > MAX_SIZE_BYTES) {
    console.log('⚠️ Package exceeds 200KB - truncating files...');

    // Truncate to 500 lines
    Object.values(categories).forEach(category => {
      category.files = category.files.map(file => truncateFile(file, 500));
    });
    contextPackage.always_included.files = contextPackage.always_included.files.map(
      file => truncateFile(file, 500)
    );

    packageJson = JSON.stringify(contextPackage);
    packageSize = Buffer.byteLength(packageJson, 'utf-8');
    console.log(`📦 After 500-line truncation: ${(packageSize / 1024).toFixed(2)}KB`);

    if (packageSize > MAX_SIZE_BYTES) {
      // Truncate to 300 lines
      console.log('⚠️ Still too large - truncating to 300 lines...');
      Object.values(categories).forEach(category => {
        category.files = category.files.map(file => truncateFile(file, 300));
      });
      contextPackage.always_included.files = contextPackage.always_included.files.map(
        file => truncateFile(file, 300)
      );

      packageJson = JSON.stringify(contextPackage);
      packageSize = Buffer.byteLength(packageJson, 'utf-8');
      console.log(`📦 After 300-line truncation: ${(packageSize / 1024).toFixed(2)}KB`);
    }
  }

  // Count total files
  let fileCount = contextPackage.always_included.files.length;
  Object.values(categories).forEach(category => {
    fileCount += category.files.length;
  });

  console.log(`📦 Final package: ${(packageSize / 1024).toFixed(2)}KB, ${fileCount} files`);

  // Upload to Supabase Storage
  console.log('☁️ Uploading to Supabase Storage...');
  await ensureCodebaseContextBucket();

  const { error: uploadError } = await supabaseAdmin
    .storage
    .from('codebase-context')
    .upload('latest.json', Buffer.from(packageJson, 'utf-8'), {
      contentType: 'application/json',
      upsert: true
    });

  if (uploadError) {
    throw new Error(`Failed to upload context package: ${uploadError.message}`);
  }

  console.log('✅ Codebase context package built and uploaded');

  return {
    success: true,
    size_bytes: packageSize,
    file_count: fileCount,
    built_at: contextPackage.built_at
  };
}

/**
 * Ensure the codebase-context storage bucket exists
 */
async function ensureCodebaseContextBucket() {
  try {
    const { data: buckets } = await supabaseAdmin.storage.listBuckets();
    const exists = buckets?.some(b => b.name === 'codebase-context');

    if (!exists) {
      console.log('📦 Creating codebase-context storage bucket...');
      const { error } = await supabaseAdmin.storage.createBucket('codebase-context', {
        public: false,
        fileSizeLimit: 1048576  // 1MB
      });

      if (error && !error.message.includes('already exists')) {
        throw error;
      }

      console.log('✅ codebase-context bucket created');
    }
  } catch (error) {
    console.error('Error checking/creating codebase-context bucket:', error.message);
    throw error;
  }
}

module.exports = {
  buildCodebaseContext
};
