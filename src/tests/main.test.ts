/**
 * Tests for main.ts — entry point, --version flag, main function.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// main.ts has module-level side effects (process.argv check, process.exit).
// We test it by dynamically importing with mocked process.argv.

describe('main.ts', () => {
  const originalArgv = process.argv;
  const originalExit = process.exit;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  it('prints version and exits when --version flag is present', async () => {
    let exitCode: number | undefined;
    let consoleOutput: string | undefined;

    process.argv = ['node', 'main.js', '--version'];
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    }) as never;

    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      consoleOutput = msg;
    });

    try {
      await import('../server/main.js?v=1');
    } catch (e: any) {
      if (!e.message?.includes('process.exit')) throw e;
    }

    expect(exitCode).toBe(0);
    spy.mockRestore();
  });

  it('prints version with -v flag', async () => {
    let exitCode: number | undefined;

    process.argv = ['node', 'main.js', '-v'];
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    }) as never;

    vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await import('../server/main.js?v=2');
    } catch (e: any) {
      if (!e.message?.includes('process.exit')) throw e;
    }

    expect(exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveConfig tests — mock dependencies, import the exported helper directly
// ─────────────────────────────────────────────────────────────────────────────

const keychainMocks = vi.hoisted(() => ({
  retrievePasswordResult: null as string | null,
}));

vi.mock('../server/cli/keychain.js', () => ({
  retrievePassword: vi.fn((_username: string) => keychainMocks.retrievePasswordResult),
}));

describe('resolveConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Restore env to a clean state before each test
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('OPENGROK_')) {
        delete process.env[key];
      }
    }
    keychainMocks.retrievePasswordResult = null;
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('OPENGROK_')) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it('uses keychain password when OPENGROK_PASSWORD is empty and keychain has a password', async () => {
    process.env['OPENGROK_BASE_URL'] = 'https://test.example.com/source/';
    process.env['OPENGROK_USERNAME'] = 'testuser';
    process.env['OPENGROK_PASSWORD'] = '';
    keychainMocks.retrievePasswordResult = 'keychain-secret';

    // Import after setting env so loadConfig picks up the env
    const { resolveConfig } = await import('../server/main.js?resolveConfig=1');
    const config = await resolveConfig();

    expect(config.OPENGROK_PASSWORD).toBe('keychain-secret');
  });

  it('skips keychain when OPENGROK_PASSWORD is already set in env', async () => {
    process.env['OPENGROK_BASE_URL'] = 'https://test.example.com/source/';
    process.env['OPENGROK_USERNAME'] = 'testuser';
    process.env['OPENGROK_PASSWORD'] = 'env-password';
    keychainMocks.retrievePasswordResult = 'keychain-secret';

    const { resolveConfig } = await import('../server/main.js?resolveConfig=2');
    const config = await resolveConfig();

    // env password takes precedence — keychain should not be used
    expect(config.OPENGROK_PASSWORD).toBe('env-password');
  });

  it('returns config unchanged when no username is set', async () => {
    process.env['OPENGROK_BASE_URL'] = 'https://test.example.com/source/';
    process.env['OPENGROK_USERNAME'] = '';
    process.env['OPENGROK_PASSWORD'] = '';
    keychainMocks.retrievePasswordResult = 'keychain-secret';

    const { resolveConfig } = await import('../server/main.js?resolveConfig=3');
    const config = await resolveConfig();

    // No username → keychain lookup skipped
    expect(config.OPENGROK_PASSWORD).toBe('');
  });
});
