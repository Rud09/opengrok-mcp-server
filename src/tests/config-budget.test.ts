import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BUDGET_LIMITS, loadConfig, resetConfig } from '../server/config.js';

// ---------------------------------------------------------------------------
// BUDGET_LIMITS constants
// ---------------------------------------------------------------------------

describe('BUDGET_LIMITS', () => {
  it('minimal has correct byte/line values', () => {
    expect(BUDGET_LIMITS.minimal.maxResponseBytes).toBe(4_096);
    expect(BUDGET_LIMITS.minimal.maxInlineLines).toBe(50);
    expect(BUDGET_LIMITS.minimal.contextLines).toBe(3);
    expect(BUDGET_LIMITS.minimal.maxSearchResults).toBe(5);
    expect(BUDGET_LIMITS.minimal.searchAndReadCap).toBe(2_048);
  });

  it('standard has correct byte/line values', () => {
    expect(BUDGET_LIMITS.standard.maxResponseBytes).toBe(8_192);
    expect(BUDGET_LIMITS.standard.maxInlineLines).toBe(100);
    expect(BUDGET_LIMITS.standard.contextLines).toBe(5);
    expect(BUDGET_LIMITS.standard.maxSearchResults).toBe(10);
    expect(BUDGET_LIMITS.standard.searchAndReadCap).toBe(4_096);
  });

  it('generous has correct byte/line values', () => {
    expect(BUDGET_LIMITS.generous.maxResponseBytes).toBe(16_384);
    expect(BUDGET_LIMITS.generous.maxInlineLines).toBe(200);
    expect(BUDGET_LIMITS.generous.contextLines).toBe(10);
    expect(BUDGET_LIMITS.generous.maxSearchResults).toBe(25);
    expect(BUDGET_LIMITS.generous.searchAndReadCap).toBe(8_192);
  });
});

// ---------------------------------------------------------------------------
// loadConfig() env var parsing
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  beforeEach(() => {
    resetConfig();
    // Set required URL to avoid validation error
    process.env.OPENGROK_BASE_URL = 'https://opengrok.test/source/';
  });

  afterEach(() => {
    resetConfig();
    delete process.env.OPENGROK_BASE_URL;
    delete process.env.OPENGROK_CONTEXT_BUDGET;
    delete process.env.OPENGROK_CODE_MODE;
    delete process.env.OPENGROK_MEMORY_BANK_DIR;
    delete process.env.OPENGROK_TIMEOUT;
  });

  it('reads OPENGROK_CONTEXT_BUDGET=standard', () => {
    process.env.OPENGROK_CONTEXT_BUDGET = 'standard';
    const cfg = loadConfig();
    expect(cfg.OPENGROK_CONTEXT_BUDGET).toBe('standard');
  });

  it('reads OPENGROK_CONTEXT_BUDGET=generous', () => {
    process.env.OPENGROK_CONTEXT_BUDGET = 'generous';
    const cfg = loadConfig();
    expect(cfg.OPENGROK_CONTEXT_BUDGET).toBe('generous');
  });

  it('defaults OPENGROK_CONTEXT_BUDGET to minimal', () => {
    delete process.env.OPENGROK_CONTEXT_BUDGET;
    const cfg = loadConfig();
    expect(cfg.OPENGROK_CONTEXT_BUDGET).toBe('minimal');
  });

  it('defaults OPENGROK_CODE_MODE to true', () => {
    delete process.env.OPENGROK_CODE_MODE;
    const cfg = loadConfig();
    expect(cfg.OPENGROK_CODE_MODE).toBe(true);
  });

  it('parses OPENGROK_CODE_MODE=true to boolean true', () => {
    process.env.OPENGROK_CODE_MODE = 'true';
    const cfg = loadConfig();
    expect(cfg.OPENGROK_CODE_MODE).toBe(true);
  });

  it('parses OPENGROK_CODE_MODE=false to boolean false', () => {
    process.env.OPENGROK_CODE_MODE = 'false';
    const cfg = loadConfig();
    expect(cfg.OPENGROK_CODE_MODE).toBe(false);
  });

  it('defaults OPENGROK_MEMORY_BANK_DIR to empty string', () => {
    delete process.env.OPENGROK_MEMORY_BANK_DIR;
    const cfg = loadConfig();
    expect(cfg.OPENGROK_MEMORY_BANK_DIR).toBe('');
  });

  it('returns cached config on second call', () => {
    const cfg1 = loadConfig();
    const cfg2 = loadConfig();
    expect(cfg1).toBe(cfg2); // same reference — singleton
  });

  it('throws or exits on invalid OPENGROK_TIMEOUT (non-integer)', () => {
    process.env.OPENGROK_TIMEOUT = 'not-an-integer';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    let threw = false;
    try {
      loadConfig();
    } catch {
      threw = true;
    }
    // Zod v4 throws from transforms; either process.exit or an exception signals invalid config
    expect(threw || exitSpy.mock.calls.length > 0).toBe(true);
    exitSpy.mockRestore();
  });

  it('exits when OPENGROK_USERNAME is set but password is empty', () => {
    process.env.OPENGROK_USERNAME = 'admin';
    delete process.env.OPENGROK_PASSWORD;
    delete process.env.OPENGROK_PASSWORD_FILE;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: any) => {
      throw new Error('process.exit');
    });
    expect(() => loadConfig()).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    delete process.env.OPENGROK_USERNAME;
  });

  it('exits when HTTP_PROXY has an invalid scheme (ftp)', () => {
    process.env.HTTP_PROXY = 'ftp://proxy.example.com:8080';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: any) => {
      throw new Error('process.exit');
    });
    expect(() => loadConfig()).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    delete process.env.HTTP_PROXY;
  });

  it('exits when HTTPS_PROXY is not a valid URL', () => {
    process.env.HTTPS_PROXY = 'not-a-url';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: any) => {
      throw new Error('process.exit');
    });
    expect(() => loadConfig()).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    delete process.env.HTTPS_PROXY;
  });
});
