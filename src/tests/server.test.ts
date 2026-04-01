import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  _capResponse as capResponse,
  _sanitizeErrorMessage as sanitizeErrorMessage,
  _resolveFileFromIndex as resolveFileFromIndex,
  _SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS_CODE_MODE_TEMPLATE,
  createServer,
} from '../server/server.js';
import type { CompileInfo } from '../server/local/compile-info.js';
import type { Config } from '../server/config.js';
import { logger } from '../server/logger.js';

// ---------------------------------------------------------------------------
// capResponse
// ---------------------------------------------------------------------------

describe('capResponse', () => {
  it('passes through text under 16 KB', () => {
    const small = 'Hello, world!';
    expect(capResponse(small)).toBe(small);
  });

  it('passes through text exactly at 16 KB', () => {
    // 16384 single-byte chars
    const exact = 'a'.repeat(16384);
    expect(capResponse(exact)).toBe(exact);
  });

  it('truncates text over 16 KB at newline boundary', () => {
    // Build a string > 16 KB with newlines every 100 chars
    const lines: string[] = [];
    while (Buffer.byteLength(lines.join('\n'), 'utf8') < 20000) {
      lines.push('x'.repeat(99));
    }
    const big = lines.join('\n');
    const result = capResponse(big);
    expect(result).toContain('[Response truncated');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(16384 + 200);
  });

  it('truncates at limit when no newline present', () => {
    const big = 'x'.repeat(20000);
    const result = capResponse(big);
    expect(result).toContain('[Response truncated');
  });

  it('handles multi-byte characters correctly', () => {
    // Each emoji is 4 bytes in UTF-8
    const emojis = '😀'.repeat(5000); // 20000 bytes
    const result = capResponse(emojis);
    expect(result).toContain('[Response truncated');
  });
});

// ---------------------------------------------------------------------------
// sanitizeErrorMessage
// ---------------------------------------------------------------------------

describe('sanitizeErrorMessage', () => {
  it('redacts Basic auth tokens', () => {
    const msg = 'Authorization: Basic dXNlcjpwYXNz failed';
    expect(sanitizeErrorMessage(msg)).toContain('Basic [REDACTED]');
    expect(sanitizeErrorMessage(msg)).not.toContain('dXNlcjpwYXNz');
  });

  it('redacts embedded credentials in URLs', () => {
    const msg = 'ECONNREFUSED https://user:secret@example.com/api';
    expect(sanitizeErrorMessage(msg)).toContain(':***@');
    expect(sanitizeErrorMessage(msg)).not.toContain('secret');
  });

  it('strips Unix filesystem paths', () => {
    expect(sanitizeErrorMessage('ENOENT /home/user/project/file.ts')).toContain('[path]');
    expect(sanitizeErrorMessage('ENOENT /tmp/build/output')).toContain('[path]');
    expect(sanitizeErrorMessage('ENOENT /var/lib/data')).toContain('[path]');
    expect(sanitizeErrorMessage('ENOENT /build/agent/work/src')).toContain('[path]');
    expect(sanitizeErrorMessage('ENOENT /opt/toolchain/bin')).toContain('[path]');
  });

  it('strips Windows filesystem paths', () => {
    expect(sanitizeErrorMessage('ENOENT C:\\Users\\dev\\project')).toContain('[path]');
    expect(sanitizeErrorMessage('ENOENT C:\\Program Files\\tool')).toContain('[path]');
  });

  it('preserves non-sensitive messages', () => {
    const msg = 'Connection refused on port 8080';
    expect(sanitizeErrorMessage(msg)).toBe(msg);
  });
});

// ---------------------------------------------------------------------------
// resolveFileFromIndex
// ---------------------------------------------------------------------------

describe('resolveFileFromIndex', () => {
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
    expect(resolveFileFromIndex('/pandora/foo.cpp', new Map(), new Map())).toBeNull();
  });

  it('returns direct hit when path is exact key', () => {
    const index = new Map([['/build/src/foo.cpp', makeInfo('/build/src/foo.cpp')]]);
    const suffixIndex = new Map<string, string>();
    expect(resolveFileFromIndex('/build/src/foo.cpp', index, suffixIndex)).toBe('/build/src/foo.cpp');
  });

  it('resolves via suffix index O(1) lookup', () => {
    const absPath = '/build/pandora/source/foo.cpp';
    const index = new Map([[absPath, makeInfo(absPath)]]);
    const suffixIndex = new Map([['/pandora/source/foo.cpp', absPath]]);
    expect(resolveFileFromIndex('/pandora/source/foo.cpp', index, suffixIndex)).toBe(absPath);
  });

  it('falls back to linear scan when suffix index misses', () => {
    const absPath = '/build/pandora/source/deep/bar.cpp';
    const index = new Map([[absPath, makeInfo(absPath)]]);
    // Empty suffix index — forces linear fallback
    const suffixIndex = new Map<string, string>();
    expect(resolveFileFromIndex('pandora/source/deep/bar.cpp', index, suffixIndex)).toBe(absPath);
  });

  it('returns null when no match at all', () => {
    const index = new Map([['/build/src/foo.cpp', makeInfo('/build/src/foo.cpp')]]);
    const suffixIndex = new Map<string, string>();
    expect(resolveFileFromIndex('nonexistent.cpp', index, suffixIndex)).toBeNull();
  });

  it('normalizes backslashes', () => {
    const absPath = '/build/src/foo.cpp';
    const index = new Map([[absPath, makeInfo(absPath)]]);
    const suffixIndex = new Map([['/src/foo.cpp', absPath]]);
    expect(resolveFileFromIndex('src\\foo.cpp', index, suffixIndex)).toBe(absPath);
  });
});

