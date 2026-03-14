import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// We test the security-sensitive functions in isolation.
// For client tests that require real HTTP, use the live test script instead.

// ---------------------------------------------------------------------------
// assertSafePath (re-exported for testing)
// We test the path validation logic directly since it's critical security code.
// ---------------------------------------------------------------------------

// Import the relevant private logic by testing via the public interface
import { loadConfig, resetConfig } from '../server/config.js';

describe('loadConfig', () => {
  beforeEach(() => {
    resetConfig();
  });

  it('uses defaults when no env vars are set', () => {
    // Remove relevant env vars
    const saved = {
      OPENGROK_BASE_URL: process.env.OPENGROK_BASE_URL,
      OPENGROK_USERNAME: process.env.OPENGROK_USERNAME,
      OPENGROK_PASSWORD: process.env.OPENGROK_PASSWORD,
    };
    delete process.env.OPENGROK_BASE_URL;
    delete process.env.OPENGROK_USERNAME;
    delete process.env.OPENGROK_PASSWORD;

    const config = loadConfig();
    expect(config.OPENGROK_BASE_URL).toBe('https://opengrok.example.com/source/');
    expect(config.OPENGROK_VERIFY_SSL).toBe(true);
    expect(config.OPENGROK_CACHE_ENABLED).toBe(true);
    expect(config.OPENGROK_RATELIMIT_ENABLED).toBe(true);
    expect(config.OPENGROK_RATELIMIT_RPM).toBe(60);

    // Restore
    Object.assign(process.env, saved);
  });

  it('reads OPENGROK_BASE_URL from environment', () => {
    process.env.OPENGROK_BASE_URL = 'https://my-opengrok.example.com/source/';
    const config = loadConfig();
    expect(config.OPENGROK_BASE_URL).toBe('https://my-opengrok.example.com/source/');
    delete process.env.OPENGROK_BASE_URL;
  });

  it('parses OPENGROK_VERIFY_SSL=false correctly', () => {
    process.env.OPENGROK_VERIFY_SSL = 'false';
    const config = loadConfig();
    expect(config.OPENGROK_VERIFY_SSL).toBe(false);
    delete process.env.OPENGROK_VERIFY_SSL;
  });

  it('parses OPENGROK_CACHE_ENABLED=false correctly', () => {
    process.env.OPENGROK_CACHE_ENABLED = 'false';
    const config = loadConfig();
    expect(config.OPENGROK_CACHE_ENABLED).toBe(false);
    delete process.env.OPENGROK_CACHE_ENABLED;
  });
});

// ---------------------------------------------------------------------------
// Path safety (inline logic test)
// ---------------------------------------------------------------------------

