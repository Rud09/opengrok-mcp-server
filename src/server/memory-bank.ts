/**
 * MemoryBank — Living Document system for persistent session knowledge.
 * Reads/writes a set of allowed markdown files (the "memory bank") enabling
 * the LLM to carry knowledge across sessions without external indexing.
 *
 * Design decisions:
 * - Strict allow-list prevents arbitrary file access
 * - Stub detection via sentinel comment, NOT startsWith('[') which would eat real content
 * - investigation-log.md trimming splits on markdown headings to preserve entries
 * - Max file sizes prevent runaway writes
 * - Uses __dirname-relative default (NOT process.cwd()) for correct VS Code subprocess behavior
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { logger } from "./logger.js";
import { FileReferenceCache } from "./file-cache.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Files the LLM is allowed to read/write. */
export const ALLOWED_FILES = [
  "active-task.md",
  "investigation-log.md",
] as const;

export type AllowedFile = typeof ALLOWED_FILES[number];

/** Sentinel embedded in stub files so MemoryBank can detect uninitialized stubs. */
const STUB_SENTINEL_PREFIX = "<!-- OPENGROK_STUB:";

/** Maximum bytes for any individual file. */
const MAX_FILE_BYTES: Record<AllowedFile, number> = {
  "active-task.md":        4_096,
  "investigation-log.md":  32_768,
};

/** Stub templates for first-time initialization. */
const STUB_TEMPLATES: Record<AllowedFile, string> = {
  "active-task.md": `<!-- OPENGROK_STUB:active-task.md -->
task: (none)
started: (none)
last_symbol: (none)
last_file: (none)
next_step: (none)
open_questions: []
status: idle
`,
  "investigation-log.md": `<!-- OPENGROK_STUB:investigation-log.md -->
# Investigation Log
> Append-only. Format: ## YYYY-MM-DD HH:MM: Topic
> Include what you searched, what you found, and why it matters.
`,
};

// ---------------------------------------------------------------------------
// MemoryBank class
// ---------------------------------------------------------------------------

export class MemoryBank {
  private readonly dir: string;
  private lastReadHash = new Map<string, string>();
  readonly fileRefCache = new FileReferenceCache();

  /**
   * @param dir — absolute path to the memory-bank directory.
   *              Caller decides the path (use __dirname or user config).
   */
  constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * Returns a hash-based file reference for the given file, registering it in
   * the FileReferenceCache. If the content is unchanged since last call, returns
   * null so callers can short-circuit and emit "[unchanged]" instead.
   *
   * When MCP SDK gains Files API support, this method becomes the upload layer.
   */
  async getFileReference(filename: string): Promise<string | null> {
    const content = await this.read(filename);
    if (content === undefined) return null;
    if (this.fileRefCache.isUnchanged(filename, content)) return null;
    return this.fileRefCache.register(filename, content);
  }

  /** Create the directory and stub files if they don't exist. */
  async ensureDir(): Promise<void> {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      logger.info(`MemoryBank directory: ${this.dir}`);
    } catch (err) {
      logger.warn("MemoryBank: failed to create directory:", err);
      return;
    }

