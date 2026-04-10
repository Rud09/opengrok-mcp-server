import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parse as tomlParse } from '@iarna/toml';
import type { JsonMap, AnyJson } from '@iarna/toml';
import { loadConfig } from '../config.js';
import { OpenGrokClient } from '../client.js';
import { detectInstalledClients } from './setup/detect.js';
import { retrievePassword } from './keychain.js';

// __VERSION__ is injected at build time; fall back for dev/test
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : (process.env['npm_package_version'] ?? '0.0.0');

/**
 * Read env vars from the Claude Code config (~/.claude.json).
 * Scans all project entries and returns the first opengrok-mcp server env found.
 */
function readEnvFromClaudeCode(): Record<string, string> {
  try {
    const configPath = join(homedir(), '.claude.json');
    if (!existsSync(configPath)) return {};
    const data = JSON.parse(readFileSync(configPath, 'utf8')) as {
      projects?: Record<string, {
        mcpServers?: Record<string, { env?: Record<string, string> }>;
      }>;
    };
    for (const project of Object.values(data.projects ?? {})) {
      const env = project.mcpServers?.['opengrok-mcp']?.env;
      if (env?.['OPENGROK_BASE_URL']) return env;
    }
  } catch { /* ignore parse errors */ }
  return {};
}

/**
 * Read env vars from the GitHub Copilot CLI config (~/.copilot/mcp-config.json).
 * Format: { mcpServers: { 'opengrok-mcp': { env: {...} } } }
 */
function readEnvFromCopilotCli(): Record<string, string> {
  try {
    const configPath = join(homedir(), '.copilot', 'mcp-config.json');
    if (!existsSync(configPath)) return {};
    const data = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>;
    };
    const env = data.mcpServers?.['opengrok-mcp']?.env;
    if (env?.['OPENGROK_BASE_URL']) return env;
  } catch { /* ignore parse errors */ }
  return {};
}

/**
 * Read env vars from the Codex TOML config (~/.config/codex/config.toml).
 */
function readEnvFromCodex(): Record<string, string> {
  try {
    const configPath = process.platform === 'win32'
      ? join(process.env['APPDATA'] ?? homedir(), 'codex', 'config.toml')
      : join(homedir(), '.config', 'codex', 'config.toml');
    if (!existsSync(configPath)) return {};
    const toml = tomlParse(readFileSync(configPath, 'utf8')) as JsonMap;
    const servers = (toml['mcp_servers'] as AnyJson[] | undefined) ?? [];
    for (const s of servers as Array<Record<string, AnyJson>>) {
      if (s['name'] === 'opengrok-mcp') {
        const env = s['env'] as Record<string, string> | undefined;
        if (env?.['OPENGROK_BASE_URL']) return env;
      }
    }
  } catch { /* ignore parse errors */ }
  return {};
}

export async function runStatus(): Promise<void> {
  // If OPENGROK_BASE_URL is not set in the environment, fall back to reading
  // from the MCP client config files written by `opengrok-mcp setup`.
  let configOverrides: Record<string, string> = {};
  if (!process.env['OPENGROK_BASE_URL']) {
    configOverrides = readEnvFromClaudeCode();
    if (!configOverrides['OPENGROK_BASE_URL']) configOverrides = readEnvFromCopilotCli();
    if (!configOverrides['OPENGROK_BASE_URL']) configOverrides = readEnvFromCodex();
  }

  // Resolve password from keychain if not already provided
  const username = process.env['OPENGROK_USERNAME'] ?? configOverrides['OPENGROK_USERNAME'] ?? '';
  const envPassword = process.env['OPENGROK_PASSWORD'] ?? configOverrides['OPENGROK_PASSWORD'] ?? '';
  const passwordFile = process.env['OPENGROK_PASSWORD_FILE'] ?? '';
  if (username && !envPassword && !passwordFile) {
    const keychainPassword = retrievePassword(username);
    if (keychainPassword) {
      configOverrides = { ...configOverrides, OPENGROK_PASSWORD: keychainPassword };
    }
  }

  const config = loadConfig(Object.keys(configOverrides).length > 0 ? configOverrides : undefined);

  let client: OpenGrokClient;
  try {
    client = new OpenGrokClient(config);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (!config.OPENGROK_BASE_URL || msg.includes("OPENGROK_BASE_URL")) {
      console.error(
        "OpenGrok MCP Server is not configured.\n" +
        "  Run: npx opengrok-mcp-server setup\n" +
        "  Or set the OPENGROK_BASE_URL environment variable."
      );
    } else {
      console.error(`Configuration error: ${msg}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`OpenGrok MCP Server v${VERSION}`);
  console.log(`  URL:       ${config.OPENGROK_BASE_URL}`);
  console.log(`  Username:  ${config.OPENGROK_USERNAME || '(anonymous)'}`);
  console.log(`  SSL:       ${config.OPENGROK_VERIFY_SSL ? 'verified' : 'disabled'}`);

  const startMs = Date.now();
  try {
    const projects = await client.listProjects();
    const latencyMs = Date.now() - startMs;
    console.log(`  Projects:  ${projects.length} indexed`);
    console.log(`  Latency:   ${latencyMs} ms`);
  } catch (e) {
    console.log(`  Projects:  (unreachable — ${(e as Error).message})`);
  }

  const mode = config.OPENGROK_CODE_MODE ? 'Code Mode (5 tools)' : 'Standard Mode';
  const budget = config.OPENGROK_CONTEXT_BUDGET ?? 'standard';
  console.log(`  Mode:      ${mode}`);
  console.log(`  Budget:    ${budget}`);

  const clients = detectInstalledClients();
  console.log('\n  Configured in:');
  console.log(`    ${clients.claudeCode ? '✓' : '✗'} Claude Code CLI`);
  console.log(`    ${clients.codex ? '✓' : '✗'} Codex CLI`);
  console.log(`    ${clients.copilotCli ? '✓' : '✗'} GitHub Copilot CLI`);

  // Non-blocking update check — print result after the main output
  checkForUpdate(VERSION).then(msg => {
    if (msg) console.log(`\n  ${msg}`);
  }).catch(() => { /* network failures are silent */ });

  // Small delay to let the update check complete if fast
  await new Promise(r => setTimeout(r, 200));
}

async function checkForUpdate(currentVersion: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch('https://registry.npmjs.org/opengrok-mcp-server/latest', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    if (data.version && data.version !== currentVersion) {
      return `Update available: ${currentVersion} → ${data.version}  (npm update -g opengrok-mcp-server)`;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
