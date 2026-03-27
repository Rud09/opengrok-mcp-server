/**
 * OpenGrok MCP Server — entry point.
 * v5.0: MemoryBank initialization for Living Document / Code Mode support.
 */

import * as os from "os";
import * as path from "path";
import { OpenGrokClient } from "./client.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { runServer } from "./server.js";
import { MemoryBank } from "./memory-bank.js";

declare const __VERSION__: string;

/* v8 ignore start -- false branch falls through to main() which is integration-level */
if (process.argv.includes("--version") || process.argv.includes("-v")) {
/* v8 ignore stop */
  console.log(__VERSION__);
  process.exit(0);
}

/* v8 ignore start -- entry point; integration-level, not unit-testable */
async function main(): Promise<void> {
  const config = loadConfig();
  const client = new OpenGrokClient(config);

  // Resolve memory bank directory:
  // 1. OPENGROK_MEMORY_BANK_DIR env var — always set by the VS Code extension, highest priority
  // 2. VSCODE_IPC_HOOK_CLI set — server is running in a VS Code integrated terminal (dev-time),
  //    use cwd-local path for convenience. NOTE: this branch is NOT hit by the VS Code extension
  //    because it always sets OPENGROK_MEMORY_BANK_DIR (step 1).
  // 3. All production standalone clients (Claude Desktop, Claude Code, Cursor, npx) → XDG-aware
  //    config dir: $XDG_CONFIG_HOME/opengrok-mcp/memory-bank (defaults to ~/.config/...)
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const memoryBankDir =
    config.OPENGROK_MEMORY_BANK_DIR ||
    (process.env.VSCODE_IPC_HOOK_CLI
      ? path.join(process.cwd(), ".opengrok", "memory-bank")
      : path.join(xdgConfig, "opengrok-mcp", "memory-bank"));

  const memoryBank = new MemoryBank(memoryBankDir);
  await memoryBank.ensureDir();

  await runServer(client, config, memoryBank);
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
/* v8 ignore stop */
