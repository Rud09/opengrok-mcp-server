/**
 * Tests for Code Mode tools: opengrok_api, opengrok_execute, memory bank tools.
 * Uses InMemoryTransport + MCP Client to call tools through the proper MCP stack.
 * executeInSandbox is mocked to avoid needing the compiled worker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { createServer } from '../server/server.js';
import { MemoryBank } from '../server/memory-bank.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Config } from '../server/config.js';
import { createSandboxAPI } from '../server/sandbox.js';

// ---------------------------------------------------------------------------
// Mock executeInSandbox so Code Mode tests don't need the compiled worker
// ---------------------------------------------------------------------------

vi.mock('../server/sandbox.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/sandbox.js')>();
  return {
    ...original,
    executeInSandbox: vi.fn().mockResolvedValue('{"result": "mock sandbox output"}'),
  };
});

import { executeInSandbox } from '../server/sandbox.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    OPENGROK_CONTEXT_BUDGET: 'minimal',
    OPENGROK_CODE_MODE: true,
    OPENGROK_MEMORY_BANK_DIR: '',
    OPENGROK_RESPONSE_FORMAT_OVERRIDE: '',
    ...overrides,
  } as Config;
}

function makeMockClient() {
  return {
    search: vi.fn().mockResolvedValue({ query: 'x', searchType: 'full', totalCount: 0, timeMs: 1, results: [], startIndex: 0, endIndex: 0, hasMore: false }),
    suggest: vi.fn().mockResolvedValue({ suggestions: [], time: 0, partialResult: false }),
    getFileContent: vi.fn().mockResolvedValue({ project: 'p', path: 'f.cpp', content: '', lineCount: 0, sizeBytes: 0 }),
    getFileHistory: vi.fn().mockResolvedValue({ project: 'p', path: 'f.cpp', entries: [] }),
    browseDirectory: vi.fn().mockResolvedValue([]),
    listProjects: vi.fn().mockResolvedValue([]),
    getAnnotate: vi.fn().mockResolvedValue({ project: 'p', path: 'f.cpp', lines: [] }),
    getFileSymbols: vi.fn().mockResolvedValue({ project: 'p', path: 'f.cpp', symbols: [] }),
    testConnection: vi.fn().mockResolvedValue(true),
    close: vi.fn(),
  };
}

async function createCodeModeClient(bank: MemoryBank) {
  const ogClient = makeMockClient();
  const config = makeConfig();
  const server = createServer(ogClient as never, config, bank);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'test-client', version: '1.0' });
  await client.connect(clientTransport);
  return { client, ogClient };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Code Mode — createServer', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-cm-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates server in Code Mode with memoryBank', () => {
    const client = makeMockClient();
    const config = makeConfig();
    const server = createServer(client as never, config, bank);
    expect(server).toBeDefined();
  });

  it('falls back to legacy mode when memoryBank not provided even with CODE_MODE=true', () => {
    const client = makeMockClient();
    const config = makeConfig({ OPENGROK_CODE_MODE: true });
    const server = createServer(client as never, config);
    expect(server).toBeDefined();
  });
});

describe('Code Mode — opengrok_api tool', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-cm-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('opengrok_api returns API spec text', async () => {
    const { client } = await createCodeModeClient(bank);
    const result = await client.callTool({ name: 'opengrok_api', arguments: {} });
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('env.opengrok');
    await client.close();
  });

  it('opengrok_api spec includes method signatures', async () => {
    const { client } = await createCodeModeClient(bank);
    const result = await client.callTool({ name: 'opengrok_api', arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('batchSearch');
    expect(text).toContain('readMemory');
    await client.close();
  });
});

describe('Code Mode — opengrok_execute tool', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-cm-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
    vi.mocked(executeInSandbox).mockResolvedValue('{"result": "mock output"}');
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('opengrok_execute calls executeInSandbox and returns result', async () => {
    const { client } = await createCodeModeClient(bank);
    const result = await client.callTool({ name: 'opengrok_execute', arguments: { code: 'return 42;' } });
    expect(vi.mocked(executeInSandbox)).toHaveBeenCalled();
    // Execution is async — poll for the task result
    const sc = result.structuredContent as { taskId: string } | undefined;
    const taskId = sc?.taskId ?? (result.content as { type: string; text: string }[])[0]?.text?.match(/taskId: "([^"]+)"/)?.[1] ?? '';
    await new Promise((resolve) => setTimeout(resolve, 20));
    const taskResult = await client.callTool({ name: 'opengrok_get_task_result', arguments: { taskId } });
    const text = (taskResult.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('mock output');
    await client.close();
  });

  it('opengrok_execute passes code to executeInSandbox', async () => {
    const { client } = await createCodeModeClient(bank);
    await client.callTool({ name: 'opengrok_execute', arguments: { code: 'return { a: 1 };' } });
    const callArgs = vi.mocked(executeInSandbox).mock.calls[0];
    expect(callArgs[0]).toContain('return { a: 1 };');
    await client.close();
  });
});

describe('Code Mode — memory bank tools', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-mb-cm-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('opengrok_read_memory returns stub message for uninitialized file', async () => {
    const { client } = await createCodeModeClient(bank);
    const result = await client.callTool({ name: 'opengrok_read_memory', arguments: { filename: 'active-task.md' } });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('not yet populated');
    await client.close();
  });

  it('opengrok_read_memory returns content for populated file', async () => {
    await bank.write('active-task.md', 'Investigating EventLoop crash');
    const { client } = await createCodeModeClient(bank);
    const result = await client.callTool({ name: 'opengrok_read_memory', arguments: { filename: 'active-task.md' } });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('EventLoop crash');
    await client.close();
  });

  it('opengrok_update_memory writes content to bank', async () => {
    const { client } = await createCodeModeClient(bank);
    await client.callTool({ name: 'opengrok_update_memory', arguments: { filename: 'active-task.md', content: 'New context', mode: 'overwrite' } });
    const content = await bank.read('active-task.md');
    expect(content).toContain('New context');
    await client.close();
  });

  it('opengrok_update_memory in append mode appends content', async () => {
    await bank.write('investigation-log.md', '## 2025-01-01: First entry\nInitial finding.');
    const { client } = await createCodeModeClient(bank);
    await client.callTool({ name: 'opengrok_update_memory', arguments: { filename: 'investigation-log.md', content: '## 2025-01-02: Second\nNew finding.', mode: 'append' } });
    const content = await bank.read('investigation-log.md');
    expect(content).toContain('First entry');
    expect(content).toContain('Second');
    await client.close();
  });
});

describe('createSandboxAPI — getCompileInfo', () => {
  let bank: MemoryBank;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-ci-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('getCompileInfo returns null when no getCompileInfoFn provided', async () => {
    const mockClient = makeMockClient();
    // createSandboxAPI called WITHOUT third arg (current behavior)
    const api = createSandboxAPI(mockClient as never, bank);
    const result = await api.getCompileInfo('/some/file.cpp');
    expect(result).toBeNull();
  });

  it('getCompileInfo delegates to getCompileInfoFn when provided', async () => {
    const fakeInfo = {
      file: '/abs/path/foo.cpp',
      compiler: 'g++',
      standard: 'c++17',
      includes: ['/usr/include'],
      defines: ['DEBUG'],
      extraFlags: ['-Wall'],
    };
    const fn = vi.fn().mockResolvedValue(fakeInfo);
    const mockClient = makeMockClient();
    const api = createSandboxAPI(mockClient as never, bank, fn);
    const result = await api.getCompileInfo('/abs/path/foo.cpp');
    expect(result).toEqual(fakeInfo);
    expect(fn).toHaveBeenCalledWith('/abs/path/foo.cpp');
  });
});

describe('Legacy Mode — memory tools available when memoryBank provided', () => {
  let tmpDir: string;
  let bank: MemoryBank;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-legacy-mb-test-'));
    bank = new MemoryBank(tmpDir);
    await bank.ensureDir();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('registers opengrok_read_memory and opengrok_update_memory in legacy mode', async () => {
    const ogClient = makeMockClient();
    // CODE_MODE is false — this forces legacy mode
    const config = makeConfig({ OPENGROK_CODE_MODE: false });
    const server = createServer(ogClient as never, config, bank);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0' });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('opengrok_read_memory');
    expect(names).toContain('opengrok_update_memory');
    // Legacy tools should also be present
    expect(names).toContain('opengrok_search_code');

    await client.close();
  });
});

// ---------------------------------------------------------------------------
// API_SPEC structure tests
// ---------------------------------------------------------------------------
import { API_SPEC } from '../server/sandbox.js';

describe('API_SPEC — return_rules and memory filenames', () => {
  it('API_SPEC has return_rules with 3 micro-optimization rules', () => {
    expect(API_SPEC).toHaveProperty('return_rules');
    expect(Array.isArray(API_SPEC.return_rules)).toBe(true);
    expect(API_SPEC.return_rules).toHaveLength(3);
  });

  it('return_rules[0] advises against returning raw objects', () => {
    const rule = API_SPEC.return_rules[0];
    expect(typeof rule).toBe('string');
    expect(rule.toLowerCase()).toMatch(/raw|map|string/);
  });

  it('return_rules[1] advises setting maxResults conservatively', () => {
    const rule = API_SPEC.return_rules[1];
    expect(typeof rule).toBe('string');
    expect(rule.toLowerCase()).toContain('maxresults');
  });

  it('return_rules[2] advises returning early when results are empty', () => {
    const rule = API_SPEC.return_rules[2];
    expect(typeof rule).toBe('string');
    expect(rule.toLowerCase()).toMatch(/early|empty/);
  });

  it('readMemory allowed filenames are the 2-file architecture names', () => {
    const allowed = API_SPEC.methods.readMemory.allowed;
    expect(allowed).toContain('active-task.md');
    expect(allowed).toContain('investigation-log.md');
    expect(allowed).not.toContain('AGENTS.md');
    expect(allowed).not.toContain('active-context.md');
  });

  it('opengrok_api tool response includes return_rules in spec text', async () => {
    const yaml = await import('js-yaml');
    const specText = yaml.dump(API_SPEC, { lineWidth: 120, noRefs: true });
    expect(specText).toContain('return_rules');
  });
});
