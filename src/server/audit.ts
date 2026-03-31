/**
 * Structured audit logging for security-sensitive operations.
 *
 * Writes newline-delimited JSON to stderr (never stdout — stdout is the MCP
 * protocol stream).  Never logs credentials, passwords, tokens, or full
 * file/code content.
 *
 * When OPENGROK_AUDIT_LOG_FILE is configured, also appends to file for
 * compliance export.
 */

import * as fs from "fs";

export type AuditEventType =
  | "tool_invoke"
  | "rate_limited"
  | "sandbox_exec"
  | "auth_used"
  | "config_load"
  | "elicitation_request"
  | "elicitation_unsupported";

export interface AuditEvent {
  type: AuditEventType;
  /** Tool name (for tool_invoke / sandbox_exec) */
  tool?: string;
  /** Project parameter — safe metadata, not content */
  project?: string;
  /** Short, non-sensitive detail string */
  detail?: string;
}

let auditLogFile: string | null = null;

/**
 * Escape special characters in a log field to prevent log injection.
 * Escapes backslashes, newlines, carriage returns, and double-quotes.
 */
function escapeLogField(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/"/g, '\\"');
}

/**
 * Configure the audit log file path for compliance export.
 * When set, audit events are appended to this file in addition to stderr.
 */
export function configureAuditLog(filePath: string | undefined): void {
  auditLogFile = filePath ?? null;
}

/**
 * Write a structured audit log entry to stderr and optionally to file.
 *
 * Security guarantees:
 * - Never receives passwords, tokens, auth headers, or full content.
 * - `detail` is capped at 200 chars to prevent log injection.
 * - Only the explicitly passed fields are written.
 */
export function auditLog(event: AuditEvent): void {
  const ts = new Date().toISOString();
  const entry: Record<string, unknown> = {
    ts,
    audit: true,
    type: event.type,
  };
  if (event.tool !== undefined) entry.tool = escapeLogField(String(event.tool).slice(0, 200));
  if (event.project !== undefined) entry.project = escapeLogField(String(event.project).slice(0, 200));
  if (event.detail !== undefined) entry.detail = escapeLogField(String(event.detail).slice(0, 200));

  const entryStr = JSON.stringify(entry);
  process.stderr.write(entryStr + "\n");

  if (auditLogFile) {
    try {
      fs.appendFileSync(auditLogFile, entryStr + "\n");
    } catch (err) {
      process.stderr.write(
        JSON.stringify({ ts, error: "Failed to write audit log file", detail: String(err) }) + "\n"
      );
    }
  }
}

/**
 * Export audit logs in CSV format.
 * Reads from the audit log file and converts JSON entries to CSV.
 */
export function exportAuditLogAsCSV(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Audit log file not found: ${filePath}`);
  }

  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  const csv: string[] = ["timestamp,type,tool,project,detail"];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      csv.push(
        [
          entry.ts ?? "",
          entry.type ?? "",
          entry.tool ?? "",
          entry.project ?? "",
          entry.detail ?? "",
        ]
          .map((field) => `"${String(field).replace(/"/g, '""')}"`)
          .join(",")
      );
    } catch {
      // Skip malformed lines
    }
  }

  return csv.join("\n");
}

/**
 * Export audit logs in JSON format (array of entries).
 */
export function exportAuditLogAsJSON(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Audit log file not found: ${filePath}`);
  }

  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  const entries = [];

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  return JSON.stringify(entries, null, 2);
}