describe('path traversal detection', () => {
  // Mirror the assertSafePath logic here for isolated unit testing
  function isSafePath(path: string): boolean {
    const normalized = path.replace(/\\/g, '/');
    return !(
      normalized.includes('/../') ||
      normalized.startsWith('../') ||
      normalized.endsWith('/..') ||
      normalized === '..'
    );
  }

  it('accepts normal paths', () => {
    expect(isSafePath('pandora/source/file.cpp')).toBe(true);
    expect(isSafePath('/pandora/source/file.cpp')).toBe(true);
    expect(isSafePath('file.cpp')).toBe(true);
  });

  it('rejects path traversal sequences', () => {
    expect(isSafePath('../etc/passwd')).toBe(false);
    expect(isSafePath('foo/../../etc/passwd')).toBe(false);
    expect(isSafePath('foo/..')).toBe(false);
    expect(isSafePath('..')).toBe(false);
  });

  it('rejects backslash-based traversal (Windows)', () => {
    expect(isSafePath('foo\\..\\etc\\passwd')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Zod schema validation for tool arguments
// ---------------------------------------------------------------------------

import {
  SearchCodeArgs,
  GetFileContentArgs,
  BrowseDirectoryArgs,
} from '../server/models.js';

describe('SearchCodeArgs schema', () => {
  it('accepts valid args', () => {
    const result = SearchCodeArgs.safeParse({ query: 'WeatherStation', max_results: 10 });
    expect(result.success).toBe(true);
  });

  it('rejects empty query', () => {
    const result = SearchCodeArgs.safeParse({ query: '' });
    expect(result.success).toBe(false);
  });

  it('rejects max_results > 100', () => {
    const result = SearchCodeArgs.safeParse({ query: 'test', max_results: 101 });
    expect(result.success).toBe(false);
  });

  it('defaults search_type to full', () => {
    const result = SearchCodeArgs.safeParse({ query: 'test' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.search_type).toBe('full');
  });
});

describe('GetFileContentArgs schema', () => {
  it('accepts valid project and path', () => {
    const result = GetFileContentArgs.safeParse({
      project: 'release-2.x',
      path: 'pandora/file.cpp',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing path', () => {
    const result = GetFileContentArgs.safeParse({ project: 'release-2.x' });
    expect(result.success).toBe(false);
  });
});

describe('BrowseDirectoryArgs schema', () => {
  it('defaults path to empty string', () => {
    const result = BrowseDirectoryArgs.safeParse({ project: 'release-2.x' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.path).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Credential file security tests (loadPassword functionality)
// Tests the secure credential file approach that prevents password exposure
// via process inspection (ps, /proc, Task Manager)
// ---------------------------------------------------------------------------

describe('credential file security', () => {
  let tempFilePath: string | null = null;
  let savedEnv: Record<string, string | undefined>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    resetConfig();
    // Save all relevant env vars
    savedEnv = {
      OPENGROK_BASE_URL: process.env.OPENGROK_BASE_URL,
      OPENGROK_USERNAME: process.env.OPENGROK_USERNAME,
      OPENGROK_PASSWORD: process.env.OPENGROK_PASSWORD,
      OPENGROK_PASSWORD_FILE: process.env.OPENGROK_PASSWORD_FILE,
      OPENGROK_PASSWORD_KEY: process.env.OPENGROK_PASSWORD_KEY,
    };
    // Clear them for clean test state
    delete process.env.OPENGROK_PASSWORD;
    delete process.env.OPENGROK_PASSWORD_FILE;
    delete process.env.OPENGROK_PASSWORD_KEY;
  });

  afterEach(() => {
    // Restore env vars
    Object.entries(savedEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
    // Clean up temp file if test didn't delete it
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {
        // Ignore cleanup errors
      }
    }
    tempFilePath = null;
    resetConfig();
    stderrSpy.mockRestore();
  });

  /**
   * Helper to create a plaintext credential file (legacy format)
   */
  function createPlaintextCredentialFile(password: string): string {
    const tempDir = os.tmpdir();
    const filename = `opengrok-cred-test-${crypto.randomBytes(8).toString('hex')}.tmp`;
    const filepath = path.join(tempDir, filename);
    fs.writeFileSync(filepath, password, { encoding: 'utf8', mode: 0o600 });
    tempFilePath = filepath;
    return filepath;
  }

  /**
   * Helper to create an encrypted credential file similar to what the extension creates
   * Uses AES-256-CBC encryption with format: base64(IV):base64(encryptedPassword)
   */
  function createEncryptedCredentialFile(password: string): { filepath: string; key: string } {
    const tempDir = os.tmpdir();
    const filename = `opengrok-cred-test-${crypto.randomBytes(8).toString('hex')}.tmp`;
    const filepath = path.join(tempDir, filename);
    
    // Generate encryption key (32 bytes for AES-256)
    const key = crypto.randomBytes(32);
    const keyBase64 = key.toString('base64');
    
    // Generate IV (16 bytes for AES-CBC)
    const iv = crypto.randomBytes(16);
    
    // Encrypt the password
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(password, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    
    // Write in format: base64(IV):base64(encryptedPassword)
    const fileContent = `${iv.toString('base64')}:${encrypted}`;
    fs.writeFileSync(filepath, fileContent, { encoding: 'utf8', mode: 0o600 });
    
    tempFilePath = filepath;
    return { filepath, key: keyBase64 };
  }

  // -------------------------------------------------------------------------
  // Encrypted credential file tests (new format with AES-256-CBC)
  // -------------------------------------------------------------------------

  it('reads password from encrypted credential file', () => {
    const testPassword = 'super-secret-password-123';
    const { filepath, key } = createEncryptedCredentialFile(testPassword);
    
    process.env.OPENGROK_PASSWORD_FILE = filepath;
    process.env.OPENGROK_PASSWORD_KEY = key;
    
    const config = loadConfig();
    expect(config.OPENGROK_PASSWORD).toBe(testPassword);
  });

  it('deletes encrypted credential file after reading', () => {
    const testPassword = 'delete-me-password';
    const { filepath, key } = createEncryptedCredentialFile(testPassword);
    
    // Verify file exists before loadConfig
    expect(fs.existsSync(filepath)).toBe(true);
    
    process.env.OPENGROK_PASSWORD_FILE = filepath;
    process.env.OPENGROK_PASSWORD_KEY = key;
    loadConfig();
    
    // File should be deleted after reading
    expect(fs.existsSync(filepath)).toBe(false);
    tempFilePath = null; // Already deleted, don't try cleanup
  });

  it('handles encrypted credential file with special characters', () => {
    const specialPassword = 'p@$$w0rd!#%^&*()_+-=[]{}|;:\'",.<>?/\\`~';
    const { filepath, key } = createEncryptedCredentialFile(specialPassword);
    
    process.env.OPENGROK_PASSWORD_FILE = filepath;
    process.env.OPENGROK_PASSWORD_KEY = key;
    
    const config = loadConfig();
    expect(config.OPENGROK_PASSWORD).toBe(specialPassword);
  });

  it('prefers encrypted credential file over env variable when both exist', () => {
    const filePassword = 'file-takes-priority';
    const envPassword = 'env-should-be-ignored';
    
    const { filepath, key } = createEncryptedCredentialFile(filePassword);
    process.env.OPENGROK_PASSWORD_FILE = filepath;
    process.env.OPENGROK_PASSWORD_KEY = key;
    process.env.OPENGROK_PASSWORD = envPassword;
    
    const config = loadConfig();
    expect(config.OPENGROK_PASSWORD).toBe(filePassword);
    expect(config.OPENGROK_PASSWORD).not.toBe(envPassword);
  });

  it('falls back to env variable when encrypted credential file decryption fails', () => {
    const envPassword = 'fallback-env-password';
    const { filepath } = createEncryptedCredentialFile('some-password');
    
    // Use wrong key - should fail decryption
    const wrongKey = crypto.randomBytes(32).toString('base64');
    
    process.env.OPENGROK_PASSWORD = envPassword;
    process.env.OPENGROK_PASSWORD_FILE = filepath;
    process.env.OPENGROK_PASSWORD_KEY = wrongKey;
    
    const config = loadConfig();
    // Should fall back to env password when decryption fails
    expect(config.OPENGROK_PASSWORD).toBe(envPassword);
  });

  // -------------------------------------------------------------------------
  // Legacy plaintext credential file tests (backwards compatibility)
  // -------------------------------------------------------------------------

  it('reads password from plaintext credential file (legacy)', () => {
    const testPassword = 'legacy-plaintext-password';
    const credFile = createPlaintextCredentialFile(testPassword);
    
    // No encryption key means legacy mode
    process.env.OPENGROK_PASSWORD_FILE = credFile;
    
    const config = loadConfig();
    expect(config.OPENGROK_PASSWORD).toBe(testPassword);
  });

  it('deletes plaintext credential file after reading (legacy)', () => {
    const testPassword = 'delete-me-plaintext';
    const credFile = createPlaintextCredentialFile(testPassword);
    
    // Verify file exists before loadConfig
    expect(fs.existsSync(credFile)).toBe(true);
    
    process.env.OPENGROK_PASSWORD_FILE = credFile;
    loadConfig();
    
    // File should be deleted after reading
    expect(fs.existsSync(credFile)).toBe(false);
    tempFilePath = null; // Already deleted, don't try cleanup
  });

  it('trims whitespace from plaintext credential file content (legacy)', () => {
    const testPassword = 'password-with-whitespace';
    const credFile = createPlaintextCredentialFile(`  ${testPassword}  \n`);
    
    process.env.OPENGROK_PASSWORD_FILE = credFile;
    
    const config = loadConfig();
    expect(config.OPENGROK_PASSWORD).toBe(testPassword);
  });

  // -------------------------------------------------------------------------
  // Common fallback tests
  // -------------------------------------------------------------------------

  it('falls back to env variable when credential file does not exist', () => {
    const envPassword = 'fallback-env-password';
    process.env.OPENGROK_PASSWORD = envPassword;
    process.env.OPENGROK_PASSWORD_FILE = '/nonexistent/path/to/credential.tmp';
    process.env.OPENGROK_PASSWORD_KEY = crypto.randomBytes(32).toString('base64');
    
    const config = loadConfig();
    expect(config.OPENGROK_PASSWORD).toBe(envPassword);
  });

  it('returns empty password when neither file nor env exists', () => {
    // Ensure both are unset
    delete process.env.OPENGROK_PASSWORD;
    delete process.env.OPENGROK_PASSWORD_FILE;
    delete process.env.OPENGROK_PASSWORD_KEY;
    
    const config = loadConfig();
    expect(config.OPENGROK_PASSWORD).toBe('');
  });

  it('creates credential file with restricted permissions (Unix)', () => {
    // This test is only meaningful on Unix-like systems
    if (process.platform === 'win32') {
      return; // Skip on Windows - permissions work differently
    }
    
    const testPassword = 'permission-test';
    const { filepath, key } = createEncryptedCredentialFile(testPassword);
    
    const stats = fs.statSync(filepath);
    // Check that only owner has read/write (0o600 = rw-------)
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
    
    // Clean up for this test since we didn't call loadConfig
    process.env.OPENGROK_PASSWORD_FILE = filepath;
    process.env.OPENGROK_PASSWORD_KEY = key;
  });
});

// ---------------------------------------------------------------------------
// Config NaN guard (validates Phase 1 fix — zIntString rejects non-numeric)
// ---------------------------------------------------------------------------

describe('config NaN guard', () => {
  let savedEnv: Record<string, string | undefined>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    resetConfig();
    savedEnv = {
      OPENGROK_BASE_URL: process.env.OPENGROK_BASE_URL,
      OPENGROK_TIMEOUT: process.env.OPENGROK_TIMEOUT,
      OPENGROK_CACHE_MAX_SIZE: process.env.OPENGROK_CACHE_MAX_SIZE,
    };
    process.env.OPENGROK_BASE_URL = 'https://example.com/source/';
  });

  afterEach(() => {
    Object.entries(savedEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
    resetConfig();
    stderrSpy.mockRestore();
  });

  it('rejects non-numeric OPENGROK_TIMEOUT', () => {
    process.env.OPENGROK_TIMEOUT = 'abc';
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit'); }) as never);
    try {
      loadConfig();
      // If we get here, process.exit was never called — fail the test
      expect.unreachable('loadConfig should have called process.exit');
    } catch (e: any) {
      // Either Zod transform error or our mocked process.exit error — both acceptable
      expect(e.message).toMatch(/process\.exit|expected integer/);
    } finally {
      mockExit.mockRestore();
    }
  });

  it('rejects non-numeric OPENGROK_CACHE_MAX_SIZE', () => {
    process.env.OPENGROK_CACHE_MAX_SIZE = 'not-a-number';
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit'); }) as never);
    try {
      loadConfig();
      expect.unreachable('loadConfig should have called process.exit');
    } catch (e: any) {
      expect(e.message).toMatch(/process\.exit|expected integer/);
    } finally {
      mockExit.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// extractLineRange (indexOf-based extraction)
// ---------------------------------------------------------------------------

import { extractLineRange } from '../server/client.js';

describe('extractLineRange', () => {
  const sampleContent = 'line1\nline2\nline3\nline4\nline5';

  it('returns full content when no range specified', () => {
    const result = extractLineRange(sampleContent);
    expect(result.text).toBe(sampleContent);
    expect(result.totalLines).toBe(5);
  });

  it('extracts a middle range', () => {
    const result = extractLineRange(sampleContent, 2, 4);
    expect(result.text).toBe('line2\nline3\nline4');
    expect(result.totalLines).toBe(5);
  });

  it('extracts a single line', () => {
    const result = extractLineRange(sampleContent, 3, 3);
    expect(result.text).toBe('line3');
    expect(result.totalLines).toBe(5);
  });

  it('clamps range beyond end of content', () => {
    const result = extractLineRange(sampleContent, 4, 100);
    expect(result.text).toBe('line4\nline5');
    expect(result.totalLines).toBe(5);
  });

  it('handles empty content', () => {
    const result = extractLineRange('', 1, 1);
    expect(result.text).toBe('');
    expect(result.totalLines).toBe(1);
  });

  it('handles content without trailing newline', () => {
    const result = extractLineRange('abc\ndef', 2, 2);
    expect(result.text).toBe('def');
    expect(result.totalLines).toBe(2);
  });

  it('handles content with trailing newline', () => {
    const result = extractLineRange('abc\ndef\n', 1, 2);
    expect(result.text).toBe('abc\ndef');
    expect(result.totalLines).toBe(3);
  });

  it('returns first line when range is 1,1', () => {
    const result = extractLineRange(sampleContent, 1, 1);
    expect(result.text).toBe('line1');
  });
});
