/**
 * Configuration management for OpenGrok MCP Server.
 * Reads from environment variables, no passwords logged or exposed.
 */

import { z } from "zod";
import * as fs from "fs";
import * as crypto from "crypto";
import * as path from "path";
import * as os from "os";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Context budget types + limits
// ---------------------------------------------------------------------------

export type ContextBudget = "minimal" | "standard" | "generous";

/** Per-budget response size limits. Consumers import this directly from config.ts. */
export const BUDGET_LIMITS: Record<
  ContextBudget,
  {
    maxResponseBytes: number;
    maxInlineLines: number;
    contextLines: number;
    maxSearchResults: number;
    searchAndReadCap: number;
  }
> = {
  minimal:  { maxResponseBytes: 4_096,  maxInlineLines: 50,  contextLines: 3,  maxSearchResults: 5,  searchAndReadCap: 2_048 },
  standard: { maxResponseBytes: 8_192,  maxInlineLines: 100, contextLines: 5,  maxSearchResults: 10, searchAndReadCap: 4_096 },
  generous: { maxResponseBytes: 16_384, maxInlineLines: 200, contextLines: 10, maxSearchResults: 25, searchAndReadCap: 8_192 },
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Parse a string env var as an integer, rejecting NaN values. */
const zIntString = (defaultVal: string) =>
  z
    .string()
    .default(defaultVal)
    .transform((v) => {
      const n = parseInt(v, 10);
      if (Number.isNaN(n)) throw new Error(`expected integer, got "${v}"`);
      return n;
    });

const ConfigSchema = z.object({
  OPENGROK_BASE_URL: z
    .string()
    .url()
    .default("https://opengrok.example.com/source/"),
  OPENGROK_USERNAME: z.string().default(""),
  OPENGROK_PASSWORD: z.string().default(""),
  OPENGROK_PASSWORD_FILE: z.string().default(""),
  OPENGROK_PASSWORD_KEY: z.string().default(""),
  OPENGROK_VERIFY_SSL: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  OPENGROK_TIMEOUT: zIntString("30"),
  OPENGROK_DEFAULT_MAX_RESULTS: zIntString("25"),
  // Cache settings
  OPENGROK_CACHE_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  OPENGROK_CACHE_SEARCH_TTL: zIntString("300"),
  OPENGROK_CACHE_FILE_TTL: zIntString("600"),
  OPENGROK_CACHE_HISTORY_TTL: zIntString("1800"),
  OPENGROK_CACHE_PROJECTS_TTL: zIntString("3600"),
  OPENGROK_CACHE_MAX_SIZE: zIntString("500"),
  OPENGROK_CACHE_MAX_BYTES: zIntString("52428800"), // 50 MB default total cache budget
  // Rate limit
  OPENGROK_RATELIMIT_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  OPENGROK_RATELIMIT_RPM: zIntString("60"),
  // Proxy
  HTTP_PROXY: z.string().default(""),
  HTTPS_PROXY: z.string().default(""),
  // Local layer — comma-separated absolute paths to compile_commands.json files
  OPENGROK_LOCAL_COMPILE_DB_PATHS: z.string().default(""),
  // Default project to scope searches to when none specified
  OPENGROK_DEFAULT_PROJECT: z.string().default(""),
  // Optimisation — context budget
  OPENGROK_CONTEXT_BUDGET: z
    .enum(["minimal", "standard", "generous"])
    .default("minimal")
    .describe("Token budget mode: minimal=4KB, standard=8KB, generous=16KB"),
  // Code Mode — 2-tool sandbox (enabled by default)
  OPENGROK_CODE_MODE: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),
  // Memory bank directory for Living Document system (empty = server-relative default)
  OPENGROK_MEMORY_BANK_DIR: z.string().default(""),
  // Global response format override (empty = auto per-call)
  OPENGROK_RESPONSE_FORMAT_OVERRIDE: z.string().default(""),
  // Prompt caching hints (reserved for future explicit cache-control headers)
  OPENGROK_ENABLE_CACHE_HINTS: z.coerce.boolean().default(false),
  // Per-tool rate limiting (comma-separated tool=rpm pairs, e.g. "opengrok_batch_search=5,opengrok_execute=10")
  OPENGROK_PER_TOOL_RATELIMIT: z.string().default(""),
  // Allowed client IDs for request origin validation (comma-separated, empty = no restriction)
  OPENGROK_ALLOWED_CLIENT_IDS: z.string().default(""),
});

export type Config = z.infer<typeof ConfigSchema>;

// Per-tool rate limit defaults (calls per minute)
export const DEFAULT_PER_TOOL_LIMITS: Record<string, number> = {
  opengrok_batch_search: 5,    // expensive operation
  opengrok_execute: 10,        // Code Mode sandbox overhead
  opengrok_dependency_map: 10, // BFS = multiple requests
};

// Parse per-tool rate limit config from environment string
export function parsePerToolLimits(configStr: string): Record<string, number> {
  const limits = { ...DEFAULT_PER_TOOL_LIMITS };
  if (!configStr || !configStr.trim()) return limits;

  for (const pair of configStr.split(",")) {
    const [tool, rpm] = pair.trim().split("=");
    if (tool && rpm) {
      const parsed = parseInt(rpm, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        limits[tool] = parsed;
      }
    }
  }

  return limits;
}

