/**
 * Configuration management for OpenGrok MCP Server.
 * Reads from environment variables, no passwords logged or exposed.
 */

import { z } from "zod";
import * as fs from "fs";
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

/** Like zIntString but also rejects zero and negative values. */
const zPositiveIntString = (defaultVal: string) =>
  zIntString(defaultVal).refine((n) => n >= 1, {
    message: `must be a positive integer (≥ 1)`,
  });

const ConfigSchema = z.object({
  OPENGROK_BASE_URL: z.string().default(""),
  OPENGROK_USERNAME: z.string().default(""),
  OPENGROK_PASSWORD: z.string().default(""),
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
  OPENGROK_CACHE_SEARCH_TTL: zPositiveIntString("300"),
  OPENGROK_CACHE_FILE_TTL: zPositiveIntString("600"),
  OPENGROK_CACHE_HISTORY_TTL: zPositiveIntString("1800"),
  OPENGROK_CACHE_PROJECTS_TTL: zPositiveIntString("3600"),
  OPENGROK_CACHE_MAX_SIZE: zPositiveIntString("500"),
  OPENGROK_CACHE_MAX_BYTES: zPositiveIntString("52428800"), // 50 MB default total cache budget
  // Rate limit
  OPENGROK_RATELIMIT_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  OPENGROK_RATELIMIT_RPM: zPositiveIntString("60"),
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
    .default("standard")
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
  // Audit log file path (appended to, in addition to stderr)
  OPENGROK_AUDIT_LOG_FILE: z.string().default(""),
  // Prompt caching hints (reserved for future explicit cache-control headers)
  OPENGROK_ENABLE_CACHE_HINTS: z.coerce.boolean().default(false),
  // MCP Elicitation — ask user for input during tool execution (e.g., pick project)
  OPENGROK_ENABLE_ELICITATION: z.coerce.boolean().default(false),
  // Files API cache layer — tracks investigation-log.md uploads to avoid re-sending unchanged content
  OPENGROK_ENABLE_FILES_API: z.coerce.boolean().default(false)
    .describe("Use Files API cache for investigation-log.md (when supported by SDK)"),
  // Per-tool rate limiting (comma-separated tool=rpm pairs, e.g. "opengrok_batch_search=5,opengrok_execute=10")
  OPENGROK_PER_TOOL_RATELIMIT: z.string().default(""),
  // OpenGrok REST API version (Task 5.7)
  OPENGROK_API_VERSION: z.enum(["v1", "v2"]).default("v1")
    .describe("OpenGrok REST API version (v1 or v2, default: v1)"),
  // Sampling — token budget and model preference (Task 5.5)
  OPENGROK_SAMPLING_MAX_TOKENS: z.coerce.number().int().min(64).max(4096).default(256),
  OPENGROK_SAMPLING_MODEL: z.string().default(""),
  // HTTP transport OAuth 2.1 (Task 5.3)
  // Shared-secret Bearer token for HTTP transport auth (empty = no auth required)
  OPENGROK_HTTP_AUTH_TOKEN: z.string().default(""),
  // HTTP transport — max concurrent sessions (Task 5.2)
  OPENGROK_HTTP_MAX_SESSIONS: zIntString("100"),
  // RBAC for multi-user HTTP deployments (Task 5.10)
  OPENGROK_RBAC_TOKENS: z.string().default("")
    .describe("RBAC token config: 'token1:admin,token2:readonly' format"),
});

export type Config = z.infer<typeof ConfigSchema>;

// Per-tool rate limit defaults (calls per minute)
export const DEFAULT_PER_TOOL_LIMITS: Record<string, number> = {
  opengrok_batch_search: 5,    // expensive operation
  opengrok_execute: 10,        // Code Mode sandbox overhead
  opengrok_dependency_map: 10, // BFS = multiple requests
  opengrok_update_memory: 20,  // disk writes — allow bursting but not spamming
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

// Check credential age and return warning if older than threshold
export function checkCredentialAge(configDir: string): string | null {
  try {
    const stateFile = path.join(configDir, "last-credential-rotation.json");
    const content = fs.readFileSync(stateFile, "utf8");
    const state = JSON.parse(content) as { rotatedAt: string };
    const ageDays = (Date.now() - new Date(state.rotatedAt).getTime()) / (1000 * 86400);
    if (!Number.isFinite(ageDays) || ageDays < 0) return null; // clock skew or corrupt
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

export function loadConfig(overrides?: Record<string, string>): Config {
  if (!overrides && _config) return _config;

  const result = ConfigSchema.safeParse({ ...process.env, ...overrides });
  if (!result.success) {
    logger.error("Configuration error:", result.error.format());
    process.exit(1);
  }

  const data = result.data;
  const password = data.OPENGROK_PASSWORD;

  // Warn if username is set but no password provided
  if (data.OPENGROK_USERNAME && !password) {
    logger.warn("OPENGROK_USERNAME is set but OPENGROK_PASSWORD is empty. Authentication may fail.");
  }

  // Validate proxy URL scheme (for both HTTP_PROXY and HTTPS_PROXY)
  for (const proxyUrl of [data.HTTP_PROXY, data.HTTPS_PROXY].filter(Boolean)) {
    try {
      const parsedProxy = new URL(proxyUrl);
      const allowedSchemes = ["http:", "https:", "socks5:"];
      if (!allowedSchemes.includes(parsedProxy.protocol)) {
        logger.error(`Proxy URL scheme "${parsedProxy.protocol}" not allowed. Use http, https, or socks5.`);
        process.exit(1);
      }
    } catch {
      logger.error(`Proxy URL is not a valid URL: "${proxyUrl}"`);
      process.exit(1);
    }
  }

  // Freeze to prevent accidental mutation by consumers
  const frozen = Object.freeze({ ...data, OPENGROK_PASSWORD: password });

  // Only cache the singleton when no overrides were supplied
  if (!overrides) {
    _config = frozen;
  }

  // Warn (never log password value)
  if (!frozen.OPENGROK_USERNAME) {
    logger.warn("OPENGROK_USERNAME is not set. Authentication may fail.");
  }

  if (!frozen.OPENGROK_BASE_URL) {
    logger.warn("OPENGROK_BASE_URL is not set. All tool calls will fail.");
  }

  return frozen;
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
