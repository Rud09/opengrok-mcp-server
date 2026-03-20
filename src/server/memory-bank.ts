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
  "AGENTS.md",
  "codebase-map.md",
  "symbol-index.md",
  "known-patterns.md",
  "investigation-log.md",
  "active-context.md",
] as const;

export type AllowedFile = typeof ALLOWED_FILES[number];

/** Sentinel embedded in stub files so MemoryBank can detect uninitialized stubs. */
const STUB_SENTINEL_PREFIX = "<!-- OPENGROK_STUB:";

/** Maximum bytes for any individual file. */
const MAX_FILE_BYTES: Record<AllowedFile, number> = {
  "AGENTS.md":             8_192,
  "codebase-map.md":       16_384,
  "symbol-index.md":       16_384,
  "known-patterns.md":     8_192,
  "investigation-log.md":  32_768,
  "active-context.md":     4_096,
};

/** Stub templates for first-time initialization. */
const STUB_TEMPLATES: Record<AllowedFile, string> = {
  "AGENTS.md": `<!-- OPENGROK_STUB:AGENTS.md -->
# OpenGrok Investigation Guide

Populate this file with project-specific guidance after the first investigation session.
Include: default project name, key directories, naming conventions, known hotspots.
`,
  "codebase-map.md": `<!-- OPENGROK_STUB:codebase-map.md -->
# Codebase Map

Populate after first exploration:
- Key directories and their purpose
- Entry points and main modules
- Build system structure
- Platform/configuration variants
`,
  "symbol-index.md": `<!-- OPENGROK_STUB:symbol-index.md -->
# Symbol Index

Format: \`SymbolName\` | file:path | L{line} | description
`,
  "known-patterns.md": `<!-- OPENGROK_STUB:known-patterns.md -->
# Known Patterns & Gotchas

Populate with recurring patterns discovered during investigations:
- Common error patterns
- Unusual conventions
- Known problematic areas
`,
  "investigation-log.md": `<!-- OPENGROK_STUB:investigation-log.md -->
# Investigation Log

Each session's findings go here under a dated heading.
Format: ## YYYY-MM-DD: Brief description
`,
  "active-context.md": `<!-- OPENGROK_STUB:active-context.md -->
# Active Context

Current investigation state. Overwrite at session start.
`,
};

// ---------------------------------------------------------------------------
// MemoryBank class
// ---------------------------------------------------------------------------

export class MemoryBank {
  private readonly dir: string;

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
  }

  /**
   * Trim investigation-log.md from the top, discarding oldest entries.
   * Splits on level-2 headings (## ) to preserve entry boundaries.
   */
  private trimLogFromTop(content: string, maxBytes: number): string {
    // Split on markdown H2 headings, keeping the delimiter
    const sections = content.split(/(?=^## )/m).filter(Boolean);

    if (sections.length <= 1) {
      // Can't split further — just truncate by bytes
      return (
        Buffer.from(content, "utf8").subarray(0, maxBytes).toString("utf8") +
        "\n<!-- Older entries trimmed -->"
      );
    }

    // Drop oldest (earliest) entries until it fits
    const trimNote = "<!-- Older entries trimmed -->\n\n";
    let trimmed = sections;
    while (trimmed.length > 1) {
      const candidate = trimNote + trimmed.join("");
      if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
        return candidate;
      }
      trimmed = trimmed.slice(1);
    }

    // Only one entry left — truncate by bytes
    return (
      trimNote +
      Buffer.from(trimmed[0] ?? "", "utf8").subarray(0, maxBytes).toString("utf8")
    );
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