// Parse comma-separated list of allowed client IDs
export function parseAllowedClientIds(configStr: string): string[] {
  if (!configStr || !configStr.trim()) return [];
  return configStr.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
}

// Check credential age and return warning if older than threshold
export function checkCredentialAge(configDir: string): string | null {
  try {
    const stateFile = path.join(configDir, "last-credential-rotation.json");
    const content = fs.readFileSync(stateFile, "utf8");
    const state = JSON.parse(content) as { rotatedAt: string };
    const ageDays = (Date.now() - new Date(state.rotatedAt).getTime()) / (1000 * 86400);
    if (ageDays > 90) {
      return `Credentials not rotated in ${Math.floor(ageDays)} days`;
    }
    return null;
  } catch {
    return null; // no state file = first run or inaccessible
  }
}

// Update credential rotation timestamp
export function updateCredentialRotationTimestamp(configDir: string): void {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const stateFile = path.join(configDir, "last-credential-rotation.json");
    fs.writeFileSync(stateFile, JSON.stringify({ rotatedAt: new Date().toISOString() }));
  } catch (err) {
    logger.warn("Failed to update credential rotation timestamp:", err);
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

let _config: Config | undefined;

/**
 * Securely delete a file by overwriting with random data before unlinking.
 * This prevents forensic recovery of sensitive data.
 */
function secureDeleteFile(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    // Overwrite with random data
    const randomData = crypto.randomBytes(stat.size);
    fs.writeFileSync(filePath, randomData);
    // Now delete
    fs.unlinkSync(filePath);
    logger.info("Credential file securely overwritten and deleted");
  } catch {
    // If secure delete fails, try regular delete
    /* v8 ignore start -- requires real filesystem with specific failure mode */
    try {
      fs.unlinkSync(filePath);
      logger.info("Credential file deleted (regular delete)");
    } catch (deleteErr) {
      logger.warn("Failed to delete credential file:", deleteErr);
    }
    /* v8 ignore stop */
  }
}

/**
 * Decrypt password from encrypted credential file.
 * File format: base64(IV):base64(encryptedPassword)
 * Encryption: AES-256-CBC
 */
function decryptPassword(encryptedContent: string, keyBase64: string): string {
  try {
    const key = Buffer.from(keyBase64, "base64");
    const [ivBase64, encryptedBase64] = encryptedContent.split(":");
    
    if (!ivBase64 || !encryptedBase64) {
      logger.warn("Invalid encrypted file format");
      return "";
    }
    
    const iv = Buffer.from(ivBase64, "base64");
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    let decrypted = decipher.update(encryptedBase64, "base64", "utf8");
    decrypted += decipher.final("utf8");
    
    return decrypted;
  } catch (err) {
    logger.warn("Failed to decrypt password:", err);
    return "";
  }
}

/**
 * Load password from secure credential file, decrypt, and securely delete.
 * Returns password from file or env variable.
 */
function loadPassword(envPassword: string, passwordFile: string, passwordKey: string): string {
  if (passwordFile && passwordKey) {
    try {
      const encryptedContent = fs.readFileSync(passwordFile, "utf8").trim();
      const password = decryptPassword(encryptedContent, passwordKey);
      
      if (password) {
        // Securely delete the file (overwrite then unlink)
        secureDeleteFile(passwordFile);
        return password;
      }
    } catch (err) {
      logger.warn("Failed to read credential file:", err);
    }
  } else if (passwordFile) {
    // Legacy: unencrypted file (for backwards compatibility)
    try {
      const password = fs.readFileSync(passwordFile, "utf8").trim();
      secureDeleteFile(passwordFile);
      return password;
    } catch (err) {
      logger.warn("Failed to read credential file:", err);
    }
  }

  return envPassword;
}

export function loadConfig(): Config {
  if (_config) return _config;

  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    logger.error("Configuration error:", result.error.format());
    process.exit(1);
  }

  const data = result.data;

  // Load password from secure encrypted file if provided
  const password = loadPassword(
    data.OPENGROK_PASSWORD,
    data.OPENGROK_PASSWORD_FILE,
    data.OPENGROK_PASSWORD_KEY
  );

  // Update credential rotation timestamp if credentials are provided
  if (password || data.OPENGROK_USERNAME) {
    const configDir = getConfigDirectory();
    updateCredentialRotationTimestamp(configDir);
  }

  // Freeze to prevent accidental mutation by consumers
  _config = Object.freeze({ ...data, OPENGROK_PASSWORD: password });

  // Warn (never log password value)
  if (!_config.OPENGROK_USERNAME) {
    logger.warn("OPENGROK_USERNAME is not set. Authentication may fail.");
  }

  return _config;
}

// Get the config directory, respecting XDG_CONFIG_HOME
export function getConfigDirectory(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) {
    return path.join(xdgConfig, "opengrok-mcp");
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(homeDir, ".config", "opengrok-mcp");
}

export function resetConfig(): void {
  _config = undefined;
}
