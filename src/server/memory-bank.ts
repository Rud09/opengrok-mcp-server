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

  /**
   * @param dir — absolute path to the memory-bank directory.
   *              Caller decides the path (use __dirname or user config).
   */
  constructor(dir: string) {
    this.dir = dir;
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

    await this.migrate();

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

    let kept = [...older];
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

  /** Migrate from 6-file layout to 2-file layout. Idempotent. */
  private async migrate(): Promise<void> {
    const legacyFiles = [
      "AGENTS.md",
      "known-patterns.md",
      "symbol-index.md",
      "project-context.md",
      "codebase-map.md",
    ];

    // Rename active-context.md → active-task.md (preserve real content)
    const oldActive = path.join(this.dir, "active-context.md");
    const newActive = path.join(this.dir, "active-task.md");
    if (fs.existsSync(oldActive) && !fs.existsSync(newActive)) {
      try {
        const content = await fsp.readFile(oldActive, "utf8");
        const isStub = content.startsWith(STUB_SENTINEL_PREFIX);
        if (!isStub) {
          await fsp.rename(oldActive, newActive);
          logger.info("MemoryBank: renamed active-context.md → active-task.md");
        } else {
          await fsp.unlink(oldActive);
          logger.info("MemoryBank: removed active-context.md stub");
        }
      } catch (err) {
        logger.warn("MemoryBank: migration error for active-context.md:", err);
      }
    }

    // Delete deprecated files (warn if they have real content)
    for (const filename of legacyFiles) {
      const filePath = path.join(this.dir, filename);
      if (!fs.existsSync(filePath)) continue;
      try {
        const content = await fsp.readFile(filePath, "utf8");
        const isStub = content.startsWith(STUB_SENTINEL_PREFIX);
        if (!isStub) {
          logger.warn(
            `MemoryBank: deleting "${filename}" which has real content. ` +
            `For general codebase context, use VS Code's built-in /memory command.`
          );
        }
        await fsp.unlink(filePath);
        logger.info(`MemoryBank: removed legacy file ${filename}`);
      } catch (err) {
        logger.warn(`MemoryBank: migration error for ${filename}:`, err);
      }
    }
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
