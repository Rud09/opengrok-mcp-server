import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Mocks must be declared at the top level so vitest can hoist them.
// We use vi.hoisted() to create shared state that factory closures can capture.
// ─────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  spawnSyncStatus: 0 as number | null,
  existsResult: false,
  readFileResult: '',
  writeFileCalls: [] as Array<[string, string]>,
  mkdirCalls: 0,
}));

vi.mock('child_process', () => ({
  spawnSync: vi.fn((_cmd: string, _args: string[]) => ({
    status: mocks.spawnSyncStatus,
    pid: 1,
    output: [],
    stdout: '',
    stderr: mocks.spawnSyncStatus !== 0 ? 'error' : '',
    signal: null,
    error: undefined,
  })),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => mocks.existsResult),
    mkdirSync: vi.fn(() => { mocks.mkdirCalls++; }),
    readFileSync: vi.fn((_path: string, _enc: string) => mocks.readFileResult),
    writeFileSync: vi.fn((_path: string, data: string) => {
      mocks.writeFileCalls.push([_path as string, data]);
    }),
  };
});

// ─────────────────────────────────────────────────────────────────────────────

describe('detectInstalledClients', () => {
  beforeEach(() => {
    mocks.spawnSyncStatus = 0;
    mocks.existsResult = false;
    mocks.writeFileCalls = [];
  });

  it('reports claudeCode=true when claude --version exits 0', async () => {
    mocks.spawnSyncStatus = 0;
    const { detectInstalledClients } = await import('../../server/cli/setup/detect.js');
    const result = detectInstalledClients();
    expect(result.claudeCode).toBe(true);
  });

  it('reports claudeCode=false when claude --version exits non-zero', async () => {
    mocks.spawnSyncStatus = 1;
    const { detectInstalledClients } = await import('../../server/cli/setup/detect.js');
    const result = detectInstalledClients();
    expect(result.claudeCode).toBe(false);
  });

  it('reports vscode=true when code --version exits 0', async () => {
    mocks.spawnSyncStatus = 0;
    const { detectInstalledClients } = await import('../../server/cli/setup/detect.js');
    const result = detectInstalledClients();
    expect(result.vscode).toBe(true);
  });

  it('reports codex=false when config file does not exist', async () => {
    mocks.spawnSyncStatus = 1;
    mocks.existsResult = false;
    const { detectInstalledClients } = await import('../../server/cli/setup/detect.js');
    const result = detectInstalledClients();
    expect(result.codex).toBe(false);
  });

  it('reports codex=true when config file exists', async () => {
    mocks.spawnSyncStatus = 1;
    mocks.existsResult = true;
    const { detectInstalledClients } = await import('../../server/cli/setup/detect.js');
    const result = detectInstalledClients();
    expect(result.codex).toBe(true);
  });
});

describe('configureClaudeCode', () => {
  beforeEach(() => {
    mocks.spawnSyncStatus = 0;
    mocks.writeFileCalls = [];
    vi.clearAllMocks();
  });

  afterEach(() => vi.clearAllMocks());

  it('calls claude mcp add with array args (no shell injection)', async () => {
    mocks.spawnSyncStatus = 0;
    const cp = await import('child_process');
    const { configureClaudeCode } = await import('../../server/cli/setup/configure.js');
    configureClaudeCode({ url: 'https://og.example.com', scope: 'user' });
    expect(cp.spawnSync).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['mcp', 'add']),
      expect.objectContaining({ shell: false })
    );
  });

  it('throws when claude mcp add fails', async () => {
    mocks.spawnSyncStatus = 1;
    const { configureClaudeCode } = await import('../../server/cli/setup/configure.js');
    expect(() => configureClaudeCode({ url: 'https://og.example.com' })).toThrow(/failed/);
  });

  it('uses user scope by default', async () => {
    mocks.spawnSyncStatus = 0;
    const cp = await import('child_process');
    const { configureClaudeCode } = await import('../../server/cli/setup/configure.js');
    configureClaudeCode({ url: 'https://og.example.com' });
    expect(cp.spawnSync).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--scope', 'user']),
      expect.anything()
    );
  });

  it('includes OPENGROK_USERNAME in args when username is provided', async () => {
    mocks.spawnSyncStatus = 0;
    const cp = await import('child_process');
    const { configureClaudeCode } = await import('../../server/cli/setup/configure.js');
    configureClaudeCode({ url: 'https://og.example.com', username: 'alice' });
    expect(cp.spawnSync).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--env', 'OPENGROK_USERNAME=alice']),
      expect.anything()
    );
  });

  it('omits OPENGROK_USERNAME in args when username is not provided', async () => {
    mocks.spawnSyncStatus = 0;
    const cp = await import('child_process');
    const { configureClaudeCode } = await import('../../server/cli/setup/configure.js');
    configureClaudeCode({ url: 'https://og.example.com' });
    const callArgs = (cp.spawnSync as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
    const usernameIndex = callArgs.findIndex((a) => a.startsWith('OPENGROK_USERNAME'));
    expect(usernameIndex).toBe(-1);
  });
});

