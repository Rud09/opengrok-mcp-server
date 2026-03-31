/**
 * Unit tests for createSandboxAPI opts object refactoring.
 * Elicit/sample/suggestions tests added in Tasks 2–5.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSandboxAPI } from '../server/sandbox.js';
import type { OpenGrokClient } from '../server/client.js';
import type { MemoryBank } from '../server/memory-bank.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../server/elicitation.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/elicitation.js')>();
  return { ...original, elicitOrFallback: vi.fn() };
});

vi.mock('../server/sampling.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/sampling.js')>();
  return { ...original, sampleOrNull: vi.fn() };
});

import { elicitOrFallback } from '../server/elicitation.js';
import { sampleOrNull } from '../server/sampling.js';

function makeMinimalClient(): OpenGrokClient {
  return {
    search: vi.fn().mockResolvedValue({
      query: 'q', searchType: 'full', totalCount: 0,
      timeMs: 1, results: [], startIndex: 0, endIndex: 0,
    }),
    getFileContent: vi.fn(),
    getFileHistory: vi.fn(),
    browseDirectory: vi.fn(),
    listProjects: vi.fn().mockResolvedValue([]),
    getAnnotate: vi.fn(),
    getFileSymbols: vi.fn(),
    getFileDiff: vi.fn(),
    testConnection: vi.fn().mockResolvedValue(true),
    suggest: vi.fn().mockResolvedValue({ suggestions: [], time: 0, partialResult: false }),
    close: vi.fn(),
  } as unknown as OpenGrokClient;
}

function makeMinimalMemoryBank(): MemoryBank {
  return {
    read: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn(),
    getStatusLine: vi.fn().mockResolvedValue(''),
    getFileReference: vi.fn().mockResolvedValue(undefined),
  } as unknown as MemoryBank;
}

// ---------------------------------------------------------------------------
// Task 1: opts object refactoring — existing methods still work
// ---------------------------------------------------------------------------

describe('createSandboxAPI — opts object signature', () => {
  it('accepts opts object and getCompileInfoFn still works', async () => {
    const getCompileInfoFn = vi.fn().mockResolvedValue({ file: 'foo.cpp', compiler: 'g++', includes: [], defines: [], extraFlags: [], standard: 'c++17' });
    const api = createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {
      getCompileInfoFn,
    });
    await api.getCompileInfo('foo.cpp');
    expect(getCompileInfoFn).toHaveBeenCalledWith('foo.cpp');
  });

  it('accepts empty opts object without throwing', () => {
    expect(() =>
      createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {})
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task 2: elicit()
// ---------------------------------------------------------------------------

describe('createSandboxAPI — elicit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { action: "cancel" } when elicitEnabled is false', async () => {
    const api = createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {
      elicitEnabled: false,
    });
    const result = await api.elicit('Pick one', {
      type: 'object',
      properties: { choice: { type: 'string', enum: ['a', 'b'] } },
      required: ['choice'],
    });
    expect(result).toEqual({ action: 'cancel' });
    expect(elicitOrFallback).not.toHaveBeenCalled();
  });

  it('returns { action: "cancel" } when server is absent (elicitEnabled true, no server)', async () => {
    const api = createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {
      elicitEnabled: true,
    });
    const result = await api.elicit('Pick one', {
      type: 'object',
      properties: { choice: { type: 'string' } },
    });
    expect(result).toEqual({ action: 'cancel' });
    expect(elicitOrFallback).not.toHaveBeenCalled();
  });

  it('calls elicitOrFallback and returns accept result', async () => {
    const mockServer = {} as McpServer;
    vi.mocked(elicitOrFallback).mockResolvedValueOnce({
      action: 'accept',
      content: { path: 'src/auth/AuthService.ts' },
    });
    const api = createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {
      elicitEnabled: true,
      mcpServer: mockServer,
    });
    const schema = {
      type: 'object' as const,
      properties: { path: { type: 'string' as const, enum: ['src/auth/AuthService.ts', 'lib/AuthService.ts'] } },
      required: ['path'],
    };
    const result = await api.elicit('Which file?', schema);
    expect(elicitOrFallback).toHaveBeenCalledWith(mockServer, 'Which file?', schema);
    expect(result).toEqual({ action: 'accept', content: { path: 'src/auth/AuthService.ts' } });
  });

  it('calls elicitOrFallback and returns cancel result', async () => {
    const mockServer = {} as McpServer;
    vi.mocked(elicitOrFallback).mockResolvedValueOnce({ action: 'cancel' });
    const api = createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {
      elicitEnabled: true,
      mcpServer: mockServer,
    });
    const result = await api.elicit('Pick project', {
      type: 'object',
      properties: { project: { type: 'string', enum: ['proj-a', 'proj-b'] } },
    });
    expect(result).toEqual({ action: 'cancel' });
  });

  it('calls elicitOrFallback and returns decline result', async () => {
    const mockServer = {} as McpServer;
    vi.mocked(elicitOrFallback).mockResolvedValueOnce({ action: 'decline' });
    const api = createSandboxAPI(makeMinimalClient(), makeMinimalMemoryBank(), {
      elicitEnabled: true,
      mcpServer: mockServer,
    });
    const result = await api.elicit('Confirm?', { type: 'object', properties: {} });
    expect(result).toEqual({ action: 'decline' });
  });
});
