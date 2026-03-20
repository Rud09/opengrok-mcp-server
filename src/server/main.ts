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
  // 2. Fall back to <package root>/memory-bank relative to this file
  //    (__dirname = out/server/, so go up two levels to the package root)
  // NOTE: process.cwd() is NOT used — it gives the wrong path in VS Code subprocesses
  const memoryBankDir =
    config.OPENGROK_MEMORY_BANK_DIR ||
    path.join(__dirname, "..", "..", "memory-bank");

  const memoryBank = new MemoryBank(memoryBankDir);
  await memoryBank.ensureDir();

  await runServer(client, config, memoryBank);
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
/* v8 ignore stop */