describe('configureVSCode', () => {
  beforeEach(() => {
    mocks.spawnSyncStatus = 0;
    vi.clearAllMocks();
  });

  afterEach(() => vi.clearAllMocks());

  it('calls code --add-mcp with shell: false', async () => {
    mocks.spawnSyncStatus = 0;
    const cp = await import('child_process');
    const { configureVSCode } = await import('../../server/cli/setup/configure.js');
    configureVSCode({ url: 'https://og.example.com' });
    expect(cp.spawnSync).toHaveBeenCalledWith(
      'code',
      expect.arrayContaining(['--add-mcp']),
      expect.objectContaining({ shell: false })
    );
  });

  it('throws when code --add-mcp fails', async () => {
    mocks.spawnSyncStatus = 1;
    const { configureVSCode } = await import('../../server/cli/setup/configure.js');
    expect(() => configureVSCode({ url: 'https://og.example.com' })).toThrow(/failed/);
  });

  it('includes OPENGROK_USERNAME in MCP definition when username is provided', async () => {
    mocks.spawnSyncStatus = 0;
    const cp = await import('child_process');
    const { configureVSCode } = await import('../../server/cli/setup/configure.js');
    configureVSCode({ url: 'https://og.example.com', username: 'bob' });
    const callArgs = (cp.spawnSync as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
    // The second arg to spawnSync is ['--add-mcp', JSON_STRING]
    const mcpJson = callArgs.find((a) => a.includes('OPENGROK_BASE_URL')) ?? '';
    const parsed = JSON.parse(mcpJson) as { env: Record<string, string> };
    expect(parsed.env['OPENGROK_USERNAME']).toBe('bob');
  });

  it('omits OPENGROK_USERNAME from MCP definition when username is not provided', async () => {
    mocks.spawnSyncStatus = 0;
    const cp = await import('child_process');
    const { configureVSCode } = await import('../../server/cli/setup/configure.js');
    configureVSCode({ url: 'https://og.example.com' });
    const callArgs = (cp.spawnSync as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
    const mcpJson = callArgs.find((a) => a.includes('OPENGROK_BASE_URL')) ?? '';
    const parsed = JSON.parse(mcpJson) as { env: Record<string, string> };
    expect(parsed.env['OPENGROK_USERNAME']).toBeUndefined();
  });
});

describe('configureCodex', () => {
  beforeEach(() => {
    mocks.existsResult = false;
    mocks.readFileResult = '';
    mocks.writeFileCalls = [];
    mocks.mkdirCalls = 0;
    vi.clearAllMocks();
  });

  afterEach(() => vi.clearAllMocks());

  it('writes TOML with mcp_servers entry', async () => {
    mocks.existsResult = false;
    const { configureCodex } = await import('../../server/cli/setup/configure.js');
    configureCodex({ url: 'https://og.example.com' });

    const fs = await import('fs');
    expect(fs.writeFileSync).toHaveBeenCalled();
    const written = String((fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]);
    expect(written).toContain('opengrok-mcp');
    expect(written).toContain('npx');
  });

  it('is idempotent — replaces existing opengrok-mcp entry', async () => {
    const existingToml = `[[mcp_servers]]
name = "opengrok-mcp"
command = "npx"
args = ["-y", "opengrok-mcp-server"]

[mcp_servers.env]
OPENGROK_BASE_URL = "https://old.example.com"
`;
    mocks.existsResult = true;
    mocks.readFileResult = existingToml;

    const { configureCodex } = await import('../../server/cli/setup/configure.js');
    configureCodex({ url: 'https://new.example.com' });

    const fs = await import('fs');
    const written = String((fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]);
    // Should have exactly one `name = "opengrok-mcp"` entry (not the old one duplicated)
    const nameCount = (written.match(/name = "opengrok-mcp"/g) ?? []).length;
    expect(nameCount).toBe(1);
    expect(written).toContain('https://new.example.com');
    // Old URL should be gone
    expect(written).not.toContain('https://old.example.com');
  });

  it('includes OPENGROK_USERNAME in TOML when username is provided', async () => {
    mocks.existsResult = false;
    const { configureCodex } = await import('../../server/cli/setup/configure.js');
    configureCodex({ url: 'https://og.example.com', username: 'carol' });

    const fs = await import('fs');
    const written = String((fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]);
    expect(written).toContain('OPENGROK_USERNAME');
    expect(written).toContain('carol');
  });

  it('omits OPENGROK_USERNAME from TOML when username is not provided', async () => {
    mocks.existsResult = false;
    const { configureCodex } = await import('../../server/cli/setup/configure.js');
    configureCodex({ url: 'https://og.example.com' });

    const fs = await import('fs');
    const written = String((fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]);
    expect(written).not.toContain('OPENGROK_USERNAME');
  });
});
