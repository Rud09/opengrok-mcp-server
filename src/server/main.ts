/**
 * OpenGrok MCP Server — entry point.
 * v5.0: MemoryBank initialization for Living Document / Code Mode support.
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { OpenGrokClient } from "./client.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { runServer } from "./server.js";
import { MemoryBank } from "./memory-bank.js";
import { configureAuditLog, exportAuditLogAsCSV, exportAuditLogAsJSON } from "./audit.js";
import { retrievePassword } from "./cli/keychain.js";

declare const __VERSION__: string;

/**
 * Load config and auto-resolve password from OS keychain if not set via env.
 * The keychain lookup is done before the first loadConfig() call so that the
 * "username set but no password" validation in loadConfig does not exit early.
 *
 * The resolved password is passed as an override to loadConfig() rather than
 * written to process.env, preventing it from leaking into /proc/self/environ
 * or being visible to child processes and native addons.
 *
 * Exported for unit testing and for use as a configLoader callback on SIGHUP.
 */
export function resolveConfig(): ReturnType<typeof loadConfig> {
  // Peek at the relevant env vars without going through full loadConfig validation
  const username = process.env['OPENGROK_USERNAME'] ?? '';
  const envPassword = process.env['OPENGROK_PASSWORD'] ?? '';
  const passwordFile = process.env['OPENGROK_PASSWORD_FILE'] ?? '';

  if (username && !envPassword && !passwordFile) {
    // No password in env — try the OS keychain before calling loadConfig
    const keychainPassword = retrievePassword(username);
    if (keychainPassword) {
      // Pass the keychain password as an override instead of mutating process.env.
      // This prevents the plaintext secret from appearing in /proc/self/environ,
      // being inherited by child processes, or being readable by native addons.
      return loadConfig({ OPENGROK_PASSWORD: keychainPassword });
    }
  }

  return loadConfig();
}

/* v8 ignore start -- false branch falls through to main() which is integration-level */
if (process.argv.includes("--version") || process.argv.includes("-v")) {
/* v8 ignore stop */
  console.log(typeof __VERSION__ !== "undefined" ? __VERSION__ : process.env.npm_package_version ?? "0.0.0");
  process.exit(0);
}

/* v8 ignore start -- entry point; integration-level, not unit-testable */
// CLI routing — handle setup/status/version subcommands
const firstArg = process.argv[2];

if (firstArg === "setup" || firstArg === "--setup") {
  // Dynamic import to avoid loading CLI deps in server mode
  void (async () => {
    const { runSetup } = await import("./cli/setup/wizard.js");
    await runSetup();
    process.exit(0);
  })();
} else if (firstArg === "status" || firstArg === "--status") {
  void (async () => {
    const { runStatus } = await import("./cli/status.js");
    await runStatus();
    process.exit(0);
  })();
} else if (firstArg === "export-audit") {
  // Handle CLI commands like export-audit
  const args = process.argv.slice(3);
  let format = "json";
  let output: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format" && args[i + 1]) {
      format = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      output = args[++i];
    }
  }

  const config = loadConfig();
  const auditFile = config.OPENGROK_AUDIT_LOG_FILE;

  if (!auditFile) {
    console.error("Error: OPENGROK_AUDIT_LOG_FILE not configured");
    process.exit(1);
  }

  try {
    const result = format === "csv" ? exportAuditLogAsCSV(auditFile) : exportAuditLogAsJSON(auditFile);

    if (output) {
      fs.writeFileSync(output, result);
      console.log(`Audit log exported to ${output}`);
    } else {
      console.log(result);
    }
    process.exit(0);
  } catch (err) {
    console.error(`Export failed: ${err}`);
    process.exit(1);
  }
} else {
  // cmd === 'server' || cmd === undefined || cmd === '--server' → normal MCP server startup
  async function main(): Promise<void> {
    const config = resolveConfig();
    const client = new OpenGrokClient(config);

    // Configure audit log file if set
    if (config.OPENGROK_AUDIT_LOG_FILE) {
      configureAuditLog(config.OPENGROK_AUDIT_LOG_FILE);
    }

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

    await runServer(client, config, memoryBank, resolveConfig);
  }

  main().catch((err) => {
    logger.error("Fatal error:", err);
    process.exit(1);
  });
}
/* v8 ignore stop */
