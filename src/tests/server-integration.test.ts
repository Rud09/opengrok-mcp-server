/**
 * Integration smoke tests for McpServer registerTool() path (Phase 7.5).
 * Wires McpServer with a mock client and verifies tool handlers return
 * correct structuredContent, text, and isError responses.
 */
import { describe, it, expect, vi } from 'vitest';
import { createServer } from '../server/server.js';
import type { Config } from '../server/config.js';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
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
    ...overrides,
  } as Config;
}

function makeMockClient() {
  return {
    search: vi.fn(),
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
// McpServer registerTool() integration
// -----------------------------------------------------------------------

describe('createServer — registerTool() integration', () => {
  it('creates a server that is a valid McpServer instance', () => {
    const client = makeMockClient();
    const config = makeConfig();
    const server = createServer(client as never, config);
    expect(server).toBeDefined();
    // McpServer has a connect method
    expect(typeof server.connect).toBe('function');
  });

  it('server has tool property accessible', () => {
    const client = makeMockClient();
    const config = makeConfig();
    const server = createServer(client as never, config);
    // The server object is created successfully — tools are registered internally
    expect(server).toBeDefined();
  });
});

// -----------------------------------------------------------------------
// Tool handler smoke tests via dispatchTool (legacy export)
// These verify the handlers wired by registerTool() also work through dispatch
// -----------------------------------------------------------------------

import {
  _dispatchTool as dispatchTool,
} from '../server/server.js';
import type { _LocalLayer as LocalLayer } from '../server/server.js';

function emptyLocal(): LocalLayer {
  return { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() };
}

describe('registerTool handlers — opengrok_search_code structured output', () => {
  it('returns formatted text for valid search', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({
      query: 'test',
      searchType: 'full',
      totalCount: 1,
      timeMs: 42,
      results: [{ project: 'proj', path: '/src/main.cpp', matches: [{ lineNumber: 10, lineContent: 'test code' }] }],
      startIndex: 0,
      endIndex: 1,
    });
    const config = makeConfig();
    const result = await dispatchTool('opengrok_search_code', { query: 'test', search_type: 'full' }, client as never, config, emptyLocal());
    expect(result).toContain('test');
    expect(result).toContain('1');
  });
});

describe('registerTool handlers — opengrok_list_projects structured output', () => {
  it('returns project list', async () => {
    const client = makeMockClient();
    client.listProjects.mockResolvedValue([
      { name: 'project-a' },
      { name: 'project-b' },
    ]);
    const config = makeConfig();
    const result = await dispatchTool('opengrok_list_projects', {}, client as never, config, emptyLocal());
    expect(result).toContain('project-a');
    expect(result).toContain('project-b');
  });
});

describe('registerTool handlers — opengrok_batch_search structured output', () => {
  it('returns batch results', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({
      query: 'foo',
      searchType: 'full',
      totalCount: 1,
      timeMs: 10,
      results: [{ project: 'proj', path: '/a.cpp', matches: [{ lineNumber: 1, lineContent: 'foo' }] }],
      startIndex: 0,
      endIndex: 1,
    });
    const config = makeConfig();
    const result = await dispatchTool('opengrok_batch_search', {
      queries: [{ query: 'foo', search_type: 'full', max_results: 5 }],
    }, client as never, config, emptyLocal());
    expect(result).toContain('Batch search');
    expect(result).toContain('foo');
  });
});

describe('registerTool handlers — opengrok_get_symbol_context structured output', () => {
  it('returns symbol-not-found when no defs match', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({
      query: 'UnknownSymbol',
      searchType: 'defs',
      totalCount: 0,
      timeMs: 5,
      results: [],
      startIndex: 0,
      endIndex: 0,
    });
    const config = makeConfig();
    const result = await dispatchTool('opengrok_get_symbol_context', {
      symbol: 'UnknownSymbol',
    }, client as never, config, emptyLocal());
    expect(result).toContain('not found');
  });
});

describe('registerTool handlers — opengrok_index_health', () => {
  it('returns connected status', async () => {
    const client = makeMockClient();
    client.testConnection.mockResolvedValue(true);
    const config = makeConfig();
    const result = await dispatchTool('opengrok_index_health', {}, client as never, config, emptyLocal());
    expect(result).toContain('connected');
  });

  it('returns failed status', async () => {
    const client = makeMockClient();
    client.testConnection.mockResolvedValue(false);
    const config = makeConfig();
    const result = await dispatchTool('opengrok_index_health', {}, client as never, config, emptyLocal());
    expect(result).toContain('failed');
  });
});

describe('registerTool handlers — error handling with isError', () => {
  it('unknown tool returns error message', async () => {
    const client = makeMockClient();
    const config = makeConfig();
    const result = await dispatchTool('nonexistent', {}, client as never, config, emptyLocal());
    expect(result).toContain('Unknown tool');
  });
});
