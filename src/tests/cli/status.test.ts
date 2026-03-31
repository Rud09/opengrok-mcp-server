import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const listProjectsMock = vi.fn().mockResolvedValue([{ name: 'p1' }, { name: 'p2' }]);

vi.mock('../../server/client.js', () => ({
  OpenGrokClient: vi.fn().mockImplementation(() => ({
    listProjects: listProjectsMock,
  })),
}));

vi.mock('../../server/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    OPENGROK_BASE_URL: 'https://og.example.com/',
    OPENGROK_USERNAME: 'admin',
    OPENGROK_VERIFY_SSL: true,
    OPENGROK_CONTEXT_BUDGET: 'standard',
  }),
}));

vi.mock('../../server/cli/setup/detect.js', () => ({
  detectInstalledClients: vi.fn().mockReturnValue({
    claudeCode: true,
    vscode: false,
    codex: false,
  }),
}));

describe('runStatus', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('outputs server version line', async () => {
    const { runStatus } = await import('../../server/cli/status.js');
    await runStatus();
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('OpenGrok MCP Server');
  });

  it('shows project count', async () => {
    const { runStatus } = await import('../../server/cli/status.js');
    await runStatus();
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('2 indexed');
  });

  it('shows Claude Code CLI as configured', async () => {
    const { runStatus } = await import('../../server/cli/status.js');
    await runStatus();
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('✓');
    expect(output).toContain('Claude Code CLI');
  });

  it('handles unreachable OpenGrok server gracefully', async () => {
    listProjectsMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { runStatus } = await import('../../server/cli/status.js');
    await expect(runStatus()).resolves.not.toThrow();
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('unreachable');
  });
});