// ---------------------------------------------------------------------------
// Additional negative / edge-case tests
// ---------------------------------------------------------------------------

describe('sanitizeErrorMessage edge cases', () => {
  it('handles empty string', () => {
    expect(sanitizeErrorMessage('')).toBe('');
  });

  it('handles message with only a path', () => {
    expect(sanitizeErrorMessage('/home/user/secret')).toBe('[path]');
  });

  it('handles multiple credentials in one message', () => {
    const msg = 'Basic abc123 and user:pass@host and /home/user/file';
    const result = sanitizeErrorMessage(msg);
    expect(result).toContain('[REDACTED]');
    expect(result).toContain(':***@');
    expect(result).toContain('[path]');
  });
});

describe('capResponse edge cases', () => {
  it('handles empty string', () => {
    expect(capResponse('')).toBe('');
  });

  it('preserves single-line text under limit', () => {
    const text = 'no newlines here';
    expect(capResponse(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// SERVER_INSTRUCTIONS
// ---------------------------------------------------------------------------

describe('SERVER_INSTRUCTIONS', () => {
  it('does not reference non-existent opengrok_list_memory_files tool', () => {
    expect(_SERVER_INSTRUCTIONS).not.toContain('opengrok_list_memory_files');
  });

  it('does not reference memory tools (they are Code Mode only)', () => {
    // Memory tools (opengrok_update_memory etc.) are only registered in Code Mode,
    // so the standard-mode template must not mention them to avoid LLM confusion.
    expect(_SERVER_INSTRUCTIONS).not.toContain('opengrok_update_memory');
  });

  it('Code Mode template references memory files', () => {
    // Code Mode template should guide LLMs on using the memory bank
    expect(SERVER_INSTRUCTIONS_CODE_MODE_TEMPLATE).toContain('active-task.md');
    expect(SERVER_INSTRUCTIONS_CODE_MODE_TEMPLATE).toContain('investigation-log.md');
  });
});

// ---------------------------------------------------------------------------
// OPENGROK_ENABLE_CACHE_HINTS
// ---------------------------------------------------------------------------

describe('createServer with OPENGROK_ENABLE_CACHE_HINTS', () => {
  let logInfoSpy: any;

  beforeEach(() => {
    logInfoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    logInfoSpy.mockRestore();
  });

  it('logs info message when OPENGROK_ENABLE_CACHE_HINTS=true', () => {
    const mockClient = {
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

    const config: Config = {
      OPENGROK_BASE_URL: 'https://example.com/source/',
      OPENGROK_USERNAME: '',
      OPENGROK_PASSWORD: '',
      OPENGROK_PASSWORD_FILE: '',
      OPENGROK_PASSWORD_KEY: '',
      OPENGROK_VERIFY_SSL: true,
      OPENGROK_TIMEOUT: 30,
      OPENGROK_DEFAULT_MAX_RESULTS: 10,
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
      OPENGROK_DEFAULT_PROJECT: '',
      OPENGROK_CONTEXT_BUDGET: 'standard',
      OPENGROK_CODE_MODE: false,
      OPENGROK_MEMORY_BANK_DIR: '',
      OPENGROK_RESPONSE_FORMAT_OVERRIDE: '',
      OPENGROK_ENABLE_CACHE_HINTS: true,
    } as Config;

    createServer(mockClient as never, config, undefined);

    expect(logInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('OPENGROK_ENABLE_CACHE_HINTS=true')
    );
    expect(logInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('prompt caching')
    );
  });

  it('does not log info message when OPENGROK_ENABLE_CACHE_HINTS=false', () => {
    const mockClient = {
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

    const config: Config = {
      OPENGROK_BASE_URL: 'https://example.com/source/',
      OPENGROK_USERNAME: '',
      OPENGROK_PASSWORD: '',
      OPENGROK_PASSWORD_FILE: '',
      OPENGROK_PASSWORD_KEY: '',
      OPENGROK_VERIFY_SSL: true,
      OPENGROK_TIMEOUT: 30,
      OPENGROK_DEFAULT_MAX_RESULTS: 10,
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
      OPENGROK_DEFAULT_PROJECT: '',
      OPENGROK_CONTEXT_BUDGET: 'standard',
      OPENGROK_CODE_MODE: false,
      OPENGROK_MEMORY_BANK_DIR: '',
      OPENGROK_RESPONSE_FORMAT_OVERRIDE: '',
      OPENGROK_ENABLE_CACHE_HINTS: false,
    } as Config;

    createServer(mockClient as never, config, undefined);

    // Should not be called with the cache hints message
    const cacheHintsCalls = logInfoSpy.mock.calls.filter((call: any[]) =>
      call[0]?.includes?.('OPENGROK_ENABLE_CACHE_HINTS')
    );
    expect(cacheHintsCalls.length).toBe(0);
  });
});
