import { describe, it, expect, vi, afterEach } from 'vitest';

describe('checkForUpdate (via status module)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runStatus completes even when fetch throws (network failure)', async () => {
    // Mock fetch to simulate network failure
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    vi.mock('../../server/client.js', () => ({
      OpenGrokClient: vi.fn().mockImplementation(() => ({
        listProjects: vi.fn().mockResolvedValue([]),
      })),
    }));
    vi.mock('../../server/config.js', () => ({
      loadConfig: vi.fn().mockReturnValue({
        OPENGROK_BASE_URL: 'https://og.example.com/',
        OPENGROK_USERNAME: '',
        OPENGROK_VERIFY_SSL: true,
        OPENGROK_CONTEXT_BUDGET: 'standard',
      }),
    }));
    vi.mock('../../server/cli/setup/detect.js', () => ({
      detectInstalledClients: vi.fn().mockReturnValue({ claudeCode: false, vscode: false, codex: false }),
    }));

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runStatus } = await import('../../server/cli/status.js');
    await expect(runStatus()).resolves.not.toThrow();
    vi.unstubAllGlobals();
  });
});
