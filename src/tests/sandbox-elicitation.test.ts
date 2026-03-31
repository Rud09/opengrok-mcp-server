/**
 * Unit tests for createSandboxAPI — elicit/sample/suggestions.
 * Mocks elicitation.js and sampling.js to avoid real MCP client dependency.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSandboxAPI } from '../server/sandbox.js';
import type { OpenGrokClient } from '../server/client.js';
import type { MemoryBank } from '../server/memory-bank.js';

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
