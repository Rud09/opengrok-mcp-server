import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
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
  enableFilesApi?: boolean;
  samplingModel?: string;
  samplingMaxTokens?: string;
  auditLogFile?: string;
  rateLimitRpm?: string;
}

/** Build the env var object for a given config — only non-default values are written. */
export function buildEnv(config: McpConfig): Record<string, string> {
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
  if (config.enableFilesApi)                               env['OPENGROK_ENABLE_FILES_API'] = 'true';
  if (config.samplingModel)                                env['OPENGROK_SAMPLING_MODEL'] = config.samplingModel;
  if (config.samplingMaxTokens && config.samplingMaxTokens !== '256')
                                                           env['OPENGROK_SAMPLING_MAX_TOKENS'] = config.samplingMaxTokens;
  if (config.auditLogFile)                                 env['OPENGROK_AUDIT_LOG_FILE'] = config.auditLogFile;
  if (config.rateLimitRpm && config.rateLimitRpm !== '60')
                                                           env['OPENGROK_RATELIMIT_RPM'] = config.rateLimitRpm;
  return env;
}

export function configureClaudeCode(config: McpConfig): void {
  const scope = config.scope ?? 'local';
  const env = buildEnv(config);
  // Server name must come before -e flags: -e is variadic (<env...>) and
  // will otherwise consume the server name as an env var value.
  const args: string[] = ['mcp', 'add', '--transport', 'stdio', '--scope', scope, 'opengrok-mcp'];
  for (const [k, v] of Object.entries(env)) {
    args.push('-e', `${k}=${v}`);
  }
  args.push('--', 'npx', '-y', 'opengrok-mcp-server');
  const result = spawnSync('claude', args, { stdio: 'pipe', encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(`claude mcp add failed: ${String(result.stderr ?? '')}`);
  }
}

/** Returns the VS Code user-level mcp.json path for the current platform. */
function vscodeUserMcpJsonPath(): string {
  const home = homedir();
  if (process.platform === 'win32') {
    return join(process.env['APPDATA'] ?? home, 'Code', 'User', 'mcp.json');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  }
  // Linux / other
  return join(process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'Code', 'User', 'mcp.json');
}

/**
 * Configure VS Code MCP settings by writing to the user-level mcp.json.
 * This avoids launching a VS Code window (which `code --add-mcp` does).
 * Returns the path written.
 */
export function configureVSCode(config: McpConfig): string {
  const env = buildEnv(config);
  const mcpJsonPath = vscodeUserMcpJsonPath();
  const mcpDir = dirname(mcpJsonPath);

  mkdirSync(mcpDir, { recursive: true });

  let existing: { servers?: Record<string, unknown> } = {};
  if (existsSync(mcpJsonPath)) {
    try {
      existing = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as { servers?: Record<string, unknown> };
    } catch { /* treat as empty */ }
  }

  const servers = { ...(existing.servers ?? {}) };
  servers['opengrok-mcp'] = {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'opengrok-mcp-server'],
    env,
  };

  writeFileSync(mcpJsonPath, JSON.stringify({ ...existing, servers }, null, 2), 'utf8');
  return mcpJsonPath;
}

/**
 * Configure GitHub Copilot CLI MCP settings by writing to ~/.copilot/mcp-config.json.
 * The Copilot CLI has no non-interactive CLI command for MCP configuration, so we
 * write the JSON config file directly (idempotent: replaces existing opengrok-mcp entry).
 */
export function configureCopilotCli(config: McpConfig): void {
  const configDir = join(homedir(), '.copilot');
  const configPath = resolve(configDir, 'mcp-config.json');

  mkdirSync(configDir, { recursive: true });

  let existing: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf8')) as { mcpServers?: Record<string, unknown> };
    } catch { /* treat as empty */ }
  }

  const servers = { ...(existing.mcpServers ?? {}) };
  servers['opengrok-mcp'] = {
    type: 'local',
    command: 'npx',
    args: ['-y', 'opengrok-mcp-server'],
    env: buildEnv(config),
    tools: ['*'],
  };

  writeFileSync(configPath, JSON.stringify({ ...existing, mcpServers: servers }, null, 2), 'utf8');
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
