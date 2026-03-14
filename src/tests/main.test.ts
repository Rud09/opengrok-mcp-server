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
