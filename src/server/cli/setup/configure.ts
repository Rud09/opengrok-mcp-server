import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { parse as tomlParse, stringify as tomlStringify } from '@iarna/toml';
import type { JsonMap, AnyJson } from '@iarna/toml';

export interface McpConfig {
  url: string;
  username?: string;
  scope?: 'user' | 'local' | 'project';
  // All settings that map to server env vars
  verifySsl?: boolean;
  contextBudget?: string;
  codeMode?: boolean;
  defaultProject?: string;
  enableElicitation?: boolean;
  proxy?: string;
  apiVersion?: string;
  responseFormatOverride?: string;
  memoryBankDir?: string;
  compileDbPaths?: string;
}

/** Build the env var object for a given config — only non-default values are written. */
function buildEnv(config: McpConfig): Record<string, string> {
  const env: Record<string, string> = { OPENGROK_BASE_URL: config.url };
  if (config.username)                                     env['OPENGROK_USERNAME'] = config.username;
  if (config.verifySsl === false)                          env['OPENGROK_VERIFY_SSL'] = 'false';
  if (config.contextBudget && config.contextBudget !== 'standard')
                                                           env['OPENGROK_CONTEXT_BUDGET'] = config.contextBudget;
  if (config.codeMode === false)                           env['OPENGROK_CODE_MODE'] = 'false';
  if (config.defaultProject)                               env['OPENGROK_DEFAULT_PROJECT'] = config.defaultProject;
  if (config.enableElicitation)                            env['OPENGROK_ENABLE_ELICITATION'] = 'true';
  if (config.proxy) {
    env['HTTP_PROXY'] = config.proxy;
    env['HTTPS_PROXY'] = config.proxy;
  }
  if (config.apiVersion && config.apiVersion !== 'v1')    env['OPENGROK_API_VERSION'] = config.apiVersion;
  if (config.responseFormatOverride)                       env['OPENGROK_RESPONSE_FORMAT_OVERRIDE'] = config.responseFormatOverride;
  if (config.memoryBankDir)                                env['OPENGROK_MEMORY_BANK_DIR'] = config.memoryBankDir;
  if (config.compileDbPaths)                               env['OPENGROK_LOCAL_COMPILE_DB_PATHS'] = config.compileDbPaths;
  return env;
}

export function configureClaudeCode(config: McpConfig): void {
  const scope = config.scope ?? 'user';
  const env = buildEnv(config);
  const args: string[] = ['mcp', 'add', '--transport', 'stdio', '--scope', scope];
  for (const [k, v] of Object.entries(env)) {
    args.push('--env', `${k}=${v}`);
  }
  args.push('opengrok-mcp', '--', 'npx', '-y', 'opengrok-mcp-server');
  const result = spawnSync('claude', args, { stdio: 'pipe', encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(`claude mcp add failed: ${String(result.stderr ?? '')}`);
  }
}

export function configureVSCode(config: McpConfig): void {
  const env = buildEnv(config);

  // Try `code --add-mcp` first (VS Code 1.100+)
  const mcpDef = JSON.stringify({
    name: 'opengrok-mcp',
    command: 'npx',
    args: ['-y', 'opengrok-mcp-server'],
    env,
  });
  const result = spawnSync('code', ['--add-mcp', mcpDef], {
    stdio: 'pipe',
    encoding: 'utf8',
    shell: false,
  });

  if (result.status === 0) return;

  // Fallback: write .vscode/mcp.json in the current working directory
  const vscodeDir = join(process.cwd(), '.vscode');
  const mcpJsonPath = join(vscodeDir, 'mcp.json');

  let existing: { servers?: Record<string, unknown> } = {};
  if (existsSync(mcpJsonPath)) {
    try {
      existing = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as { servers?: Record<string, unknown> };
    } catch { /* treat as empty */ }
  }

  if (!existsSync(vscodeDir)) {
    mkdirSync(vscodeDir, { recursive: true });
  }

  const servers = { ...(existing.servers ?? {}) };
  // Idempotent: replace existing opengrok-mcp entry
  delete servers['opengrok-mcp'];
  servers['opengrok-mcp'] = {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'opengrok-mcp-server'],
    env,
  };

  writeFileSync(mcpJsonPath, JSON.stringify({ ...existing, servers }, null, 2), 'utf8');
}

export function configureCodex(config: McpConfig): void {
  const configPath = process.platform === 'win32'
    ? join(process.env['APPDATA'] ?? homedir(), 'codex', 'config.toml')
    : join(homedir(), '.config', 'codex', 'config.toml');

  mkdirSync(dirname(configPath), { recursive: true });

  let existing: JsonMap = {};
  if (existsSync(configPath)) {
    try {
      existing = tomlParse(readFileSync(configPath, 'utf8'));
    } catch { /* new file */ }
  }

  const servers = (existing['mcp_servers'] as AnyJson[] | undefined) ?? [];
  // Idempotent: remove existing entry for opengrok-mcp
  const filtered = (servers as Array<Record<string, AnyJson>>)
    .filter((s) => s['name'] !== 'opengrok-mcp');

  filtered.push({
    name: 'opengrok-mcp',
    command: 'npx',
    args: ['-y', 'opengrok-mcp-server'],
    env: buildEnv(config),
  } as unknown as Record<string, AnyJson>);

  existing['mcp_servers'] = filtered as unknown as AnyJson;
  writeFileSync(configPath, tomlStringify(existing), 'utf8');
}
