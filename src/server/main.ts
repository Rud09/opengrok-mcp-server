/**
 * OpenGrok MCP Server — entry point.
 * v5.0: MemoryBank initialization for Living Document / Code Mode support.
 */

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
  // 1. Prefer OPENGROK_MEMORY_BANK_DIR env var (user-configured)
  // 2. Fall back to <workspaceRoot>/.opengrok/memory-bank/
  //    VS Code launches the MCP subprocess with the workspace folder as cwd,
  //    so process.cwd() gives the correct workspace root. For CLI usage,
  //    it gives the user's current directory — both are the right workspace root.
  //    NOTE: __dirname is NOT used here — it would give the extension install dir.
  const memoryBankDir =
    config.OPENGROK_MEMORY_BANK_DIR ||
    path.join(process.cwd(), ".opengrok", "memory-bank");

  const memoryBank = new MemoryBank(memoryBankDir);
  await memoryBank.ensureDir();

  await runServer(client, config, memoryBank);
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
/* v8 ignore stop */
