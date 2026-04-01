import { loadConfig } from '../config.js';
import { OpenGrokClient } from '../client.js';
import { detectInstalledClients } from './setup/detect.js';

// __VERSION__ is injected at build time; fall back for dev/test
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : (process.env['npm_package_version'] ?? '0.0.0');

export async function runStatus(): Promise<void> {
  const config = loadConfig();

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
  console.log(`    ${clients.vscode ? '✓' : '✗'} VS Code / Copilot CLI`);
  console.log(`    ${clients.codex ? '✓' : '✗'} Codex CLI`);

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
