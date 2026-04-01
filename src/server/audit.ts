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
/** Count of audit entries dropped due to file-write failures (for monitoring). */
let droppedAuditEvents = 0;

/**
 * Configure the audit log file path for compliance export.
 * When set, audit events are appended to this file in addition to stderr.
 */
export function configureAuditLog(filePath: string | undefined): void {
  auditLogFile = filePath ?? null;
}

/** Returns the number of audit log entries dropped due to file write failures since process start. */
export function getDroppedAuditEventCount(): number {
  return droppedAuditEvents;
}

/**
 * Write a structured audit log entry to stderr and optionally to file.
 *
 * Security guarantees:
 * - Never receives passwords, tokens, auth headers, or full content.
 * - `detail` is capped at 200 chars to limit output size.
 * - Only the explicitly passed fields are written.
 */
export function auditLog(event: AuditEvent): void {
  const ts = new Date().toISOString();
  const entry: Record<string, unknown> = {
    ts,
    audit: true,
    type: event.type,
  };
  if (event.tool !== undefined) entry.tool = String(event.tool).slice(0, 200);
  if (event.project !== undefined) entry.project = String(event.project).slice(0, 200);
  if (event.detail !== undefined) entry.detail = String(event.detail).slice(0, 200);

  const entryStr = JSON.stringify(entry);
  process.stderr.write(entryStr + "\n");

  if (auditLogFile) {
    try {
      fs.appendFileSync(auditLogFile, entryStr + "\n");
    } catch (err) {
      droppedAuditEvents++;
      // Emit a warning every 10 dropped events to avoid log flooding while
      // ensuring the operator is notified that audit entries are being lost.
      if (droppedAuditEvents === 1 || droppedAuditEvents % 10 === 0) {
        process.stderr.write(
          JSON.stringify({
            ts,
            error: "Failed to write audit log file",
            droppedTotal: droppedAuditEvents,
            detail: String(err),
          }) + "\n"
        );
      }
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
          .map((field) => {
            let s = String(field).replace(/"/g, '""');
            // Prevent CSV formula injection in spreadsheet applications
            if (s.length > 0 && "=+-@\t\r".includes(s[0])) s = "'" + s;
            return `"${s}"`;
          })
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
