/**
 * Structured audit logging for security-sensitive operations.
 *
 * Writes newline-delimited JSON to stderr (never stdout — stdout is the MCP
 * protocol stream).  Never logs credentials, passwords, tokens, or full
 * file/code content.
 */

export type AuditEventType =
  | "tool_invoke"
  | "rate_limited"
  | "sandbox_exec"
  | "auth_used"
  | "config_load";

export interface AuditEvent {
  type: AuditEventType;
  /** Tool name (for tool_invoke / sandbox_exec) */
  tool?: string;
  /** Project parameter — safe metadata, not content */
  project?: string;
  /** Short, non-sensitive detail string */
  detail?: string;
}

/**
 * Write a structured audit log entry to stderr.
 *
 * Security guarantees:
 * - Never receives passwords, tokens, auth headers, or full content.
 * - `detail` is capped at 200 chars to prevent log injection.
 * - Only the explicitly passed fields are written.
 */
export function auditLog(event: AuditEvent): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    audit: true,
    type: event.type,
  };
  if (event.tool !== undefined) entry.tool = event.tool;
  if (event.project !== undefined) entry.project = event.project;
  if (event.detail !== undefined) entry.detail = String(event.detail).slice(0, 200);
  process.stderr.write(JSON.stringify(entry) + "\n");
}
