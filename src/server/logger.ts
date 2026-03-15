/**
 * Structured logger for the OpenGrok MCP server.
 * Writes to stderr (required by MCP protocol — stdout is reserved for JSON-RPC).
 *
 * Security: sanitizes all meta/error arguments to strip credentials, tokens,
 * and internal paths before writing to the log stream.
 *
 * Log level: set OPENGROK_LOG_LEVEL=debug to enable debug output.
 */

const LOG_LEVEL = (process.env.OPENGROK_LOG_LEVEL ?? "info").toLowerCase();
const DEBUG_ENABLED = LOG_LEVEL === "debug";

/**
 * Redact sensitive values from an arbitrary log payload before writing to stderr.
 * Handles strings, Error objects, and nested plain objects.
 */
function sanitizeMeta(meta: unknown): unknown {
  if (meta === null || meta === undefined || meta === "") return meta;
  if (typeof meta === "string") return redactString(meta);
  if (meta instanceof Error) {
    const redacted = redactString(meta.message);
    return redacted === meta.message ? meta : new Error(redacted);
  }
  if (typeof meta === "object") {
    // Shallow-redact plain objects (e.g., request/response payloads)
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
      // Redact common sensitive key names entirely
      if (/password|token|secret|authorization|auth/i.test(k)) {
        out[k] = "[REDACTED]";
      } else if (typeof v === "string") {
        out[k] = redactString(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return meta;
}

function redactString(s: string): string {
  // Basic auth header values
  let r = s.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]");
  // URL-embedded credentials: user:pass@host
  r = r.replace(/:[^:@\s]+@/g, ":***@");
  // Bearer / token schemes
  r = r.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]");
  // Absolute filesystem paths that may reveal internal infrastructure
  r = r.replace(/\/(?:home|tmp|var|usr|build|opt|mnt|srv)(?:\/\S+)/g, "[path]");
  r = r.replace(/[A-Z]:\\(?:Users|Windows|Program Files|build)(?:\\\S+)/gi, "[path]");
  return r;
}

function ts(): string {
  return new Date().toISOString();
}

export const logger = {
  info: (msg: string, meta?: unknown): void => {
    const sanitized = sanitizeMeta(meta);
    console.error(`${ts()} [INFO] [opengrok-mcp] ${msg}`, sanitized ?? "");
  },
  warn: (msg: string, meta?: unknown): void => {
    const sanitized = sanitizeMeta(meta);
    console.error(`${ts()} [WARN] [opengrok-mcp] ${msg}`, sanitized ?? "");
  },
  error: (msg: string, err?: unknown): void => {
    const sanitized = sanitizeMeta(err);
    console.error(`${ts()} [ERROR] [opengrok-mcp] ${msg}`, sanitized ?? "");
  },
  debug: (msg: string, meta?: unknown): void => {
    if (!DEBUG_ENABLED) return;
    const sanitized = sanitizeMeta(meta);
    console.error(`${ts()} [DEBUG] [opengrok-mcp] ${msg}`, sanitized ?? "");
  },
};
