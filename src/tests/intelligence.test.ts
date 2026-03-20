import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildFileOverview, buildCallChain } from '../server/intelligence.js';
import type { OpenGrokClient } from '../server/client.js';

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function makeClient(overrides: Partial<Record<string, (...args: any[]) => any>> = {}): OpenGrokClient {
  return {
    search: vi.fn().mockResolvedValue({
      query: '', searchType: 'refs', totalCount: 0, timeMs: 1,
      results: [], startIndex: 0, endIndex: 0, hasMore: false,
    }),
    getFileSymbols: vi.fn().mockResolvedValue({
      project: 'proj', path: 'file.cpp', symbols: [],
    }),
    getFileContent: vi.fn().mockResolvedValue({
      project: 'proj', path: 'file.cpp',
      content: '#include "EventLoop.h"\n#include <vector>\nvoid foo() {}',
      lineCount: 3, sizeBytes: 50, startLine: 1,
    }),
    getFileHistory: vi.fn().mockResolvedValue({
      project: 'proj', path: 'file.cpp',
      entries: [
        { revision: 'abcdef12', date: '2025-01-01', author: 'Alice <alice@example.com>', message: 'fix bug' },
        { revision: 'beef1234', date: '2025-01-02', author: 'Bob <bob@example.com>', message: 'refactor' },
      ],
    }),
    ...overrides,
  } as unknown as OpenGrokClient;
}

// ---------------------------------------------------------------------------
// buildFileOverview
// ---------------------------------------------------------------------------

describe('buildFileOverview', () => {
  it('returns correct lang for .cpp file', async () => {
    const client = makeClient();
    const result = await buildFileOverview(client, 'proj', 'src/EventLoop.cpp');
    expect(result.lang).toBe('cpp');
  });

  it('returns correct lang for .py file', async () => {
    const client = makeClient();
    const result = await buildFileOverview(client, 'proj', 'main.py');
    expect(result.lang).toBe('python');
  });

  it('extracts recentAuthors from history', async () => {
    const client = makeClient();
    const result = await buildFileOverview(client, 'proj', 'file.cpp');
    expect(result.recentAuthors).toContain('Alice');
    expect(result.recentAuthors).toContain('Bob');
  });

  it('returns sizeLines from file content', async () => {
    const client = makeClient();
    const result = await buildFileOverview(client, 'proj', 'file.cpp');
    expect(result.sizeLines).toBe(3);
  });

  it('extracts C++ imports from file header', async () => {
    const client = makeClient();
    const result = await buildFileOverview(client, 'proj', 'file.cpp');
    expect(result.imports).toContain('EventLoop.h');
    expect(result.imports).toContain('vector');
  });

  it('makes parallel API calls (symbols + content + history)', async () => {
    const client = makeClient();
    await buildFileOverview(client, 'proj', 'file.cpp');
    // All three should have been called
    expect(client.getFileSymbols).toHaveBeenCalledWith('proj', 'file.cpp');
    expect(client.getFileContent).toHaveBeenCalledWith('proj', 'file.cpp', 1, 30);
    expect(client.getFileHistory).toHaveBeenCalledWith('proj', 'file.cpp', 3);
  });

  it('handles settled-failed symbol request gracefully', async () => {
    const client = makeClient({
      getFileSymbols: vi.fn().mockRejectedValue(new Error('symbols unavailable')),
    });
    const result = await buildFileOverview(client, 'proj', 'file.cpp');
    // Should still return a result without throwing
    expect(result.topLevelSymbols).toEqual([]);
    expect(result.recentAuthors.length).toBeGreaterThan(0); // history succeeded
  });

  it('handles settled-failed history request gracefully', async () => {
    const client = makeClient({
      getFileHistory: vi.fn().mockRejectedValue(new Error('history unavailable')),
    });
    const result = await buildFileOverview(client, 'proj', 'file.cpp');
    expect(result.recentAuthors).toEqual([]);
    expect(result.lastRevision).toBe('unknown');
  });

  it('includes topLevelSymbols from file symbols', async () => {
    const client = makeClient({
      getFileSymbols: vi.fn().mockResolvedValue({
        project: 'proj', path: 'file.cpp',
        symbols: [
          { symbol: 'EventLoop', type: 'class', line: 10, lineStart: 10, lineEnd: 50, signature: null, namespace: null },
          { symbol: 'run', type: 'function', line: 20, lineStart: 20, lineEnd: 30, signature: '()', namespace: null },
        ],
      }),
    });
    const result = await buildFileOverview(client, 'proj', 'file.cpp');
    expect(result.topLevelSymbols.length).toBeGreaterThan(0);
    const symbols = result.topLevelSymbols.map(s => s.symbol);
    expect(symbols).toContain('EventLoop');
  });
});

