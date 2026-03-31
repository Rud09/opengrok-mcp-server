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
}

export function configureClaudeCode(config: McpConfig): void {
  const scope = config.scope ?? 'user';
  const result = spawnSync(
    'claude',
    ['mcp', 'add', '--transport', 'stdio', '--scope', scope,
     '--env', `OPENGROK_BASE_URL=${config.url}`,
     'opengrok-mcp', '--', 'npx', '-y', 'opengrok-mcp-server'],
    { stdio: 'pipe', encoding: 'utf8', shell: false }
  );
  if (result.status !== 0) {
    throw new Error(`claude mcp add failed: ${String(result.stderr ?? '')}`);
  }
}

export function configureVSCode(config: McpConfig): void {
  const mcpDef = JSON.stringify({
    name: 'opengrok-mcp',
    command: 'npx',
    args: ['-y', 'opengrok-mcp-server'],
    env: { OPENGROK_BASE_URL: config.url },
  });
  const result = spawnSync('code', ['--add-mcp', mcpDef], {
    stdio: 'pipe',
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`code --add-mcp failed: ${String(result.stderr ?? '')}`);
  }
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
    env: { OPENGROK_BASE_URL: config.url },
  } as unknown as Record<string, AnyJson>);

  existing['mcp_servers'] = filtered as unknown as AnyJson;
  writeFileSync(configPath, tomlStringify(existing), 'utf8');
}