    for (const filename of ALLOWED_FILES) {
      const filePath = path.join(this.dir, filename);
      if (!fs.existsSync(filePath)) {
        try {
          await fsp.writeFile(filePath, STUB_TEMPLATES[filename], "utf8");
          logger.info(`MemoryBank: created stub ${filename}`);
        } catch (err) {
          logger.warn(`MemoryBank: failed to create stub ${filename}:`, err);
        }
      }
    }
  }

  /**
   * Read a memory bank file.
   * @returns file content, or undefined if it is still a stub.
   * @throws if filename is not in the allow-list.
   */
  async read(filename: string): Promise<string | undefined> {
    this.assertAllowed(filename);
    const filePath = path.join(this.dir, filename);

    let content: string;
    try {
      content = await fsp.readFile(filePath, "utf8");
    } catch {
      return undefined;
    }

    // Return undefined for uninitialised stubs so callers can skip them
    if (content.startsWith(STUB_SENTINEL_PREFIX)) {
      return undefined;
    }

    return content;
  }

  /**
   * Write to a memory bank file.
   * @param mode "overwrite" replaces the file; "append" adds to it (for investigation-log)
   * @throws if filename is not in the allow-list or content exceeds size limit.
   */
  async write(
    filename: string,
    content: string,
    mode: "overwrite" | "append" = "overwrite"
  ): Promise<void> {
    this.assertAllowed(filename);
    const filePath = path.join(this.dir, filename);
    const maxBytes = MAX_FILE_BYTES[filename as AllowedFile];

    let newContent: string;
    if (mode === "append") {
      let existing = "";
      try {
        existing = await fsp.readFile(filePath, "utf8");
        // Strip stub sentinel if present — file is now being overwritten with real content
        if (existing.startsWith(STUB_SENTINEL_PREFIX)) {
          existing = "";
        }
      } catch {
        existing = "";
      }

      // Pre-reject: if the combined size far exceeds the limit, trimming cannot help
      const existingBytes = Buffer.byteLength(existing, "utf8");
      const newBytes = Buffer.byteLength(content, "utf8");
      if (existingBytes + newBytes > maxBytes * 1.5) {
        throw new Error(`MemoryBank: write rejected — content would exceed max size for "${filename}"`);
      }

      if (mode === "append" && filename === "investigation-log.md") {
        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        if (!content.trimStart().startsWith("## ")) {
          content = `## ${timestamp}: Session Update\n${content}`;
        }
      }

      newContent = existing + "\n" + content;
    } else {
      newContent = content;
    }

    // Enforce size limit — trim from the top for investigation-log, from the end otherwise
    const encoded = Buffer.byteLength(newContent, "utf8");
    if (encoded > maxBytes) {
      if (filename === "investigation-log.md") {
        newContent = this.trimLogFromTop(newContent, maxBytes);
      } else {
        // For other files: hard truncate at limit
        newContent =
          Buffer.from(newContent, "utf8").subarray(0, maxBytes).toString("utf8") +
          "\n<!-- Truncated to stay within size limit -->";
      }
    }

    try {
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.writeFile(filePath, newContent, "utf8");
    } catch (err) {
      logger.warn(`MemoryBank: failed to write ${filename}:`, err);
      throw new Error(`Failed to write memory bank file: ${filename}`);
    }

    this.lastReadHash.delete(filename);
  }

  /**
   * Read with delta encoding — returns "[unchanged]" if content hasn't changed
   * since last read. Saves tokens when LLM reads the same file repeatedly.
   */
  async readWithDelta(filename: string): Promise<string | undefined> {
    const content = await this.read(filename);
    if (content === undefined) return undefined;

    const hash = this.simpleHash(content);
    if (this.lastReadHash.get(filename) === hash) {
      return "[unchanged]";
    }
    this.lastReadHash.set(filename, hash);
    return content;
  }

  /**
   * Read investigation-log.md with compression for large files.
   * When file exceeds 8KB, returns last 3 sections + count of omitted sections.
   */
  async readCompressed(filename: string): Promise<string | undefined> {
    const content = await this.read(filename);
    if (content === undefined) return undefined;

    const COMPRESS_THRESHOLD = 8_192;
    if (filename !== "investigation-log.md" || Buffer.byteLength(content, "utf8") <= COMPRESS_THRESHOLD) {
      return content;
    }

    const sections = content.split(/(?=^## )/m).filter(Boolean);
    if (sections.length <= 3) return content;

    const omitted = sections.length - 3;
    const recent = sections.slice(-3);
    return `[${omitted} older entries omitted]\n\n` + recent.join("");
  }

  private scoreLogEntry(section: string): number {
    let score = 0;
    const symbolMatches = section.match(/[A-Z][A-Za-z0-9]{2,}(::[A-Za-z0-9]+)*/g);
    score += (symbolMatches?.length ?? 0) * 2;
    if (/found|root cause|conclusion|fixed|resolved/i.test(section)) score += 10;
    if (/dead end|no results|0 matches|nothing found/i.test(section)) score -= 5;
    return score;
  }

  /**
   * Trim investigation-log.md from the top, discarding oldest/lowest-value entries.
   * Uses richness scoring to prefer keeping high-signal entries.
   */
  private trimLogFromTop(content: string, maxBytes: number): string {
    const sections = content.split(/(?=^## )/m).filter(Boolean);

    if (sections.length <= 1) {
      return (
        Buffer.from(content, "utf8").subarray(0, maxBytes).toString("utf8") +
        "\n<!-- Older entries trimmed -->"
      );
    }

    const trimNote = "<!-- Older entries trimmed -->\n\n";

    if (sections.length <= 2) {
      const candidate = trimNote + sections.join("");
      if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
    }

    // Always keep the 2 most recent entries; score older ones
    const recent = sections.slice(-2);
    const older = sections.slice(0, -2);
    const scored = older.map((s, i) => ({ s, i, score: this.scoreLogEntry(s) }));
    // Sort ascending so we drop lowest-score entries first
    scored.sort((a, b) => a.score - b.score);

    const kept = [...older];
    for (const { i } of scored) {
      const candidate = trimNote + kept.join("") + recent.join("");
      if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
        return candidate;
      }
      const idx = kept.indexOf(older[i]);
      if (idx !== -1) kept.splice(idx, 1);
    }

    // Only recent entries left
    const final = trimNote + recent.join("");
    if (Buffer.byteLength(final, "utf8") <= maxBytes) return final;

    // Last resort: byte truncate
    return (
      trimNote +
      Buffer.from(recent.join(""), "utf8").subarray(0, maxBytes).toString("utf8")
    );
  }

  private simpleHash(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }

  /**
   * Returns a ≤80-token status line summarising current memory state.
   * Injected into SERVER_INSTRUCTIONS as {{MEMORY_STATUS}}.
   */
  async getStatusLine(): Promise<string> {
    await this.ensureDir();

    const summaries: string[] = [];

    for (const filename of ALLOWED_FILES) {
      const filePath = path.join(this.dir, filename);
      if (!fs.existsSync(filePath)) continue;

      try {
        const raw = await fsp.readFile(filePath, "utf8");
        if (raw.trimStart().startsWith(STUB_SENTINEL_PREFIX.slice(0, 20))) continue; // stub

        const stat = await fsp.stat(filePath);
        const ageMins = Math.round((Date.now() - stat.mtimeMs) / 60_000);
        const ageStr = ageMins < 60
          ? `${ageMins}m ago`
          : `${Math.round(ageMins / 60)}h ago`;
        const sizeKb = (Buffer.byteLength(raw, "utf8") / 1024).toFixed(1);

        if (filename === "active-task.md") {
          const taskLine = raw.split("\n").find(l => l.startsWith("task:"));
          const taskVal = taskLine ? taskLine.slice(5).trim().slice(0, 60) : "(set)";
          summaries.push(`active-task.md: "${taskVal}" (${ageStr}, ${sizeKb} KB)`);
        } else if (filename === "investigation-log.md") {
          const entryCount = (raw.match(/^## /gm) ?? []).length;
          summaries.push(`investigation-log.md: ${entryCount} entr${entryCount === 1 ? "y" : "ies"} (${ageStr})`);
        }
      } catch {
        // File unreadable — skip silently
      }
    }

    if (summaries.length === 0) return "[Memory] No prior context.";
    return "[Memory] " + summaries.join(". ") + ".";
  }

  private assertAllowed(filename: string): void {
    if (!(ALLOWED_FILES as readonly string[]).includes(filename)) {
      throw new Error(
        `MemoryBank: "${filename}" is not in the allow-list. ` +
        `Allowed: ${ALLOWED_FILES.join(", ")}`
      );
    }
  }
}
