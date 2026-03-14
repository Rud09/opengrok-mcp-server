/**
 * Structured logger for the OpenGrok MCP server.
 * Writes to stderr (required by MCP protocol — stdout is reserved for JSON-RPC).
 */
export const logger = {
  info: (msg: string, meta?: unknown) => console.error(`[INFO] [opengrok-mcp] ${msg}`, meta ?? ""),
  error: (msg: string, err?: unknown) => console.error(`[ERROR] [opengrok-mcp] ${msg}`, err ?? ""),
  warn: (msg: string, meta?: unknown) => console.error(`[WARN] [opengrok-mcp] ${msg}`, meta ?? ""),
};
