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
    OPENGROK_CODE_MODE: true,
  }),
}));

vi.mock('../../server/cli/keychain.js', () => ({
  retrievePassword: vi.fn().mockReturnValue(null),
}));

vi.mock('../../server/cli/setup/detect.js', () => ({
  detectInstalledClients: vi.fn().mockReturnValue({
    claudeCode: true,
    codex: false,
    copilotCli: false,
  }),
}));

// Prevent status.ts from reading the real ~/.claude.json during tests
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
  };
});

describe('runStatus', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Ensure OPENGROK_BASE_URL is set so readEnvFromClaudeCode is skipped
    process.env['OPENGROK_BASE_URL'] = 'https://og.example.com/';
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env['OPENGROK_BASE_URL'];
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