// ---------------------------------------------------------------------------
// buildCallChain
// ---------------------------------------------------------------------------

describe('buildCallChain', () => {
  it('returns empty callers when no refs found', async () => {
    const client = makeClient();
    const result = await buildCallChain(client, 'UnknownFn', 'callers', 2);
    expect(result.callers).toEqual([]);
    expect(result.symbol).toBe('UnknownFn');
  });

  it('callers direction: makes a refs search', async () => {
    const client = makeClient();
    await buildCallChain(client, 'MyFn', 'callers', 1);
    expect(client.search).toHaveBeenCalledWith('MyFn', 'refs', undefined, 10, 0);
  });

  it('callees direction: always returns empty callees array', async () => {
    const client = makeClient({
      search: vi.fn().mockResolvedValue({
        query: 'MyFn', searchType: 'refs', totalCount: 1, timeMs: 1,
        results: [{ project: 'p', path: 'f.cpp', matches: [{ lineNumber: 10, lineContent: 'MyFn()' }] }],
        startIndex: 0, endIndex: 1, hasMore: false,
      }),
    });
    const result = await buildCallChain(client, 'MyFn', 'callees', 2);
    expect(result.callees).toEqual([]);
  });

  it('callees direction: does NOT make API search calls', async () => {
    const client = makeClient();
    await buildCallChain(client, 'MyFn', 'callees', 2);
    // With callees direction, no search should be made
    expect(client.search).not.toHaveBeenCalled();
  });

  it('caps depth at MAX_CALL_CHAIN_DEPTH (4)', async () => {
    const client = makeClient();
    const result = await buildCallChain(client, 'DeepFn', 'callers', 10);
    expect(result.truncatedAt).toBe(4);
  });

  it('does not truncate when depth <= 4', async () => {
    const client = makeClient();
    const result = await buildCallChain(client, 'MyFn', 'callers', 2);
    expect(result.truncatedAt).toBeUndefined();
  });

  it('handles error in refs search gracefully', async () => {
    const client = makeClient({
      search: vi.fn().mockRejectedValue(new Error('search failed')),
    });
    const result = await buildCallChain(client, 'MyFn', 'callers', 2);
    expect(result.callers).toEqual([]);
  });

  it('returns caller nodes when refs are found', async () => {
    const client = makeClient({
      search: vi.fn().mockResolvedValue({
        query: 'crashHandler', searchType: 'refs', totalCount: 1, timeMs: 1,
        results: [{
          project: 'myproject',
          path: 'src/main.cpp',
          matches: [{ lineNumber: 42, lineContent: 'crashHandler()' }],
        }],
        startIndex: 0, endIndex: 1, hasMore: false,
      }),
      getFileSymbols: vi.fn().mockResolvedValue({
        project: 'myproject', path: 'src/main.cpp',
        symbols: [
          { symbol: 'main', type: 'function', line: 1, lineStart: 1, lineEnd: 100, signature: '()', namespace: null },
        ],
      }),
    });
    const result = await buildCallChain(client, 'crashHandler', 'callers', 1);
    expect(result.callers.length).toBeGreaterThan(0);
    expect(result.callers[0].path).toBe('src/main.cpp');
    expect(result.callers[0].project).toBe('myproject');
  });
});
