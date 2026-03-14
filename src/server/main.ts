/**
 * OpenGrok MCP Server — entry point.
 */

import { OpenGrokClient } from "./client.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { runServer } from "./server.js";

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
  await runServer(client, config);
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
/* v8 ignore stop */
