/**
 * Comprehensive tests for server.ts — createServer, dispatchTool, handlers.
 * Uses a fully mocked OpenGrokClient to test all 14 tool handlers + error paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createServer,
  _capResponse as capResponse,
  _sanitizeErrorMessage as sanitizeErrorMessage,
  _resolveFileFromIndex as resolveFileFromIndex,
  _applyDefaultProject as applyDefaultProject,
} from '../server/server.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Config } from '../server/config.js';
import type { CompileInfo } from '../server/local/compile-info.js';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    OPENGROK_BASE_URL: 'https://example.com/source/',
    OPENGROK_USERNAME: 'user',
    OPENGROK_PASSWORD: 'pass',
    OPENGROK_PASSWORD_FILE: '',
    OPENGROK_PASSWORD_KEY: '',
    OPENGROK_VERIFY_SSL: true,
    OPENGROK_TIMEOUT: 30,
    OPENGROK_DEFAULT_MAX_RESULTS: 25,
    OPENGROK_CACHE_ENABLED: false,
    OPENGROK_CACHE_SEARCH_TTL: 300,
    OPENGROK_CACHE_FILE_TTL: 600,
    OPENGROK_CACHE_HISTORY_TTL: 1800,
    OPENGROK_CACHE_PROJECTS_TTL: 3600,
    OPENGROK_CACHE_MAX_SIZE: 500,
    OPENGROK_CACHE_MAX_BYTES: 52428800,
    OPENGROK_RATELIMIT_ENABLED: false,
    OPENGROK_RATELIMIT_RPM: 60,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    OPENGROK_LOCAL_COMPILE_DB_PATHS: '',
    OPENGROK_DEFAULT_PROJECT: 'release-2.x',
    ...overrides,
  } as Config;
}

function makeMockClient() {
  return {
    search: vi.fn(),
    searchPattern: vi.fn(),
    suggest: vi.fn(),
    getFileContent: vi.fn(),
    getFileHistory: vi.fn(),
    browseDirectory: vi.fn(),
    listProjects: vi.fn(),
    getAnnotate: vi.fn(),
    getFileSymbols: vi.fn(),
    testConnection: vi.fn(),
    close: vi.fn(),
  };
}

// -----------------------------------------------------------------------
// capResponse (additional edge cases)
// -----------------------------------------------------------------------

describe('capResponse — additional', () => {
  it('passes through empty string', () => {
    expect(capResponse('')).toBe('');
  });

  it('handles single char at boundary', () => {
    const single = 'a';
    expect(capResponse(single)).toBe(single);
  });
});

// -----------------------------------------------------------------------
// sanitizeErrorMessage (additional edge cases)
// -----------------------------------------------------------------------

describe('sanitizeErrorMessage — additional', () => {
  it('handles multiple credentials in one message', () => {
    const msg = 'Basic abc123 and Basic def456 leaked';
    const result = sanitizeErrorMessage(msg);
    expect(result).not.toContain('abc123');
    expect(result).not.toContain('def456');
  });

  it('handles message with no sensitive data', () => {
    const msg = 'ECONNREFUSED 127.0.0.1:8080';
    expect(sanitizeErrorMessage(msg)).toBe(msg);
  });

  it('strips /mnt and /srv paths', () => {
    expect(sanitizeErrorMessage('ENOENT /mnt/data/file')).toContain('[path]');
    expect(sanitizeErrorMessage('ENOENT /srv/app/config')).toContain('[path]');
  });
});

// -----------------------------------------------------------------------
// resolveFileFromIndex
// -----------------------------------------------------------------------

describe('resolveFileFromIndex — additional', () => {
  const makeInfo = (file: string): CompileInfo => ({
    file,
    directory: '/build',
    compiler: 'g++',
    includes: [],
    defines: [],
    standard: 'c++17',
    extraFlags: [],
  });

  it('returns null for empty index', () => {
    const result = resolveFileFromIndex(
      'foo.cpp',
      new Map(),
      new Map()
    );
    expect(result).toBeNull();
  });

  it('finds by direct key', () => {
    const index = new Map([['/build/src/foo.cpp', makeInfo('/build/src/foo.cpp')]]);
    const result = resolveFileFromIndex(
      '/build/src/foo.cpp',
      index,
      new Map()
    );
    expect(result).toBe('/build/src/foo.cpp');
  });

  it('finds via suffix index', () => {
    const index = new Map([['/build/src/foo.cpp', makeInfo('/build/src/foo.cpp')]]);
    const suffixIndex = new Map([['/src/foo.cpp', '/build/src/foo.cpp']]);
    const result = resolveFileFromIndex(
      'src/foo.cpp',
      index,
      suffixIndex
    );
    expect(result).toBe('/build/src/foo.cpp');
  });

  it('falls back to linear scan', () => {
    const index = new Map([['/build/deep/nested/src/bar.cpp', makeInfo('/build/deep/nested/src/bar.cpp')]]);
    const suffixIndex = new Map(); // no suffix match
    const result = resolveFileFromIndex(
      'deep/nested/src/bar.cpp',
      index,
      suffixIndex
    );
    expect(result).toBe('/build/deep/nested/src/bar.cpp');
  });
});

// -----------------------------------------------------------------------
// applyDefaultProject
// -----------------------------------------------------------------------

describe('applyDefaultProject', () => {
  const config = makeConfig();

  it('returns original when projects are provided', () => {
    expect(applyDefaultProject(['myproj'], config)).toEqual(['myproj']);
  });

  it('returns default project when undefined', () => {
    expect(applyDefaultProject(undefined, config)).toEqual(['release-2.x']);
  });

  it('returns empty array when explicit empty array (search all)', () => {
    expect(applyDefaultProject([], config)).toEqual([]);
  });

  it('returns undefined when no default project configured', () => {
    const cfg = makeConfig({ OPENGROK_DEFAULT_PROJECT: '' });
    expect(applyDefaultProject(undefined, cfg)).toBeUndefined();
  });
});

// -----------------------------------------------------------------------
// createServer — tool dispatch via MCP protocol
// -----------------------------------------------------------------------

describe('createServer', () => {
  let mockClient: ReturnType<typeof makeMockClient>;
  let config: Config;

  beforeEach(() => {
    mockClient = makeMockClient();
    config = makeConfig();
  });

  it('creates a server instance', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = createServer(mockClient as any, config);
    expect(server).toBeDefined();
  });

  // We test the dispatch logic by calling setRequestHandler's callback directly.
  // The handlers are registered via server.setRequestHandler, but we can use
  // a simulated approach by calling the tool directly through MCP client.
  // Since we can't easily call the handler directly, we'll test via
  // the exported utility functions and mock-based integration in server-dispatch.test.ts
});

// -----------------------------------------------------------------------
// opengrok_get_symbol_context — format handling via registerTool handler
// -----------------------------------------------------------------------

function makeFullConfig(overrides: Partial<Config> = {}): Config {
  return {
    OPENGROK_BASE_URL: 'https://example.com/source/',
    OPENGROK_USERNAME: '',
    OPENGROK_PASSWORD: '',
    OPENGROK_PASSWORD_FILE: '',
    OPENGROK_PASSWORD_KEY: '',
    OPENGROK_VERIFY_SSL: true,
    OPENGROK_TIMEOUT: 30,
    OPENGROK_DEFAULT_MAX_RESULTS: 25,
    OPENGROK_CACHE_ENABLED: false,
    OPENGROK_CACHE_SEARCH_TTL: 300,
    OPENGROK_CACHE_FILE_TTL: 600,
    OPENGROK_CACHE_HISTORY_TTL: 1800,
    OPENGROK_CACHE_PROJECTS_TTL: 3600,
    OPENGROK_CACHE_MAX_SIZE: 500,
    OPENGROK_CACHE_MAX_BYTES: 52428800,
    OPENGROK_RATELIMIT_ENABLED: false,
    OPENGROK_RATELIMIT_RPM: 60,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    OPENGROK_LOCAL_COMPILE_DB_PATHS: '',
    OPENGROK_DEFAULT_PROJECT: 'release-2.x',
    OPENGROK_CONTEXT_BUDGET: 'standard',
    OPENGROK_CODE_MODE: false,
    OPENGROK_MEMORY_BANK_DIR: '',
    OPENGROK_RESPONSE_FORMAT_OVERRIDE: '',
    ...overrides,
  } as Config;
}

function makeSymbolMockClient() {
  const client = {
    search: vi.fn(),
    searchPattern: vi.fn(),
    suggest: vi.fn(),
    getFileContent: vi.fn(),
    getFileHistory: vi.fn(),
    browseDirectory: vi.fn(),
    listProjects: vi.fn(),
    getAnnotate: vi.fn(),
    getFileSymbols: vi.fn(),
    getCallGraph: vi.fn(),
    testConnection: vi.fn(),
    close: vi.fn(),
  };

  // def search returns one match (include_header: false → only two search calls: defs + refs)
  client.search.mockResolvedValueOnce({
    query: 'MyFunc',
    searchType: 'defs',
    totalCount: 1,
    timeMs: 5,
    results: [{
      project: 'proj',
      path: '/src/foo.cpp',
      matches: [{ lineNumber: 42, lineContent: 'void MyFunc() {}' }],
    }],
    startIndex: 0,
    endIndex: 1,
  });
  // refs search
  client.search.mockResolvedValueOnce({
    query: 'MyFunc',
    searchType: 'refs',
    totalCount: 0,
    timeMs: 2,
    results: [],
    startIndex: 0,
    endIndex: 0,
  });
  // file content
  client.getFileContent.mockResolvedValue({
    project: 'proj',
    path: '/src/foo.cpp',
    content: 'void MyFunc() {}\n',
    lineCount: 1,
    sizeBytes: 17,
  });
  // file symbols
  client.getFileSymbols.mockResolvedValue({
    project: 'proj',
    path: '/src/foo.cpp',
    symbols: [],
  });

  return client;
}

async function createStandardClient(overrides: Partial<Config> = {}) {
  const ogClient = makeSymbolMockClient();
  const config = makeFullConfig(overrides);
  const server = createServer(ogClient as never, config);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const mcpClient = new Client({ name: 'test-client', version: '1.0' });
  await mcpClient.connect(clientTransport);
  return { mcpClient, ogClient };
}

describe('opengrok_get_symbol_context — format handling', () => {
  afterEach(() => {
    delete process.env.OPENGROK_RESPONSE_FORMAT_OVERRIDE;
  });

  it('returns parseable JSON when response_format is json', async () => {
    const { mcpClient } = await createStandardClient();
    const result = await mcpClient.callTool({
      name: 'opengrok_get_symbol_context',
      arguments: { symbol: 'MyFunc', response_format: 'json', include_header: false },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed).toHaveProperty('found');
  });

  it('returns non-JSON YAML-style text when response_format is auto', async () => {
    const { mcpClient } = await createStandardClient();
    const result = await mcpClient.callTool({
      name: 'opengrok_get_symbol_context',
      arguments: { symbol: 'MyFunc', response_format: 'auto', include_header: false },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    // YAML output should not be a JSON object/array
    expect(() => JSON.parse(text)).toThrow();
    // YAML should contain the symbol name
    expect(text).toContain('MyFunc');
  });
});

// -----------------------------------------------------------------------
// opengrok_what_changed — registered tool + call via MCP protocol
// -----------------------------------------------------------------------

describe('opengrok_what_changed — tool registration and call', () => {
  it('is registered as a tool', async () => {
    const { mcpClient } = await createStandardClient();
    const { tools } = await mcpClient.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('opengrok_what_changed');
  });

  it('returns formatted output on successful call', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 1);
    const recentDateStr = recentDate.toISOString().slice(0, 10);
    ogClient.getFileHistory.mockResolvedValue({
      project: 'proj', path: 'src/EventLoop.cpp',
      entries: [{ revision: 'abc12345', author: 'John Doe', date: recentDateStr, message: 'fix' }],
    });
    ogClient.getAnnotate.mockResolvedValue({
      project: 'proj', path: 'src/EventLoop.cpp',
      lines: [
        { lineNumber: 42, revision: 'abc12345', author: 'John Doe', date: recentDateStr, content: 'x' },
      ],
    });
    const result = await mcpClient.callTool({
      name: 'opengrok_what_changed',
      arguments: { project: 'proj', path: 'src/EventLoop.cpp', since_days: 7 },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('Recent changes');
    expect(text).toContain('abc1234');
    expect(text).toContain('42');
  });

  it('returns error result when client throws', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getFileHistory.mockRejectedValue(new Error('network failure'));
    ogClient.getAnnotate.mockResolvedValue({ project: 'proj', path: 'file.cpp', lines: [] });
    const result = await mcpClient.callTool({
      name: 'opengrok_what_changed',
      arguments: { project: 'proj', path: 'file.cpp' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('Error');
  });
});

// -----------------------------------------------------------------------
// opengrok_search_pattern — registration, search, formatting, errors
// -----------------------------------------------------------------------

describe('opengrok_search_pattern — tool registration and call', () => {
  it('is registered as a tool', async () => {
    const { mcpClient } = await createStandardClient();
    const { tools } = await mcpClient.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('opengrok_search_pattern');
  });

  it('calls searchPattern with correct arguments and returns formatted results', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    const mockResults = {
      query: 'void\\s+\\w+\\(',
      searchType: 'full' as const,
      totalCount: 1,
      timeMs: 10,
      results: [{
        project: 'proj',
        path: '/src/foo.cpp',
        matches: [{ lineNumber: 5, lineContent: 'void myFunc() {' }],
      }],
      startIndex: 0,
      endIndex: 1,
    };
    ogClient.searchPattern.mockResolvedValue(mockResults);

    const result = await mcpClient.callTool({
      name: 'opengrok_search_pattern',
      arguments: { pattern: 'void\\s+\\w+\\(' },
    });
    expect(ogClient.searchPattern).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: 'void\\s+\\w+\\(' })
    );
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('foo.cpp');
    expect(text).toContain('myFunc');
  });

  it('passes projects and file_type to searchPattern', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.searchPattern.mockResolvedValue({
      query: 'pattern',
      searchType: 'full' as const,
      totalCount: 0,
      timeMs: 3,
      results: [],
      startIndex: 0,
      endIndex: 0,
    });

    await mcpClient.callTool({
      name: 'opengrok_search_pattern',
      arguments: { pattern: 'pattern', projects: ['proj-a'], file_type: 'java', max_results: 5 },
    });
    expect(ogClient.searchPattern).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: 'pattern',
        projects: expect.arrayContaining(['proj-a']),
        fileType: 'java',
        maxResults: 5,
      })
    );
  });

  it('returns tsv format when response_format is tsv', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.searchPattern.mockResolvedValue({
      query: 'foo',
      searchType: 'full' as const,
      totalCount: 1,
      timeMs: 2,
      results: [{
        project: 'p',
        path: '/a/b.ts',
        matches: [{ lineNumber: 1, lineContent: 'foo()' }],
      }],
      startIndex: 0,
      endIndex: 1,
    });
    const result = await mcpClient.callTool({
      name: 'opengrok_search_pattern',
      arguments: { pattern: 'foo', response_format: 'tsv' },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('\t');
  });

  it('returns error result when searchPattern throws', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.searchPattern.mockRejectedValue(new Error('regex timeout'));
    const result = await mcpClient.callTool({
      name: 'opengrok_search_pattern',
      arguments: { pattern: '.*' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('Error');
  });

  it('rejects invalid regex pattern via schema validation', async () => {
    const { mcpClient } = await createStandardClient();
    // The SearchPatternArgs schema has a refine validator that catches invalid regex;
    // the MCP SDK should return a validation error, not call the tool handler.
    const result = await mcpClient.callTool({
      name: 'opengrok_search_pattern',
      arguments: { pattern: '[invalid' },
    });
    // Zod refine returns false → MCP SDK wraps as isError
    expect(result.isError).toBe(true);
  });
});

// -----------------------------------------------------------------------
// opengrok_dependency_map — registered tool + call via MCP protocol
// -----------------------------------------------------------------------

describe('opengrok_dependency_map — tool registration and call', () => {
  it('is registered as a tool', async () => {
    const { mcpClient } = await createStandardClient();
    const { tools } = await mcpClient.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('opengrok_dependency_map');
  });

  it('returns dependency map with uses direction', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    // Reset mocks from symbol context setup and configure for dependency map
    ogClient.search.mockReset();
    ogClient.getFileContent.mockReset();
    // EventLoop.cpp includes Timer.h → extractImports finds "Timer.h"
    ogClient.getFileContent.mockResolvedValue({
      project: 'proj', path: 'src/EventLoop.cpp',
      content: '#include "Timer.h"\nvoid run() {}',
      lineCount: 2, sizeBytes: 33, startLine: 1,
    });
    // path search for stem "Timer" returns src/Timer.cpp
    ogClient.search.mockResolvedValue({
      query: 'Timer',
      searchType: 'path',
      totalCount: 1,
      timeMs: 5,
      results: [{ project: 'proj', path: 'src/Timer.cpp', matches: [] }],
      startIndex: 0,
      endIndex: 1,
    });
    const result = await mcpClient.callTool({
      name: 'opengrok_dependency_map',
      arguments: { project: 'proj', path: 'src/EventLoop.cpp', direction: 'uses', depth: 1 },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('Dependency map');
    expect(text).toContain('EventLoop.cpp');
    expect(text).toContain('Timer.cpp');
  });

  it('returns dependency map with used_by direction', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.search.mockReset();
    ogClient.search.mockResolvedValue({
      query: 'EventLoop.h',
      searchType: 'refs',
      totalCount: 1,
      timeMs: 5,
      results: [{ project: 'proj', path: 'src/main.cpp', matches: [] }],
      startIndex: 0,
      endIndex: 1,
    });
    const result = await mcpClient.callTool({
      name: 'opengrok_dependency_map',
      arguments: { project: 'proj', path: 'src/EventLoop.h', direction: 'used_by', depth: 1 },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('main.cpp');
    expect(text).toContain('reverse deps');
  });

  it('returns error result when client throws', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.search.mockReset();
    ogClient.search.mockRejectedValue(new Error('network error'));
    const result = await mcpClient.callTool({
      name: 'opengrok_dependency_map',
      arguments: { project: 'proj', path: 'src/file.cpp' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('Error');
  });
});

// -----------------------------------------------------------------------
// opengrok_blame — registered tool + call via MCP protocol
// -----------------------------------------------------------------------

describe('opengrok_blame — tool registration and call', () => {
  const sampleAnnotated = {
    project: 'proj',
    path: 'src/EventLoop.cpp',
    lines: [
      { lineNumber: 1, revision: 'abc12345', author: 'alice', date: '2024-01-15', content: 'void EventLoop::run() {' },
      { lineNumber: 2, revision: 'abc12345', author: 'alice', date: '2024-01-15', content: '  while (running_) {' },
      { lineNumber: 3, revision: 'def67890', author: 'bob',   date: '2024-02-20', content: '    process();' },
      { lineNumber: 4, revision: 'def67890', author: 'bob',   date: '2024-02-20', content: '  }' },
      { lineNumber: 5, revision: 'abc12345', author: 'alice', date: '2024-01-15', content: '}' },
    ],
  };

  it('is registered as a tool', async () => {
    const { mcpClient } = await createStandardClient();
    const { tools } = await mcpClient.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('opengrok_blame');
  });

  it('calls getAnnotate with correct project and path', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getAnnotate.mockResolvedValue(sampleAnnotated);
    await mcpClient.callTool({
      name: 'opengrok_blame',
      arguments: { project: 'proj', path: 'src/EventLoop.cpp' },
    });
    expect(ogClient.getAnnotate).toHaveBeenCalledWith('proj', 'src/EventLoop.cpp');
  });

  it('returns full markdown table for all lines when no range given', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getAnnotate.mockResolvedValue(sampleAnnotated);
    const result = await mcpClient.callTool({
      name: 'opengrok_blame',
      arguments: { project: 'proj', path: 'src/EventLoop.cpp' },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('# Blame:');
    expect(text).toContain('| Line | Commit | Author | Date | Content |');
    expect(text).toContain('alice');
    expect(text).toContain('bob');
    expect(text).toContain('abc1234');
  });

  it('filters to line range when line_start and line_end are provided', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getAnnotate.mockResolvedValue(sampleAnnotated);
    const result = await mcpClient.callTool({
      name: 'opengrok_blame',
      arguments: { project: 'proj', path: 'src/EventLoop.cpp', line_start: 3, line_end: 4 },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('lines 3–4');
    expect(text).toContain('bob');
    expect(text).not.toContain('alice');
  });

  it('returns error result when getAnnotate throws', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getAnnotate.mockRejectedValue(new Error('server unavailable'));
    const result = await mcpClient.callTool({
      name: 'opengrok_blame',
      arguments: { project: 'proj', path: 'src/EventLoop.cpp' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('Error');
  });

  it('includes diff note when include_diff is true', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getAnnotate.mockResolvedValue(sampleAnnotated);
    const result = await mcpClient.callTool({
      name: 'opengrok_blame',
      arguments: { project: 'proj', path: 'src/EventLoop.cpp', include_diff: true },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('diff');
  });
});

// -----------------------------------------------------------------------
// Task 4.2 / 4.3 — format handling + resource links
// -----------------------------------------------------------------------

describe('opengrok_get_file_history — format handling + resource link', () => {
  it('returns markdown text with history entries in auto mode', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getFileHistory.mockResolvedValue({
      project: 'proj',
      path: '/src/EventLoop.cpp',
      entries: [
        { revision: 'abc12345', author: 'Alice', date: '2025-01-01', message: 'initial commit' },
      ],
    });
    const result = await mcpClient.callTool({
      name: 'opengrok_get_file_history',
      arguments: { project: 'proj', path: '/src/EventLoop.cpp' },
    });
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '';
    expect(text).toContain('abc12345');
    expect(text).toContain('Alice');
  });

  it('returns JSON in content when response_format=json', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getFileHistory.mockResolvedValue({
      project: 'proj',
      path: '/src/EventLoop.cpp',
      entries: [
        { revision: 'abc12345', author: 'Alice', date: '2025-01-01', message: 'initial commit' },
      ],
    });
    const result = await mcpClient.callTool({
      name: 'opengrok_get_file_history',
      arguments: { project: 'proj', path: '/src/EventLoop.cpp', response_format: 'json' },
    });
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '';
    const parsed = JSON.parse(text) as { entries: { revision: string; author: string }[] };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].revision).toBe('abc12345');
    expect(parsed.entries[0].author).toBe('Alice');
  });

  it('includes resource_link content item in auto mode', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getFileHistory.mockResolvedValue({
      project: 'proj',
      path: '/src/EventLoop.cpp',
      entries: [],
    });
    const result = await mcpClient.callTool({
      name: 'opengrok_get_file_history',
      arguments: { project: 'proj', path: '/src/EventLoop.cpp' },
    });
    const contentItems = result.content as { type: string }[];
    const resourceLink = contentItems.find((item) => item.type === 'resource_link');
    expect(resourceLink).toBeDefined();
    expect((resourceLink as { uri: string }).uri).toContain('/src/EventLoop.cpp');
  });
});

describe('opengrok_get_file_symbols — format handling + resource link', () => {
  it('returns formatted text with symbols in auto mode', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getFileSymbols.mockResolvedValue({
      project: 'proj',
      path: '/src/Foo.cpp',
      symbols: [
        { symbol: 'doSomething', type: 'function', signature: null, line: 10, lineStart: 10, lineEnd: 20, namespace: null },
      ],
    });
    const result = await mcpClient.callTool({
      name: 'opengrok_get_file_symbols',
      arguments: { project: 'proj', path: '/src/Foo.cpp' },
    });
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '';
    expect(text).toContain('doSomething');
  });

  it('returns JSON in content when response_format=json', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getFileSymbols.mockResolvedValue({
      project: 'proj',
      path: '/src/Foo.cpp',
      symbols: [
        { symbol: 'doSomething', type: 'function', signature: null, line: 10, lineStart: 10, lineEnd: 20, namespace: null },
      ],
    });
    const result = await mcpClient.callTool({
      name: 'opengrok_get_file_symbols',
      arguments: { project: 'proj', path: '/src/Foo.cpp', response_format: 'json' },
    });
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '';
    const parsed = JSON.parse(text) as { symbols: { name: string; type: string; line: number }[] };
    expect(parsed.symbols).toHaveLength(1);
    expect(parsed.symbols[0].name).toBe('doSomething');
    expect(parsed.symbols[0].type).toBe('function');
    expect(parsed.symbols[0].line).toBe(10);
  });

  it('includes resource_link when symbols are found', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getFileSymbols.mockResolvedValue({
      project: 'proj',
      path: '/src/Foo.cpp',
      symbols: [
        { symbol: 'bar', type: 'function', signature: null, line: 5, lineStart: 5, lineEnd: 10, namespace: null },
      ],
    });
    const result = await mcpClient.callTool({
      name: 'opengrok_get_file_symbols',
      arguments: { project: 'proj', path: '/src/Foo.cpp' },
    });
    const contentItems = result.content as { type: string }[];
    const resourceLink = contentItems.find((item) => item.type === 'resource_link');
    expect(resourceLink).toBeDefined();
    expect((resourceLink as { uri: string }).uri).toContain('/src/Foo.cpp');
  });

  it('returns text message when no symbols found', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getFileSymbols.mockResolvedValue({
      project: 'proj',
      path: '/src/Empty.cpp',
      symbols: [],
    });
    const result = await mcpClient.callTool({
      name: 'opengrok_get_file_symbols',
      arguments: { project: 'proj', path: '/src/Empty.cpp' },
    });
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '';
    expect(text).toContain('No symbols found');
  });
});

describe('opengrok_what_changed — format handling', () => {
  it('returns formatted text in auto mode', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 1);
    const recentDateStr = recentDate.toISOString().slice(0, 10);
    ogClient.getFileHistory.mockResolvedValue({
      project: 'proj',
      path: 'src/EventLoop.cpp',
      entries: [{ revision: 'abc12345', author: 'Alice', date: recentDateStr, message: 'fix bug' }],
    });
    ogClient.getAnnotate.mockResolvedValue({
      project: 'proj',
      path: 'src/EventLoop.cpp',
      lines: [
        { lineNumber: 10, revision: 'abc12345', author: 'Alice', date: recentDateStr, content: 'code' },
        { lineNumber: 11, revision: 'abc12345', author: 'Alice', date: recentDateStr, content: 'more' },
      ],
    });
    const result = await mcpClient.callTool({
      name: 'opengrok_what_changed',
      arguments: { project: 'proj', path: 'src/EventLoop.cpp', since_days: 7 },
    });
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '';
    expect(text).toContain('abc12345');
    expect(text).toContain('Alice');
  });

  it('returns JSON in content when response_format=json', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 1);
    const recentDateStr = recentDate.toISOString().slice(0, 10);
    ogClient.getFileHistory.mockResolvedValue({
      project: 'proj',
      path: 'src/EventLoop.cpp',
      entries: [{ revision: 'abc12345', author: 'Alice', date: recentDateStr, message: 'fix bug' }],
    });
    ogClient.getAnnotate.mockResolvedValue({
      project: 'proj',
      path: 'src/EventLoop.cpp',
      lines: [
        { lineNumber: 10, revision: 'abc12345', author: 'Alice', date: recentDateStr, content: 'code' },
        { lineNumber: 11, revision: 'abc12345', author: 'Alice', date: recentDateStr, content: 'more' },
      ],
    });
    const result = await mcpClient.callTool({
      name: 'opengrok_what_changed',
      arguments: { project: 'proj', path: 'src/EventLoop.cpp', since_days: 7, response_format: 'json' },
    });
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '';
    const parsed = JSON.parse(text) as { changes: { commit: string; author: string; lines: number[] }[] };
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.changes[0].commit).toBe('abc12345');
    expect(parsed.changes[0].author).toBe('Alice');
    expect(parsed.changes[0].lines).toContain(10);
    expect(parsed.changes[0].lines).toContain(11);
  });
});

describe('opengrok_dependency_map — format handling', () => {
  it('returns formatted text in auto mode', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    // dependency_map uses search internally via buildDependencyGraph
    ogClient.search.mockResolvedValue({
      query: '', searchType: 'refs', totalCount: 0, timeMs: 1,
      results: [], startIndex: 0, endIndex: 0,
    });
    const result = await mcpClient.callTool({
      name: 'opengrok_dependency_map',
      arguments: { project: 'proj', path: '/src/EventLoop.h', depth: 1, direction: 'both' },
    });
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '';
    expect(text.length).toBeGreaterThan(0);
  });

  it('returns JSON in content when response_format=json', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.search.mockResolvedValue({
      query: '', searchType: 'refs', totalCount: 0, timeMs: 1,
      results: [], startIndex: 0, endIndex: 0,
    });
    const result = await mcpClient.callTool({
      name: 'opengrok_dependency_map',
      arguments: { project: 'proj', path: '/src/EventLoop.h', depth: 1, direction: 'both', response_format: 'json' },
    });
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '';
    const parsed = JSON.parse(text) as { nodes: unknown[] };
    expect(Array.isArray(parsed.nodes)).toBe(true);
  });
});

describe('opengrok_blame — json format', () => {
  const sampleAnnotated = {
    project: 'proj',
    path: 'src/EventLoop.cpp',
    lines: [
      { lineNumber: 1, revision: 'abc12345', author: 'alice', date: '2024-01-15', content: 'void EventLoop::run() {' },
      { lineNumber: 2, revision: 'def67890', author: 'bob',   date: '2024-02-20', content: '  while (running_) {' },
      { lineNumber: 3, revision: undefined,  author: undefined, date: undefined,  content: 'no meta line' },
    ],
  };

  it('returns JSON entries array when response_format=json', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getAnnotate.mockResolvedValue(sampleAnnotated);
    const result = await mcpClient.callTool({
      name: 'opengrok_blame',
      arguments: { project: 'proj', path: 'src/EventLoop.cpp', response_format: 'json' },
    });
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '';
    const parsed = JSON.parse(text) as { entries: { line: number; commit: string; author: string }[] };
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries[0].commit).toBe('abc12345');
    expect(parsed.entries[0].author).toBe('alice');
    // Line 3 has undefined revision/author/date — covers the ?? "" fallback branches
    expect(parsed.entries[2].commit).toBe('');
    expect(parsed.entries[2].author).toBe('');
    expect(parsed.entries[2].date).toBe('');
  });

  it('filters to line range when line_start is set and response_format=json', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getAnnotate.mockResolvedValue(sampleAnnotated);
    const result = await mcpClient.callTool({
      name: 'opengrok_blame',
      arguments: { project: 'proj', path: 'src/EventLoop.cpp', line_start: 1, line_end: 1, response_format: 'json' },
    });
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '';
    const parsed = JSON.parse(text) as { entries: { line: number }[] };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].line).toBe(1);
  });
});

describe('opengrok_call_graph — format handling', () => {
  const sampleCallGraph = {
    query: 'MyFunc',
    searchType: 'refs',
    totalCount: 1,
    timeMs: 5,
    results: [
      { project: 'proj', path: '/src/main.cpp', matches: [{ lineNumber: 10, lineContent: 'MyFunc();' }] },
    ],
    startIndex: 0,
    endIndex: 1,
  };

  it('returns JSON results array when response_format=json', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getCallGraph.mockResolvedValue(sampleCallGraph);
    const result = await mcpClient.callTool({
      name: 'opengrok_call_graph',
      arguments: { project: 'proj', symbol: 'MyFunc', response_format: 'json' },
    });
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '';
    const parsed = JSON.parse(text) as { results: { file: string; lines: unknown[] }[] };
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results[0].file).toBe('/src/main.cpp');
    expect(parsed.results[0].lines).toHaveLength(1);
  });

  it('returns formatted text in auto mode (non-json path)', async () => {
    const { mcpClient, ogClient } = await createStandardClient();
    ogClient.getCallGraph.mockResolvedValue(sampleCallGraph);
    const result = await mcpClient.callTool({
      name: 'opengrok_call_graph',
      arguments: { project: 'proj', symbol: 'MyFunc' },
    });
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('MyFunc');
  });
});
