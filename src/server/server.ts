/**
 * OpenGrok MCP Server — tool definitions and handlers.
 * v4.0: McpServer high-level API, opengrok_ prefixed tools, tool annotations,
 *       structured output, isError responses, security hardening.
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";


import { z, ZodError } from "zod";
import type { OpenGrokClient } from "./client.js";
import { extractLineRange } from "./client.js";
import type { Config } from "./config.js";
import { parsePerToolLimits, getConfigDirectory, checkCredentialAge, loadConfig, resetConfig } from "./config.js";
import {
  capSearchResultsToBytes,
  formatAnnotate,
  formatBatchSearchResults,
  formatBatchSearchResultsTOON,
  formatBatchSearchResultsTSV,
  formatBlame,
  formatCompileInfo,
  formatDirectoryListing,
  formatFileDiff,
  formatFileContent,
  formatFileContentText,
  formatFileHistory,
  formatFileSymbols,
  formatProjectsList,
  formatSearchAndRead,
  formatSearchResults,
  formatSearchResultsTOON,
  formatSearchResultsTSV,
  formatSymbolContext,
  formatSymbolContextYAML,
  formatWhatChanged,
  formatDependencyMap,
  selectFormat,
} from "./formatters.js";
import type {
  SearchAndReadEntry,
  SymbolContextResult,
  DependencyNode,
} from "./formatters.js";
import type { CompileInfo } from "./local/compile-info.js";
import {
  inferBuildRoot,
  loadCompileCommandsJson,
  parseCompileCommands,
  resolveAllowedRoots,
} from "./local/compile-info.js";
import {
  BatchSearchArgs,
  BlameArgs,
  BrowseDirectoryArgs,
  GetCompileInfoArgs,
  GetFileAnnotateArgs,
  GetFileContentArgs,
  GetFileDiffArgs,
  GetFileHistoryArgs,
  GetFileSymbolsArgs,
  CallGraphArgs,
  GetSymbolContextArgs,
  IndexHealthArgs,
  ListProjectsArgs,
  SearchAndReadArgs,
  SearchCodeArgs,
  SearchPatternArgs,
  SearchSuggestArgs,
  FindFileArgs,
  WhatChangedArgs,
  DependencyMapArgs,
  SearchResultsOutput,
  FileContentOutput,
  ProjectsListOutput,
  BatchSearchOutput,
  SymbolContextOutput,
  FileHistoryOutput,
  FileSymbolsOutput,
  WhatChangedOutput,
  DependencyMapOutput,
  BlameOutput,
} from "./models.js";
import type {
  FileContent,
  SearchResults,
  SearchResult,
  SearchMatch,
  Project,
} from "./models.js";
import { BUDGET_LIMITS } from "./config.js";
import type { ContextBudget } from "./config.js";
import type { ResponseFormat } from "./formatters.js";
import { MemoryBank, ALLOWED_FILES } from "./memory-bank.js";
import { ObservationMasker } from "./observation-masker.js";
import { createSandboxAPI, executeInSandbox, API_SPEC } from "./sandbox.js";
import { SandboxWorkerPool } from "./worker-pool.js";
import yaml from "js-yaml";

import { logger } from "./logger.js";
import { auditLog } from "./audit.js";
import { elicitOrFallback } from "./elicitation.js";
import { sampleOrNull } from "./sampling.js";

// ---------------------------------------------------------------------------
// Response size caps
// ---------------------------------------------------------------------------

// Hard cap on response payload (in bytes). Falls back to budget-based limit.
// Override with OPENGROK_MAX_RESPONSE_BYTES env var.
const MAX_RESPONSE_BYTES_OVERRIDE = process.env.OPENGROK_MAX_RESPONSE_BYTES
  ? parseInt(process.env.OPENGROK_MAX_RESPONSE_BYTES, 10)
  : undefined;

// Cap for the search_and_read compound tool (in bytes).
// Override with OPENGROK_SEARCH_AND_READ_CAP env var.
const SEARCH_AND_READ_CAP_OVERRIDE = process.env.OPENGROK_SEARCH_AND_READ_CAP
  ? parseInt(process.env.OPENGROK_SEARCH_AND_READ_CAP, 10)
  : undefined;

/** Get the active context budget from env, defaulting to 'minimal'. */
function getActiveBudget(): ContextBudget {
  const v = process.env.OPENGROK_CONTEXT_BUDGET?.toLowerCase();
  if (v === "standard" || v === "generous" || v === "minimal") return v;
  return "minimal";
}

/**
 * Cap a response to the active budget's maxResponseBytes.
 * Accepts an optional override for per-call limits (e.g. search_and_read).
 */
function capResponse(text: string, maxBytes?: number): string {
  const budget = BUDGET_LIMITS[getActiveBudget()];
  const limit = maxBytes ?? MAX_RESPONSE_BYTES_OVERRIDE ?? budget.maxResponseBytes;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= limit) return text;

  const full = Buffer.from(text, "utf8");
  // Walk back from the byte limit to a valid UTF-8 character boundary.
  // Continuation bytes are 0x80–0xBF; a lead byte is 0x00–0x7F or 0xC0–0xFF.
  let pos = limit;
  while (pos > 0 && ((full[pos] ?? 0) & 0xC0) === 0x80) pos--;
  const truncated = full.subarray(0, pos).toString("utf8");

  const lastNl = truncated.lastIndexOf("\n");
  const safeText = lastNl > 0 ? truncated.slice(0, lastNl) : truncated;
  return (
    safeText +
    `\n[Response truncated at ${Math.round(limit / 1024)} KB. Use line ranges or narrow query.]`
  );
}

function capCodeModeResult(result: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(result, "utf8");
  if (bytes <= maxBytes) return result;

  // Try to truncate at a JSON array element boundary
  const trimmed = result.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown[];
      // Binary search for max elements that fit
      let lo = 0, hi = parsed.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (Buffer.byteLength(JSON.stringify(parsed.slice(0, mid)), "utf8") <= maxBytes) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      if (lo > 0) {
        const truncated = JSON.stringify(parsed.slice(0, lo));
        return truncated + `\n// [truncated: ${parsed.length - lo} more elements]`;
      }
    } catch {
      // Not valid JSON array, fall through to byte truncation
    }
  }

  // Fallback: byte truncation (existing behavior)
  return capResponse(result, maxBytes);
}

// ---------------------------------------------------------------------------
// Server version
// ---------------------------------------------------------------------------

declare const __VERSION__: string;

/* v8 ignore start -- compile-time constant injected by esbuild */
const VERSION = (typeof __VERSION__ !== "undefined"
  ? __VERSION__
  : (process.env.npm_package_version ?? "4.0.0"));
/* v8 ignore stop */

// ---------------------------------------------------------------------------
// Server instructions (opengrok_ prefixed tool names)
// ---------------------------------------------------------------------------

export const SERVER_INSTRUCTIONS_TEMPLATE = `You are connected to an OpenGrok code search MCP server.

## TOOLS
Use opengrok_ prefixed tools to search and navigate the codebase. Run opengrok_index_health first to list available projects.

## SESSION START
{{MEMORY_STATUS}}
Run opengrok_index_health to verify connectivity, then proceed with the user's request.

## MEMORY
Update opengrok_update_memory after completing investigations:
- active-task.md: current task, last symbol/file, next step
- investigation-log.md: append ## YYYY-MM-DD HH:MM entries

## WORKFLOW
1. Search broadly with opengrok_search_code (symbol/full/path)
2. Use opengrok_get_symbol_context for function/class deep-dives
3. Use opengrok_batch_search for 2-5 parallel queries
4. Read files via opengrok_get_file_content with line ranges
5. Record findings in investigation-log.md`.trim();

/**
 * Code Mode uses a shorter instruction set — only 5 tools are exposed so the full
 * standard decision tree is not needed. This saves ~80-100 tokens per turn vs
 * the standard instructions.
 */
export const SERVER_INSTRUCTIONS_CODE_MODE_TEMPLATE = `You are connected to an OpenGrok code search MCP server in Code Mode.

## SESSION START
{{MEMORY_STATUS}}
Run opengrok_api to get the full API spec, then use opengrok_execute to run JavaScript queries.

## MEMORY
Update memory after investigations:
- active-task.md: current task and next step
- investigation-log.md: append ## YYYY-MM-DD HH:MM entries

## CODE MODE
Use opengrok_execute to run JavaScript with env.opengrok.* API methods.
All methods are synchronous in the sandbox.`.trim();

// Alias for test-export backward compatibility
const SERVER_INSTRUCTIONS = SERVER_INSTRUCTIONS_TEMPLATE;

// ---------------------------------------------------------------------------
// Tool documentation — served as MCP Resources at opengrok-docs://tools/{name}
// ---------------------------------------------------------------------------

export const TOOL_DOCS: Record<string, string> = {
  opengrok_search_code: `## opengrok_search_code
Search by symbol, text, or path across projects.

**Parameters:**
- \`query\` — search term (required)
- \`projects\` — scope to one or more projects (optional)
- \`search_type\` — symbol|full|path|hist|type (default: full)
- \`max_results\` — 1-25 (default: 10)

**Example:** \`opengrok_search_code({ query: "AuthService", search_type: "symbol", projects: ["myrepo"] })\``,

  opengrok_get_file_content: `## opengrok_get_file_content
Fetch file content with optional line range.

**Parameters:**
- \`path\` — file path (required)
- \`project\` — project name (required)
- \`start_line\` — first line (optional)
- \`end_line\` — last line (optional)`,

  opengrok_get_symbol_context: `## opengrok_get_symbol_context
One-call symbol investigation: definition + header + callers.

**Parameters:**
- \`symbol\` — symbol name (required)
- \`project\` — project name (optional)`,

  opengrok_index_health: `## opengrok_index_health
Check server health and list all indexed projects. Run this first each session.`,

  opengrok_read_memory: `## opengrok_read_memory
Read active-task.md or investigation-log.md.

**Parameters:**
- \`filename\` — "active-task.md" or "investigation-log.md"`,

  opengrok_update_memory: `## opengrok_update_memory
Write or append to active-task.md or investigation-log.md.

**Parameters:**
- \`filename\` — file to update
- \`content\` — new content or append text
- \`mode\` — "write" or "append"`,

  opengrok_memory_status: `## opengrok_memory_status
Show current memory bank file sizes and modification times. No parameters required.`,

  opengrok_batch_search: `## opengrok_batch_search
Run 2-5 searches in parallel in a single call.

**Parameters:**
- \`queries\` — array of search query objects (required)`,

  opengrok_search_and_read: `## opengrok_search_and_read
Combined search + file read in one call. Prefer over separate search + get_file_content.

**Parameters:**
- \`query\` — search term (required)
- \`project\` — project scope (optional)`,

  opengrok_find_file: `## opengrok_find_file
Find files by name pattern across projects.

**Parameters:**
- \`path_pattern\` — glob or substring to match against file paths (required)
- \`projects\` — scope to specific projects (optional)`,

  opengrok_browse_directory: `## opengrok_browse_directory
List directory contents.

**Parameters:**
- \`path\` — directory path (required)
- \`project\` — project name (required)`,

  opengrok_list_projects: `## opengrok_list_projects
List all indexed projects. No parameters required.`,

  opengrok_get_file_history: `## opengrok_get_file_history
Get commit history for a file.

**Parameters:**
- \`path\` — file path (required)
- \`project\` — project name (required)`,

  opengrok_get_file_annotate: `## opengrok_get_file_annotate
Get line-by-line blame/annotation for a file.

**Parameters:**
- \`path\` — file path (required)
- \`project\` — project name (required)`,

  opengrok_get_file_symbols: `## opengrok_get_file_symbols
List all symbols defined in a file. Call before get_file_content to find line ranges.

**Parameters:**
- \`path\` — file path (required)
- \`project\` — project name (required)`,

  opengrok_search_suggest: `## opengrok_search_suggest
Get search suggestions/autocomplete for a partial query.

**Parameters:**
- \`query\` — partial query (required)
- \`project\` — project scope (optional)`,

  opengrok_what_changed: `## opengrok_what_changed
Show recently changed files in a project.

**Parameters:**
- \`project\` — project name (required)
- \`days\` — look-back window in days (optional)`,

  opengrok_blame: `## opengrok_blame
Get blame information for a file with commit metadata.

**Parameters:**
- \`path\` — file path (required)
- \`project\` — project name (required)`,

  opengrok_dependency_map: `## opengrok_dependency_map
Build a dependency map showing what a file uses and what uses it.

**Parameters:**
- \`path\` — file path (required)
- \`project\` — project name (required)`,

  opengrok_call_graph: `## opengrok_call_graph
Compute a call graph for a symbol showing callers and callees.

**Parameters:**
- \`symbol\` — symbol name (required)
- \`project\` — project name (required)`,

  opengrok_search_pattern: `## opengrok_search_pattern
Search using a regular expression pattern.

**Parameters:**
- \`pattern\` — regex pattern (required)
- \`project\` — project scope (optional)`,

  opengrok_get_file_diff: `## opengrok_get_file_diff
Get a diff for a file between two revisions.

**Parameters:**
- \`path\` — file path (required)
- \`project\` — project name (required)
- \`rev1\` — first revision (required)
- \`rev2\` — second revision (optional)`,

  opengrok_get_compile_info: `## opengrok_get_compile_info
Get compiler flags and include paths for a C/C++ file from compile_commands.json.

**Parameters:**
- \`path\` — file path (required)`,

  opengrok_api: `## opengrok_api
[Code Mode] Return the full Code Mode API specification. Call once per session.`,

  opengrok_execute: `## opengrok_execute
[Code Mode] Execute JavaScript in the QuickJS sandbox with OpenGrok API access.

**Parameters:**
- \`code\` — JS function body using env.opengrok.* for API calls (required)`,
};

// ---------------------------------------------------------------------------
// Tool registration order — for prompt caching hints (3C)
// ---------------------------------------------------------------------------

/**
 * Canonical tool registration order for prompt-caching hints (3C).
 * Pre-populated at module init with the complete list; individual register*
 * functions also push to this array at call time as a cross-check.
 *
 * Memory tools first (always registered), then Code Mode tools (when enabled),
 * then legacy tools (when Code Mode is disabled).
 */
export const TOOL_REGISTRATION_ORDER: string[] = [
  // Memory tools (always registered in Code Mode)
  "opengrok_memory_status",
  "opengrok_read_memory",
  "opengrok_update_memory",
  // Code Mode tools (registered when OPENGROK_CODE_MODE=true)
  "opengrok_api",
  "opengrok_execute",
  // Legacy tools (registered in standard mode)
  "opengrok_search_code",
  "opengrok_find_file",
  "opengrok_search_pattern",
  "opengrok_get_file_content",
  "opengrok_get_file_history",
  "opengrok_get_file_diff",
  "opengrok_browse_directory",
  "opengrok_list_projects",
  "opengrok_get_file_annotate",
  "opengrok_search_suggest",
  "opengrok_batch_search",
  "opengrok_search_and_read",
  "opengrok_get_symbol_context",
  "opengrok_index_health",
  "opengrok_get_compile_info",
  "opengrok_get_file_symbols",
  "opengrok_call_graph",
  "opengrok_what_changed",
  "opengrok_blame",
  "opengrok_dependency_map",
];

// ---------------------------------------------------------------------------
// Tool annotations
// ---------------------------------------------------------------------------

const READ_ONLY_OPEN: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const READ_ONLY_LOCAL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// Code Mode tools are well-suited for Claude's extended thinking between tool calls,
// but enabling that is a client-side API concern — no MCP annotation needed.
const CODE_MODE_API_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
  idempotentHint: true,
  destructiveHint: false,
};

const CODE_MODE_EXECUTE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  openWorldHint: true,
  idempotentHint: false,
  destructiveHint: false,
};

// ---------------------------------------------------------------------------
// Local layer — compile_commands.json index + file bypass
// ---------------------------------------------------------------------------

interface LocalLayer {
  enabled: boolean;
  roots: string[];
  index: Map<string, CompileInfo>;
  suffixIndex: Map<string, string>;
}

function buildLocalLayer(config: Config): LocalLayer {
  const rawPaths = config.OPENGROK_LOCAL_COMPILE_DB_PATHS.trim();
  if (!rawPaths) {
    return { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() };
  }

  const dbPaths = rawPaths.split(",").map((p) => p.trim()).filter(Boolean);
  if (!dbPaths.length) {
    return { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() };
  }

  const loaded = loadCompileCommandsJson(dbPaths);
  const inferredRoot = inferBuildRoot(dbPaths, loaded);

  let resolvedInferredRoot: string | undefined;
  if (inferredRoot) {
    try {
      resolvedInferredRoot = fs.realpathSync(inferredRoot);
    } catch {
      logger.warn(`Local layer: inferred build root not found locally: ${inferredRoot}`);
    }
  }

  const allowedRoots: string[] = resolvedInferredRoot ? [resolvedInferredRoot] : [];
  for (const r of resolveAllowedRoots(dbPaths)) {
    if (!allowedRoots.includes(r)) allowedRoots.push(r);
  }

  if (!allowedRoots.length) {
    logger.warn("Local layer: no valid allowed roots — local layer disabled");
    return { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() };
  }

  const index = parseCompileCommands(dbPaths, allowedRoots, loaded);

  const suffixIndex = new Map<string, string>();
  for (const key of index.keys()) {
    const normalized = key.replace(/\\/g, "/");
    const parts = normalized.split("/");
    for (let i = Math.max(0, parts.length - 4); i < parts.length; i++) {
      const suffix = "/" + parts.slice(i).join("/");
      /* v8 ignore start */
      if (!suffixIndex.has(suffix)) suffixIndex.set(suffix, key);
      /* v8 ignore stop */
    }
  }

  logger.info(
    `Local layer enabled: ${index.size} compile entries from ${dbPaths.length} compile_commands.json` +
      (resolvedInferredRoot ? `, build root: ${resolvedInferredRoot}` : "")
  );

  return { enabled: true, roots: allowedRoots, index, suffixIndex };
}

async function tryLocalRead(
  filePath: string,
  roots: string[],
  startLine?: number,
  endLine?: number
): Promise<FileContent | null> {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (
    normalized.includes("../") ||
    normalized.startsWith("../") ||
    normalized.endsWith("/..") ||
    normalized === ".."
  ) {
    return null;
  }

  for (const root of roots) {
    // Canonicalize root to resolve any symlinks, preventing symlink traversal escapes
    let canonicalRoot: string;
    try {
      canonicalRoot = await fsp.realpath(root);
    } catch {
      canonicalRoot = root; // root doesn't exist yet, use as-is
    }

    const candidate = path.join(canonicalRoot, normalized);
    let resolved: string;
    try {
      resolved = await fsp.realpath(candidate);
    } catch {
      continue;
    }

    if (!resolved.startsWith(canonicalRoot + path.sep) && resolved !== canonicalRoot) {
      continue;
    }

    try {
      const rawContent = await fsp.readFile(resolved, "utf8");
      const { text: content, totalLines } = extractLineRange(rawContent, startLine, endLine);

      return {
        project: "local",
        path: normalized,
        content,
        lineCount: totalLines,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        startLine,
      };
    } catch {
      /* v8 ignore start -- requires unreadable file on real filesystem */
      continue;
      /* v8 ignore stop */
    }
  }

  return null;
}

function resolveFileFromIndex(
  opengrokPath: string,
  index: Map<string, CompileInfo>,
  suffixIndex: Map<string, string>
): string | null {
  if (!index.size) return null;
  if (index.has(opengrokPath)) return opengrokPath;
  const normalizedRequest = opengrokPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const suffix = "/" + normalizedRequest;
  const hit = suffixIndex.get(suffix);
  if (hit) return hit;
  for (const key of index.keys()) {
    if (key.replace(/\\/g, "/").endsWith(suffix)) return key;
  }
  return null;
}

async function readFileAtAbsPath(
  absPath: string,
  startLine?: number,
  endLine?: number
): Promise<FileContent | null> {
  try {
    const rawContent = await fsp.readFile(absPath, "utf8");
    const { text: content, totalLines } = extractLineRange(rawContent, startLine, endLine);

    return {
      project: "local",
      path: path.basename(absPath),
      content,
      lineCount: totalLines,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      startLine,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool result types and utilities
// ---------------------------------------------------------------------------

type ResourceLinkItem = {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType?: string;
};

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string } | ResourceLinkItem>;
  structuredContent?: Record<string, unknown>;
};

function getMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    c: "text/x-c", h: "text/x-c", cpp: "text/x-c++", cc: "text/x-c++",
    cxx: "text/x-c++", hpp: "text/x-c++", hxx: "text/x-c++",
    java: "text/x-java-source", py: "text/x-python", js: "text/javascript",
    ts: "text/typescript", go: "text/x-go", rs: "text/x-rustsrc",
    rb: "text/x-ruby", sh: "text/x-sh", xml: "text/xml",
    json: "application/json", yaml: "text/yaml", yml: "text/yaml",
    md: "text/markdown", txt: "text/plain",
  };
  return map[ext] ?? "text/plain";
}

function makeToolError(name: string, err: unknown): ToolResult {
  logger.error(`Tool "${name}" failed:`, err);
  let text: string;
  if (err instanceof ZodError) {
    const issues = err.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    text = `**Invalid arguments:** ${issues}`;
  } else if (err instanceof Error) {
    text = `**Error:** ${sanitizeErrorMessage(err.message)}`;
  } else {
    text = "**Error:** An unexpected error occurred. Check server logs.";
  }
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Shared helper: format a tool response, routing to compact formats via selectFormat.
 * Applies capResponse to protect LLM context windows.
 *
 * structuredContent is ONLY included when response_format="json" is explicitly
 * set (or forced via global override). LLMs see both content and structuredContent,
 * so always including it wastes 200–800 tokens per call with duplicate data.
 */
function formatResponse(
  textMarkdown: string,
  structured: Record<string, unknown>,
  format: ResponseFormat = "markdown",
  responseType: "search" | "symbol" | "code" | "generic" = "generic"
): ToolResult {
  const effective = selectFormat(responseType, format);
  let text: string;
  switch (effective) {
    case "json":
      text = capResponse(JSON.stringify(structured, null, 2));
      break;
    default:
      text = capResponse(textMarkdown);
  }
  return {
    content: [{ type: "text", text }],
    // Only include structuredContent for programmatic consumers (explicit json format)
    ...(effective === "json" ? { structuredContent: structured } : {}),
  };
}

/**
 * Pick the best search formatter based on the resolved format.
 *
 * When maxBytes is provided (and the format is TOON or TSV), the results
 * array is trimmed *before* encoding to guarantee structurally valid output.
 * Raw byte-truncation of TOON breaks the encoded structure; TSV is safer but
 * loses the "N more rows" footer. Pre-truncation is always correct.
 */
function pickSearchFormatter(
  fmt: ResponseFormat,
  maxBytes?: number
): (r: SearchResults) => string {
  const cap = maxBytes
    ? (r: SearchResults) => capSearchResultsToBytes(r, maxBytes)
    : (r: SearchResults) => r;
  if (fmt === "toon") return (r) => formatSearchResultsTOON(cap(r));
  if (fmt === "tsv") return (r) => formatSearchResultsTSV(cap(r));
  return formatSearchResults;
}

// ---------------------------------------------------------------------------
// Apply default project helper
// ---------------------------------------------------------------------------

function applyDefaultProject(
  projects: string[] | undefined,
  config: Config
): string[] | undefined {
  // If caller explicitly provided projects (even an empty array), respect that choice
  if (Array.isArray(projects)) return projects.length > 0 ? projects : undefined;
  const defaultProject = config.OPENGROK_DEFAULT_PROJECT?.trim();
  return defaultProject ? [defaultProject] : undefined;
}

// ---------------------------------------------------------------------------
// TOOL_DEFS: exported map of tool descriptions + parameter descriptions.
// Used by tool-descriptions.test.ts to enforce ≤120 char tool descriptions
// and ≤80 char parameter descriptions without importing the full MCP server.
// ---------------------------------------------------------------------------

/** Extract parameter description strings from a Zod object shape. */
function extractZodParamDescs(
  shape: Record<string, z.ZodTypeAny>
): Record<string, { description?: string }> {
  const out: Record<string, { description?: string }> = {};
  for (const [key, field] of Object.entries(shape)) {
    // Zod stores description in _def.description on the field's _def chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let node: any = field;
    let description: string | undefined;
    // Walk unwrap chain: ZodOptional/ZodDefault wrap the inner type
    while (node) {
      if (typeof node._def?.description === "string") {
        description = node._def.description;
        break;
      }
      // Unwrap optional/default wrappers
      node = node._def?.innerType ?? node._def?.schema ?? null;
    }
    out[key] = { description };
  }
  return out;
}

export const TOOL_DEFS: Record<string, {
  description: string;
  parameters?: Record<string, { description?: string }>;
}> = {
  opengrok_search_code: {
    description: "Full-text or symbol search across one or all OpenGrok projects.",
    parameters: extractZodParamDescs(SearchCodeArgs.shape),
  },
  opengrok_find_file: {
    description: "Find files by name across all or one project.",
    parameters: extractZodParamDescs(FindFileArgs.shape),
  },
  opengrok_search_pattern: {
    description: "Search the codebase using a regular expression pattern.",
    parameters: extractZodParamDescs(SearchPatternArgs.shape),
  },
  opengrok_get_file_content: {
    description: "Fetch file content with optional line range.",
    parameters: extractZodParamDescs(GetFileContentArgs.shape),
  },
  opengrok_get_file_history: {
    description: "Show git commit history for a file.",
    parameters: extractZodParamDescs(GetFileHistoryArgs.shape),
  },
  opengrok_get_file_diff: {
    description: "Diff between two revisions of a file (unified diff format).",
    parameters: extractZodParamDescs(GetFileDiffArgs.shape),
  },
  opengrok_browse_directory: {
    description: "List files and subdirectories in a project directory.",
    parameters: extractZodParamDescs(BrowseDirectoryArgs.shape),
  },
  opengrok_list_projects: {
    description: "List all indexed OpenGrok projects.",
    parameters: extractZodParamDescs(ListProjectsArgs.shape),
  },
  opengrok_get_file_annotate: {
    description: "Annotate each line with its last commit (git blame).",
    parameters: extractZodParamDescs(GetFileAnnotateArgs.shape),
  },
  opengrok_search_suggest: {
    description: "Autocomplete suggestions for a partial query.",
    parameters: extractZodParamDescs(SearchSuggestArgs.shape),
  },
  opengrok_batch_search: {
    description: "Execute 2-5 parallel OpenGrok searches in one call.",
    parameters: extractZodParamDescs(BatchSearchArgs.shape),
  },
  opengrok_search_and_read: {
    description: "Search then read matching files in a single call.",
    parameters: extractZodParamDescs(SearchAndReadArgs.shape),
  },
  opengrok_get_symbol_context: {
    description: "Complete symbol investigation: definition + header + references in one call.",
    parameters: extractZodParamDescs(GetSymbolContextArgs.shape),
  },
  opengrok_index_health: {
    description: "Check OpenGrok server health and indexed project list.",
    parameters: extractZodParamDescs(IndexHealthArgs.shape),
  },
  opengrok_get_compile_info: {
    description: "Get compiler flags and include paths from compile_commands.json.",
    parameters: extractZodParamDescs(GetCompileInfoArgs.shape),
  },
  opengrok_get_file_symbols: {
    description: "List all symbols (functions, classes, variables) defined in a file.",
    parameters: extractZodParamDescs(GetFileSymbolsArgs.shape),
  },
  opengrok_call_graph: {
    description: "Find all callers and callees of a function or method symbol.",
    parameters: extractZodParamDescs(CallGraphArgs.shape),
  },
  opengrok_what_changed: {
    description: "Show recent commits across one or all projects.",
    parameters: extractZodParamDescs(WhatChangedArgs.shape),
  },
  opengrok_blame: {
    description: "Git blame with optional diff for a file path.",
    parameters: extractZodParamDescs(BlameArgs.shape),
  },
  opengrok_dependency_map: {
    description: "Build #include/import dependency graph (configurable depth).",
    parameters: extractZodParamDescs(DependencyMapArgs.shape),
  },
  opengrok_memory_status: {
    description: "Show current memory bank file sizes and modification times.",
    parameters: {
      _: { description: "(no input required)" },
    },
  },
  opengrok_read_memory: {
    description: "Read active-task.md or investigation-log.md from the memory bank.",
    parameters: {
      filename: { description: "File to read from the memory bank" },
    },
  },
  opengrok_update_memory: {
    description: "Write or append to active-task.md or investigation-log.md.",
    parameters: {
      filename: { description: "File to update" },
      content: { description: "Content to write" },
      mode: { description: "append adds to end (use for investigation-log)" },
    },
  },
  opengrok_api: {
    description: "Return the full Code Mode API specification.",
    parameters: {
      _: { description: "(no input required)" },
    },
  },
  opengrok_execute: {
    description: "Execute JavaScript in the QuickJS sandbox with OpenGrok API access.",
    parameters: {
      code: { description: "JS function body; use env.opengrok.* for API calls; return a value." },
    },
  },
};

// ---------------------------------------------------------------------------
// Priority tool core executors (return raw data for structured output)
// ---------------------------------------------------------------------------

async function executeSearchCode(
  args: {
    query: string;
    search_type: "full" | "defs" | "refs" | "path" | "hist";
    projects?: string[];
    max_results: number;
    start_index: number;
    file_type?: string;
    response_format?: ResponseFormat;
  },
  client: OpenGrokClient,
  config: Config
): Promise<{ text: string; structured: SearchResults }> {
  const results = await client.search(
    args.query,
    args.search_type,
    applyDefaultProject(args.projects, config),
    args.max_results,
    args.start_index,
    args.file_type
  );
  const fmt = selectFormat("search", args.response_format);
  const maxBytes = MAX_RESPONSE_BYTES_OVERRIDE ?? BUDGET_LIMITS[getActiveBudget()].maxResponseBytes;
  const text = pickSearchFormatter(fmt, maxBytes)(results);
  return { text, structured: results };
}

async function executeGetFileContent(
  args: {
    project: string;
    path: string;
    start_line?: number;
    end_line?: number;
    response_format?: ResponseFormat;
  },
  client: OpenGrokClient,
  local: LocalLayer
): Promise<{ text: string; structured: FileContent }> {
  let content: FileContent | null = null;

  if (local.enabled && local.index.size > 0) {
    const absPath = resolveFileFromIndex(args.path, local.index, local.suffixIndex);
    /* v8 ignore start */
    if (absPath) {
    /* v8 ignore stop */
      content = await readFileAtAbsPath(absPath, args.start_line, args.end_line);
    }
  }

  if (!content && local.enabled && local.roots.length > 0) {
    content = await tryLocalRead(args.path, local.roots, args.start_line, args.end_line);
  }

  if (!content) {
    content = await client.getFileContent(
      args.project,
      args.path,
      args.start_line,
      args.end_line
    );
  }

  const fmt = selectFormat("code", args.response_format);
  const text = fmt === "text" ? formatFileContentText(content) : formatFileContent(content);

  // Warn on full-file fetch (no line range)
  if (!args.start_line && !args.end_line && content.lineCount > 50) {
    const warning = `⚠️ Full file fetch (${content.lineCount} lines). Use opengrok_get_file_symbols first, then fetch only the lines you need.\n`;
    return { text: warning + text, structured: content };
  }

  return { text, structured: content };
}

async function executeListProjects(
  args: { filter?: string; response_format?: ResponseFormat },
  client: OpenGrokClient
): Promise<{ text: string; structured: { projects: Project[]; total: number } }> {
  const projects = await client.listProjects(args.filter);
  return {
    text: formatProjectsList(projects),
    structured: { projects, total: projects.length },
  };
}

function deduplicateAcrossQueries(
  results: Array<{
    query: string;
    searchType: string;
    results: SearchResults;
  }>
): Array<{
  query: string;
  searchType: string;
  results: SearchResults;
}> {
  const seen = new Map<string, Set<number>>(); // path → set of seen line numbers
  return results.map((queryResult) => {
    const dedupedHits = queryResult.results.results
      .map((hit) => {
        let pathSeen = seen.get(hit.path);
        if (!pathSeen) { pathSeen = new Set(); seen.set(hit.path, pathSeen); }
        const seenLines = pathSeen;
        const filteredMatches = hit.matches.filter((match) => {
          if (seenLines.has(match.lineNumber)) return false;
          seenLines.add(match.lineNumber);
          return true;
        });
        return { ...hit, matches: filteredMatches };
      })
      .filter((hit) => hit.matches.length > 0);

    // Recompute totalCount to reflect the actual number of matches returned,
    // so clients don't see a count that exceeds the actual results array.
    const dedupedMatchCount = dedupedHits.reduce((sum, hit) => sum + hit.matches.length, 0);

    return {
      ...queryResult,
      results: {
        ...queryResult.results,
        results: dedupedHits,
        totalCount: Math.min(queryResult.results.totalCount, dedupedMatchCount),
      },
    };
  });
}

async function executeBatchSearch(
  args: {
    queries: Array<{
      query: string;
      search_type: "full" | "defs" | "refs" | "path" | "hist";
      max_results: number;
    }>;
    projects?: string[];
    file_type?: string;
    response_format?: ResponseFormat;
  },
  client: OpenGrokClient,
  config: Config
): Promise<{
  text: string;
  structured: {
    queryResults: Array<{
      query: string;
      searchType: string;
      results: SearchResults;
    }>;
  };
}> {
  const effectiveProjects = applyDefaultProject(args.projects, config);
  const searchResults = await Promise.all(
    args.queries.map((q) =>
      client.search(
        q.query,
        q.search_type,
        effectiveProjects,
        q.max_results,
        0,
        args.file_type
      )
    )
  );
  const queryResults = args.queries.map((q, i) => ({
    query: q.query,
    searchType: q.search_type,
    results: searchResults[i],
  }));

  const deduped = deduplicateAcrossQueries(queryResults);

  const fmt = selectFormat("search", args.response_format);
  const text =
    fmt === "toon"
      ? formatBatchSearchResultsTOON(deduped)
      : fmt === "tsv"
        ? formatBatchSearchResultsTSV(deduped)
        : formatBatchSearchResults(deduped);

  return {
    text,
    structured: { queryResults: deduped },
  };
}

// ---------------------------------------------------------------------------
// Compound tool handlers
// ---------------------------------------------------------------------------

async function handleSearchAndRead(
  rawArgs: Record<string, unknown>,
  client: OpenGrokClient,
  config: Config
): Promise<string> {
  const args = SearchAndReadArgs.parse(rawArgs);
  const searchResults = await client.search(
    args.query,
    args.search_type,
    applyDefaultProject(args.projects, config),
    args.max_results,
    0,
    args.file_type
  );

  const entries: SearchAndReadEntry[] = [];
  let totalOutputBytes = 0;

  for (const result of searchResults.results) {
    if (!result.matches.length) continue;

    const firstMatch = result.matches[0];
    const startLine = Math.max(1, firstMatch.lineNumber - args.context_lines);
    const endLine = firstMatch.lineNumber + args.context_lines;

    try {
      const fileContent = await client.getFileContent(
        result.project,
        result.path,
        startLine,
        endLine
      );

      const lang = result.path.includes(".")
        ? (/* v8 ignore next */ result.path.split(".").pop()?.toLowerCase() ?? "")
        : "";

      const contextText = fileContent.content;
      totalOutputBytes += Buffer.byteLength(contextText, "utf8");

      entries.push({
        project: result.project,
        path: result.path,
        matchLine: firstMatch.lineNumber,
        context: contextText,
        lang,
      });

      if (totalOutputBytes >= (SEARCH_AND_READ_CAP_OVERRIDE ?? BUDGET_LIMITS[getActiveBudget()].searchAndReadCap)) break;
    } catch {
      // Skip files that can't be read
    }
  }

  return formatSearchAndRead(args.query, searchResults.totalCount, entries);
}

async function handleGetSymbolContextStructured(
  rawArgs: Record<string, unknown>,
  client: OpenGrokClient,
  config: Config
): Promise<{ text: string; structured: SymbolContextResult }> {
  const args = GetSymbolContextArgs.parse(rawArgs);
  const effectiveProjects = applyDefaultProject(args.projects, config);

  const defResults = await client.search(
    args.symbol,
    "defs",
    effectiveProjects,
    // Fetch up to 5 results so we can find a matching .h/.hpp header without a second search
    args.include_header ? 5 : 3,
    0,
    args.file_type
  );

  if (!defResults.results.length || !defResults.results[0].matches.length) {
    const result: SymbolContextResult = {
      found: false,
      symbol: args.symbol,
      kind: "unknown",
      references: { totalFound: 0, samples: [] },
    };
    return { text: formatSymbolContext(result), structured: result };
  }

  const defResult = defResults.results[0];
  const defMatch = defResult.matches[0];
  const defStartLine = Math.max(1, defMatch.lineNumber - args.context_lines);
  const defEndLine = defMatch.lineNumber + args.context_lines;
  const defLang = defResult.path.includes(".")
    ? (/* v8 ignore next */ defResult.path.split(".").pop()?.toLowerCase() ?? "")
    : "";

  const defContent = await client.getFileContent(
    defResult.project,
    defResult.path,
    defStartLine,
    defEndLine
  );

  let fileSymbols: SymbolContextResult["fileSymbols"];
  try {
    const symsResult = await client.getFileSymbols(defResult.project, defResult.path);
    if (symsResult.symbols.length > 0) {
      fileSymbols = symsResult.symbols.map((s) => ({
        symbol: s.symbol,
        type: s.type,
        line: s.lineStart ?? s.line,
      }));
    }
  } catch {
    // Symbol map is non-fatal
  }

  let header: SymbolContextResult["header"] | undefined;
  if (args.include_header && defResult.path.match(/\.(cpp|cc|cxx)$/i)) {
    try {
      // Reuse the already-fetched defResults (with maxResults=5) to find a header match
      // instead of issuing a second identical search. Filter for .h/.hpp files.
      const headerMatch = defResults.results.find((r) =>
        r.path.match(/\.(h|hpp|hxx)$/i)
      );
      if (headerMatch && headerMatch.matches.length) {
        const hLine = headerMatch.matches[0].lineNumber;
        const hContent = await client.getFileContent(
          headerMatch.project,
          headerMatch.path,
          Math.max(1, hLine - 10),
          hLine + 10
        );
        /* v8 ignore start -- header extension detection */
        const hLang = headerMatch.path.includes(".")
          ? (headerMatch.path.split(".").pop()?.toLowerCase() ?? "")
          : "";
        /* v8 ignore stop */
        header = {
          project: headerMatch.project,
          path: headerMatch.path,
          context: hContent.content,
          lang: hLang,
        };
      }
    } catch {
      // Header lookup failure is non-fatal
    }
  }

  const refResults = await client.search(
    args.symbol,
    "refs",
    effectiveProjects,
    args.max_refs,
    0,
    args.file_type
  );
  const refSamples = refResults.results.flatMap((r) =>
    r.matches.slice(0, 2).map((m) => ({
      path: r.path,
      project: r.project,
      lineNumber: m.lineNumber,
      content: m.lineContent,
    }))
  );

  const kind = defResult.path.match(/\.(h|hpp|hxx)$/i)
    ? "class/struct"
    : "function/method";

  const symbolResult: SymbolContextResult = {
    found: true,
    symbol: args.symbol,
    kind,
    definition: {
      project: defResult.project,
      path: defResult.path,
      line: defMatch.lineNumber,
      context: defContent.content,
      lang: defLang,
    },
    header,
    references: {
      totalFound: refResults.totalCount,
      samples: refSamples,
    },
    fileSymbols,
  };

  return { text: formatSymbolContext(symbolResult), structured: symbolResult };
}

async function handleGetCompileInfo(
  rawArgs: Record<string, unknown>,
  config: Config,
  local: LocalLayer
): Promise<string> {
  const args = GetCompileInfoArgs.parse(rawArgs);

  if (!local.enabled) {
    return (
      "Local layer is not enabled. " +
      "Open a workspace containing compile_commands.json files to enable it automatically."
    );
  }

  if (!local.index.size) {
    return (
      "Local layer is enabled but no compile entries were loaded. " +
      "No compile_commands.json files found under the build root — build the project first."
    );
  }

  const requestedPath = args.path;
  let info: CompileInfo | undefined;

  if (path.isAbsolute(requestedPath)) {
    try {
      const resolved = await fsp.realpath(requestedPath);
      info = local.index.get(resolved);
    } catch {
      // Path doesn't exist — fall through
    }
  }

  if (!info) {
    const normalized = requestedPath.replace(/\\/g, "/").replace(/^\/+/, "");
    for (const root of local.roots) {
      try {
        const resolved = await fsp.realpath(path.join(root, normalized));
        info = local.index.get(resolved);
        /* v8 ignore start */
        if (info) break;
        /* v8 ignore stop */
      } catch {
        // Try next root
      }
    }
  }

  if (!info) {
    const basename = path.basename(requestedPath);
    for (const [k, v] of local.index) {
      if (path.basename(k) === basename) {
        info = v;
        break;
      }
    }
  }

  return formatCompileInfo(info ?? null, requestedPath);
}

// ---------------------------------------------------------------------------
// Central dispatcher — kept for backward-compatible test exports
// ---------------------------------------------------------------------------

async function dispatchTool(
  name: string,
  rawArgs: Record<string, unknown>,
  client: OpenGrokClient,
  config: Config,
  local: LocalLayer
): Promise<string> {
  switch (name) {
    case "opengrok_search_code": {
      const args = SearchCodeArgs.parse(rawArgs);
      const { text } = await executeSearchCode(args, client, config);
      return text;
    }

    case "opengrok_find_file": {
      const args = FindFileArgs.parse(rawArgs);
      const results = await client.search(
        args.path_pattern,
        "path",
        applyDefaultProject(args.projects, config),
        args.max_results,
        args.start_index
      );
      return formatSearchResults(results);
    }

    case "opengrok_search_pattern": {
      const args = SearchPatternArgs.parse(rawArgs);
      const results = await client.searchPattern({
        pattern: args.pattern,
        projects: applyDefaultProject(args.projects, config),
        fileType: args.file_type,
        maxResults: args.max_results,
      });
      const fmt = selectFormat("search", args.response_format as ResponseFormat | undefined);
      const maxBytes = MAX_RESPONSE_BYTES_OVERRIDE ?? BUDGET_LIMITS[getActiveBudget()].maxResponseBytes;
      return pickSearchFormatter(fmt, maxBytes)(results);
    }

    case "opengrok_get_file_content": {
      const args = GetFileContentArgs.parse(rawArgs);
      const { text } = await executeGetFileContent(args, client, local);
      return text;
    }

    case "opengrok_get_file_history": {
      const args = GetFileHistoryArgs.parse(rawArgs);
      const history = await client.getFileHistory(
        args.project,
        args.path,
        args.max_entries
      );
      return formatFileHistory(history);
    }

    case "opengrok_browse_directory": {
      const args = BrowseDirectoryArgs.parse(rawArgs);
      const entries = await client.browseDirectory(args.project, args.path);
      return formatDirectoryListing(entries, args.project, args.path);
    }

    case "opengrok_list_projects": {
      const args = ListProjectsArgs.parse(rawArgs);
      const { text } = await executeListProjects(args, client);
      return text;
    }

    case "opengrok_get_file_annotate": {
      const args = GetFileAnnotateArgs.parse(rawArgs);
      const annotated = await client.getAnnotate(args.project, args.path);
      return formatAnnotate(annotated, args.start_line, args.end_line);
    }

    case "opengrok_search_suggest": {
      const args = SearchSuggestArgs.parse(rawArgs);
      const result = await client.suggest(args.query, args.project, args.field);
      if (result.suggestions.length) {
        return "Suggestions:\n" + result.suggestions.map((s) => `  ${s}`).join("\n");
      }
      if (result.time === 0) {
        return "No suggestions found. The suggester index appears to be empty — an OpenGrok admin may need to rebuild it.";
      }
      return "No suggestions found.";
    }

    case "opengrok_batch_search": {
      const args = BatchSearchArgs.parse(rawArgs);
      const { text } = await executeBatchSearch(args, client, config);
      return text;
    }

    case "opengrok_search_and_read":
      return handleSearchAndRead(rawArgs, client, config);

    case "opengrok_get_symbol_context": {
      const { text } = await handleGetSymbolContextStructured(rawArgs, client, config);
      return text;
    }

    case "opengrok_index_health": {
      const args = IndexHealthArgs.parse(rawArgs);
      const format = selectFormat("generic", args.response_format);
      
      // dispatchTool is a test/legacy path — each call gets its own latency tracker
      let lastHealthCheckLatencyMs: number | null = null;
      
      const start = Date.now();
      const ok = await client.testConnection();
      const latencyMs = Date.now() - start;
      
      // Collect project count and any warnings
      let indexedProjects = 0;
      const warnings: string[] = [];
      
      try {
        const projects = await client.listProjects();
        indexedProjects = projects.length;
      } catch {
        // err intentionally unused
        warnings.push("Could not retrieve project list");
      }
      
      // Compute staleness signals (Task 5.8)
      let latencyTrend: "stable" | "increasing" | "first_check" = "first_check";
      let stalenessScore: "healthy" | "possibly_stale" | "likely_stale" = "healthy";
      
      if (lastHealthCheckLatencyMs !== null) {
        latencyTrend = latencyMs > lastHealthCheckLatencyMs * 1.5 ? "increasing" : "stable";
      }
      lastHealthCheckLatencyMs = latencyMs;
      
      // Staleness heuristics:
      // 1. High latency (>500ms) suggests server load or indexing activity
      // 2. Increasing latency trend suggests growing load
      // 3. No projects indexed suggests potential issue
      if (latencyMs > 500) {
        stalenessScore = latencyTrend === "increasing" ? "likely_stale" : "possibly_stale";
      }
      if (indexedProjects === 0 && ok) {
        warnings.push("No projects indexed");
        stalenessScore = "possibly_stale";
      }
      
      // Construct the result object
      const health = {
        connected: ok,
        latencyMs,
        indexedProjects,
        latencyTrend,
        stalenessScore,
        warnings,
      };
      
      if (ok) {
        client.warmCache();
      }
      
      // Format the response
      if (format === "json") {
        return JSON.stringify(health, null, 2);
      } else if (format === "yaml") {
        const yamlLines = [
          `connected: ${health.connected}`,
          `latencyMs: ${health.latencyMs}`,
          `indexedProjects: ${health.indexedProjects}`,
          `latencyTrend: ${health.latencyTrend}`,
          `stalenessScore: ${health.stalenessScore}`,
          ...(health.warnings.length > 0
            ? [`warnings:\n${health.warnings.map((w) => `  - ${w}`).join("\n")}`]
            : []),
        ];
        return yamlLines.join("\n");
      } else {
        // markdown or text (default)
        const markdown = [
          "# OpenGrok Health",
          "",
          `- **Connected:** ${health.connected}`,
          `- **Latency:** ${health.latencyMs}ms`,
          `- **Indexed projects:** ${health.indexedProjects}`,
          `- **Latency trend:** ${health.latencyTrend}`,
          `- **Staleness:** ${health.stalenessScore}`,
          ...(health.warnings.length > 0
            ? [`- **Warnings:** ${health.warnings.join(", ")}`]
            : []),
        ].join("\n");
        return markdown;
      }
    }

    case "opengrok_get_compile_info":
      return handleGetCompileInfo(rawArgs, config, local);

    case "opengrok_get_file_symbols": {
      const args = GetFileSymbolsArgs.parse(rawArgs);
      const result = await client.getFileSymbols(args.project, args.path);
      if (!result.symbols.length) {
        return `No symbols found for ${args.path} in project ${args.project}. The file may not be indexed or the OpenGrok instance does not support the /api/v1/file/defs endpoint.`;
      }
      return formatFileSymbols(result);
    }

    case "opengrok_what_changed": {
      const args = WhatChangedArgs.parse(rawArgs);
      const [history, annotation] = await Promise.all([
        client.getFileHistory(args.project, args.path),
        client.getAnnotate(args.project, args.path),
      ]);
      return formatWhatChanged(history, annotation, args.since_days);
    }

    case "opengrok_dependency_map": {
      const args = DependencyMapArgs.parse(rawArgs);
      const nodes = await buildDependencyGraph(client, args.project, args.path, args.depth, args.direction);
      return formatDependencyMap(args.path, args.depth, nodes);
    }

    case "opengrok_blame": {
      const args = BlameArgs.parse(rawArgs);
      const annotated = await client.getAnnotate(args.project, args.path);
      return formatBlame(annotated, args.line_start, args.line_end, args.include_diff);
    }

    default:
      return `**Error:** Unknown tool: "${name}"`;
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Server factory — McpServer with per-tool registrations
// ---------------------------------------------------------------------------

export function createServer(
  client: OpenGrokClient,
  config: Config,
  memoryBank?: MemoryBank,
  instructionsOverride?: string
): McpServer {
  const codeMode = config.OPENGROK_CODE_MODE;

  const baseInstructions = codeMode ? SERVER_INSTRUCTIONS_CODE_MODE_TEMPLATE : SERVER_INSTRUCTIONS_TEMPLATE;
  const instructions = instructionsOverride ?? baseInstructions;

  const server = new McpServer(
    { name: "opengrok-mcp", version: VERSION },
    { instructions }
  );

  // Prompt caching hints — the MCP SDK (current version) does not expose cache_control
  // breakpoints at the server level. Claude Code caches the system prompt and tool schemas
  // automatically for stdio clients. For HTTP clients (Cursor, Windsurf, Zed, Continue),
  // configure cache_control breakpoints at the transport/proxy layer if needed.
  if (config.OPENGROK_ENABLE_CACHE_HINTS) {
    logger.info(
      "OPENGROK_ENABLE_CACHE_HINTS=true: prompt caching active. " +
      "Claude Code handles caching automatically. For other clients, " +
      "configure cache_control breakpoints at the transport or proxy layer."
    );
  }

  const local = buildLocalLayer(config);

  // Initialize per-tool rate limiter
  const perToolLimits = parsePerToolLimits(config.OPENGROK_PER_TOOL_RATELIMIT);
  const toolRateLimiter = new ToolRateLimiter(perToolLimits);

  if (codeMode && memoryBank) {
    // Code Mode: only 5 tools exposed (api + execute + 3 memory tools).
    // ~130 token cost vs ~1,900 with all legacy tools — 93% savings per turn.
    // LLM cannot see or call legacy tools in this mode; all queries go through the sandbox.
    registerCodeModeTools(server, client, config, memoryBank, local, toolRateLimiter);
    registerMemoryTools(server, memoryBank, config, toolRateLimiter);
  } else {
    // Standard mode: 23 legacy tools only. Memory tools are Code Mode only.
    // Compact descriptions when budget=minimal to save ~1,400 tokens.
    const compactDescriptions = config.OPENGROK_CONTEXT_BUDGET === "minimal";
    registerLegacyTools(server, client, config, local, compactDescriptions, undefined, toolRateLimiter);
  }

  // Task 4.5: Register memory files as MCP Resources
  if (memoryBank) {
    registerMemoryResources(server, memoryBank);
  }

  // Task 3B: Register tool documentation as MCP Resources at opengrok-docs://tools/{name}
  registerToolDocResources(server);

  // Task 4.6: Register MCP Prompts
  registerInvestigationPrompts(server);

  // Task 5.13: MCP Completions infrastructure ready for SDK v2
  // When SDK v2 is released with completion support, uncomment this:
  // server.setCompletionRequestHandler(async (request) => {
  //   if (request.ref.name === "project" || request.ref.argument?.name === "project") {
  //     try {
  //       const projects = await client.listProjects();
  //       const query = request.argument?.value ?? "";
  //       const matching = projects
  //         .filter(p => p.toLowerCase().includes(query.toLowerCase()))
  //         .slice(0, 10);
  //       return { completion: { values: matching } };
  //     } catch {
  //       return { completion: { values: [] } };
  //     }
  //   }
  //   return { completion: { values: [] } };
  // });

  return server;
}

// ---------------------------------------------------------------------------
// Shared memory bank tool registrations (used by both Code Mode and legacy)
// ---------------------------------------------------------------------------

function registerMemoryTools(
  server: McpServer,
  memoryBank: MemoryBank,
  config: Config,
  toolRateLimiter?: ToolRateLimiter
): void {
  server.registerTool(
    "opengrok_memory_status",
    {
      title: "Memory Bank Status",
      description: "Show current memory bank file sizes and modification times.",
      inputSchema: {},
      outputSchema: {
        files: z.array(z.object({
          filename: z.string(),
          bytes: z.number().optional(),
          preview: z.string().optional(),
          empty: z.boolean(),
        })).describe("Status of each memory bank file"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true, destructiveHint: false },
    },
    async () => {
      auditLog({ type: "tool_invoke", tool: "opengrok_memory_status" });
      try {
        const lines: string[] = ["# OpenGrok Memory Status"];
        const fileStatuses: Array<{ filename: string; bytes?: number; preview?: string; empty: boolean }> = [];
        for (const filename of ALLOWED_FILES) {
          // Use statFile() — reads only the first 256 bytes for preview instead of
          // loading the entire file (investigation-log.md can be up to 32 KB).
          const stat = await memoryBank.statFile(filename);
          if (!stat) {
            lines.push(`- ${filename}: empty`);
            fileStatuses.push({ filename, empty: true });
          } else {
            const { bytes, preview } = stat;
            lines.push(`- ${filename}: ${bytes}B — "${preview}"`);
            fileStatuses.push({ filename, bytes, preview, empty: false });
          }
        }
        lines.push("");
        lines.push("Note: For general codebase context (conventions, architecture), use VS Code's");
        lines.push("built-in memory tool (/memory command) — it auto-loads at every session.");
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { files: fileStatuses },
        };
      } catch (err) {
        return makeToolError("opengrok_memory_status", err);
      }
    }
  );

  server.registerTool(
    "opengrok_read_memory",
    {
      title: "Read Memory Bank",
      description: "Read active-task.md or investigation-log.md from the memory bank.",
      inputSchema: {
        filename: z.enum(["active-task.md", "investigation-log.md"]
        ).describe("File to read from the memory bank"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_read_memory" });
      try {
        if (config.OPENGROK_ENABLE_FILES_API && args.filename === "investigation-log.md") {
          const ref = await memoryBank.getFileReference(args.filename);
          if (ref === null) {
            return { content: [{ type: "text", text: "[unchanged]" }] };
          }
          const content = await memoryBank.readCompressed(args.filename);
          if (!content) {
            return { content: [{ type: "text", text: `${args.filename} is not yet populated. Start an investigation to fill it.` }] };
          }
          return { content: [{ type: "text", text: capResponse(content) }] };
        }
        // Delta encoding: returns "[unchanged]" when hash matches last read
        const content = args.filename === "investigation-log.md"
          ? await memoryBank.readCompressed(args.filename)
          : await memoryBank.readWithDelta(args.filename);
        if (!content) {
          return { content: [{ type: "text", text: `${args.filename} is not yet populated. Start an investigation to fill it.` }] };
        }
        return { content: [{ type: "text", text: capResponse(content) }] };
      } catch (err) {
        return makeToolError("opengrok_read_memory", err);
      }
    }
  );

  server.registerTool(
    "opengrok_update_memory",
    {
      title: "Update Memory Bank",
      description: "Write or append to active-task.md or investigation-log.md.",
      inputSchema: {
        filename: z.enum(["active-task.md", "investigation-log.md"])
          .describe("File to update"),
        content: z.string().min(1).describe("Content to write"),
        mode: z.enum(["overwrite", "append"]).default("overwrite").describe("append adds to end (use for investigation-log)"),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: false, destructiveHint: false },
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_update_memory" });
      if (toolRateLimiter) await toolRateLimiter.acquire("opengrok_update_memory");
      try {
        await memoryBank.write(args.filename, args.content, args.mode);
        return { content: [{ type: "text", text: `Written to ${args.filename}` }] };
      } catch (err) {
        return makeToolError("opengrok_update_memory", err);
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Code Mode tools: opengrok_api + opengrok_execute
// ---------------------------------------------------------------------------

function registerCodeModeTools(
  server: McpServer,
  client: OpenGrokClient,
  config: Config,
  memoryBank: MemoryBank,
  local: LocalLayer,
  toolRateLimiter: ToolRateLimiter
): void {
  // Per-session pool and health-check state — scoped here so each McpServer
  // instance (stdio or HTTP session) gets its own pool and no bleed occurs.
  const workerPool = new SandboxWorkerPool();

  // Per-session counters — scoped to this server instance to prevent HTTP session bleed.
  let executeCallCount = 0;
  // Per-session masker (created once per server, tracks all turns)
  const masker = new ObservationMasker();
  let turn = 0;

  // Build getCompileInfoFn callback when local layer is available
  const getCompileInfoFn = local.enabled && local.index.size > 0
    ? async (filePath: string): Promise<unknown> => {
        let info: CompileInfo | undefined;

        // Absolute path lookup
        if (path.isAbsolute(filePath)) {
          try {
            const resolved = await fsp.realpath(filePath);
            info = local.index.get(resolved);
          } catch { /* path doesn't exist */ }
        }

        // Root-relative lookup
        if (!info) {
          const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
          for (const root of local.roots) {
            try {
              const resolved = await fsp.realpath(path.join(root, normalized));
              info = local.index.get(resolved);
              if (info) break;
            } catch { /* try next root */ }
          }
        }

        // Basename fallback
        if (!info) {
          const basename = path.basename(filePath);
          for (const [k, v] of local.index) {
            if (path.basename(k) === basename) { info = v; break; }
          }
        }

        if (!info) return null;

        return {
          file: info.file,
          compiler: info.compiler,
          standard: info.standard || undefined,
          includes: info.includes,
          defines: info.defines,
          extraFlags: info.extraFlags,
        };
      }
    : undefined;

  // Tool 1: opengrok_api — return the API spec
  server.registerTool(
    "opengrok_api",
    {
      title: "OpenGrok API Reference",
      description: "Return the full Code Mode API specification.",
      inputSchema: { _ : z.string().optional().describe("(no input required)") },
      annotations: CODE_MODE_API_ANNOTATIONS,
    },
    async () => {
      auditLog({ type: "tool_invoke", tool: "opengrok_api" });
      try {
        let projectHint = "";
        if (config.OPENGROK_ENABLE_ELICITATION && !config.OPENGROK_DEFAULT_PROJECT?.trim()) {
          const projects = await client.listProjects();
          if (projects.length > 0) {
            const projectNames = projects.map((p) => p.name).slice(0, 20);
            const result = await elicitOrFallback(
              server,
              "Which project should I work in this session?",
              {
                type: "object",
                properties: {
                  project: {
                    type: "string",
                    enum: projectNames,
                    description: "Default project for this session",
                  },
                },
                required: ["project"],
              }
            );
            if (result.action === "accept" && result.content?.project) {
              projectHint =
                `\n\n**Working project: ${result.content.project}**` +
                ` — use this project in all env.opengrok calls unless the user specifies otherwise.`;
            }
          }
        }
        const specText = yaml.dump(API_SPEC, { lineWidth: 120, noRefs: true });
        const fullText = projectHint ? `${projectHint}\n\n${specText}` : specText;
        return { content: [{ type: "text", text: capResponse(fullText) }] };
      } catch (err) {
        return makeToolError("opengrok_api", err);
      }
    }
  );

  // Tool 2: opengrok_execute — run LLM-written JavaScript in the sandbox
  server.registerTool(
    "opengrok_execute",
    {
      title: "Execute OpenGrok Code",
      description: "Execute JavaScript in the QuickJS sandbox with OpenGrok API access.",
      inputSchema: {
        code: z.string().min(1).max(65536).describe("JS function body; use env.opengrok.* for API calls; return a value."),
      },
      annotations: CODE_MODE_EXECUTE_ANNOTATIONS,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_execute" });
      if (toolRateLimiter) await toolRateLimiter.acquire("opengrok_execute");
      const currentTurn = ++turn;

      try {
        const budget = BUDGET_LIMITS[getActiveBudget()];
        const sandboxApi = createSandboxAPI(client, memoryBank, {
          getCompileInfoFn,
          mcpServer: server,
          elicitEnabled: config.OPENGROK_ENABLE_ELICITATION,
        });
        const workerHandle = workerPool.acquire();
        let result: string;
        try {
          result = await executeInSandbox(
            args.code,
            sandboxApi,
            (r) => capCodeModeResult(r, budget.maxResponseBytes),
            budget.maxResponseBytes,
            workerHandle
          );
        } finally {
          workerPool.release(workerHandle);
        }

        // When execution fails, use MCP Sampling to get an LLM-generated explanation
        if (result.startsWith("Error:")) {
          const suggestion = await sampleOrNull(server, [
            {
              role: "user",
              content: {
                type: "text",
                text: `The following JavaScript code failed in a sandbox:\n\`\`\`js\n${args.code}\n\`\`\`\n${result}\n\nBriefly explain what went wrong and suggest a fix.`,
              },
            },
          ], { maxTokens: config.OPENGROK_SAMPLING_MAX_TOKENS, systemPrompt: "You are a code debugging assistant for OpenGrok. Be concise.", model: config.OPENGROK_SAMPLING_MODEL, retries: 2 });
          const errorResult = suggestion ? `${result}\n\nSuggestion: ${suggestion}` : result;
          return { content: [{ type: "text", text: errorResult }] };
        }

        // Record in masker for future turns
        masker.record(
          currentTurn,
          "opengrok_execute",
          args.code.slice(0, 80).replace(/\n/g, " "),
          result
        );

        const historyHeader = masker.getMaskedHistoryHeader();
        let finalResult = historyHeader
          ? `${historyHeader}\n---\n${result}`
          : result;

        executeCallCount++;
        if (executeCallCount % 5 === 0 && executeCallCount > 3) {
          finalResult += "\n\n> Memory: Update active-task.md before answering.";
        }

        return { content: [{ type: "text", text: finalResult }] };
      } catch (err) {
        return makeToolError("opengrok_execute", err);
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Legacy tools (14 tools, used when Code Mode is disabled)
// ---------------------------------------------------------------------------

function registerLegacyTools(
  server: McpServer,
  client: OpenGrokClient,
  config: Config,
  local: LocalLayer,
  compactDescriptions: boolean,
  memoryBank?: MemoryBank,
  toolRateLimiter?: ToolRateLimiter
): void {
  const desc = (full: string, compact: string): string => compactDescriptions ? compact : full;
  // Per-session health check state — scoped so HTTP sessions don't share latency history.
  let lastHealthCheckLatencyMs: number | null = null;
  server.registerTool(
    "opengrok_search_code",
    {
      title: "Search Code",
      description: desc(
        "Full-text or symbol search across one or all OpenGrok projects.",
        "(fallback) search the codebase"
      ),
      inputSchema: SearchCodeArgs.shape,
      outputSchema: SearchResultsOutput.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_search_code" });
      if (toolRateLimiter) await toolRateLimiter.acquire("opengrok_search_code");
      try {
        const format = args.response_format ?? "auto";
        // Elicit project from user when none specified and elicitation is enabled
        let effectiveArgs = args;
        if (
          config.OPENGROK_ENABLE_ELICITATION &&
          !args.projects?.length &&
          !config.OPENGROK_DEFAULT_PROJECT?.trim()
        ) {
          const projects = await client.listProjects();
          if (projects.length > 0) {
            const projectNames = projects.map((p) => p.name).slice(0, 20);
            const result = await elicitOrFallback(
              server,
              "Which project should I search?",
              {
                type: "object",
                properties: {
                  project: {
                    type: "string",
                    description: "Project name",
                    enum: projectNames,
                  },
                },
                required: ["project"],
              }
            );
            if (result.action === "accept" && result.content?.project) {
              effectiveArgs = { ...args, projects: [String(result.content.project)] };
            }
          }
        }
        const { text, structured } = await executeSearchCode(effectiveArgs, client, config);
        const hasMore = structured.endIndex < structured.totalCount;
        const nextOffset = hasMore ? structured.endIndex : undefined;
        return formatResponse(
          text,
          { ...structured as unknown as Record<string, unknown>, hasMore, ...(nextOffset !== undefined ? { nextOffset } : {}) },
          format,
          "search"
        );
      } catch (err) {
        return makeToolError("opengrok_search_code", err);
      }
    }
  );

  server.registerTool(
    "opengrok_find_file",
    {
      title: "Find File",
      description: desc("Find files by name across all or one project.", "(fallback) find file by name pattern"),
      inputSchema: FindFileArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_find_file" });
      try {
        const results = await client.search(
          args.path_pattern,
          "path",
          applyDefaultProject(args.projects, config),
          args.max_results,
          args.start_index
        );
        const fmt = selectFormat("search", args.response_format as ResponseFormat | undefined);
        const maxBytes = MAX_RESPONSE_BYTES_OVERRIDE ?? BUDGET_LIMITS[getActiveBudget()].maxResponseBytes;
        const text = pickSearchFormatter(fmt, maxBytes)(results);
        return { content: [{ type: "text", text: capResponse(text) }] };
      } catch (err) {
        return makeToolError("opengrok_find_file", err);
      }
    }
  );

  server.registerTool(
    "opengrok_search_pattern",
    {
      title: "Search Pattern",
      description: desc(
        "Search the codebase using a regular expression pattern.",
        "(fallback) regex pattern search"
      ),
      inputSchema: SearchPatternArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_search_pattern" });
      try {
        const parsed = SearchPatternArgs.parse(args);
        const results = await client.searchPattern({
          pattern: parsed.pattern,
          projects: applyDefaultProject(parsed.projects, config),
          fileType: parsed.file_type,
          maxResults: parsed.max_results,
        });
        const fmt = selectFormat("search", parsed.response_format as ResponseFormat | undefined);
        const maxBytes = MAX_RESPONSE_BYTES_OVERRIDE ?? BUDGET_LIMITS[getActiveBudget()].maxResponseBytes;
        const text = pickSearchFormatter(fmt, maxBytes)(results);
        return { content: [{ type: "text", text: capResponse(text) }] };
      } catch (err) {
        return makeToolError("opengrok_search_pattern", err);
      }
    }
  );

  server.registerTool(
    "opengrok_get_file_content",
    {
      title: "Get File Content",
      description: desc(
        "Fetch file content with optional line range.",
        "(fallback) read file lines — always pass start_line + end_line"
      ),
      inputSchema: GetFileContentArgs.shape,
      outputSchema: FileContentOutput.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_file_content" });
      try {
        const format = args.response_format ?? "auto";
        const { text, structured } = await executeGetFileContent(args, client, local);
        return formatResponse(text, structured as unknown as Record<string, unknown>, format, "code");
      } catch (err) {
        return makeToolError("opengrok_get_file_content", err);
      }
    }
  );

  server.registerTool(
    "opengrok_get_file_history",
    {
      title: "Get File History",
      description: desc("Show git commit history for a file.", "(fallback) file commit history"),
      inputSchema: GetFileHistoryArgs.shape,
      outputSchema: FileHistoryOutput.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_file_history" });
      try {
        const history = await client.getFileHistory(
          args.project,
          args.path,
          args.max_entries
        );
        const structured = {
          _meta: {
            tool: "opengrok_get_file_history",
            project: args.project,
            path: args.path,
            fetchedAt: new Date().toISOString(),
            version: __VERSION__,
          },
          entries: history.entries.map((e) => ({
            revision: e.revision,
            author: e.author,
            date: e.date,
            message: e.message,
          })),
        };
        return {
          content: [
            { type: "text" as const, text: capResponse(formatFileHistory(history)) },
            { type: "resource_link" as const, uri: `${config.OPENGROK_BASE_URL}/xref/${args.project}${args.path}`, name: args.path, mimeType: getMimeType(args.path) },
          ],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return makeToolError("opengrok_get_file_history", err);
      }
    }
  );

  // Tool: opengrok_get_file_diff — diff between two revisions
  server.registerTool(
    "opengrok_get_file_diff",
    {
      title: "Get File Diff",
      description: desc(
        "Diff between two revisions of a file (unified diff format).",
        "(fallback) diff between two file revisions"
      ),
      inputSchema: GetFileDiffArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_file_diff" });
      try {
        const diff = await client.getFileDiff(args.project, args.path, args.rev1, args.rev2);
        const fmt = selectFormat("generic", args.response_format);
        return {
          content: [{ type: "text" as const, text: capResponse(formatFileDiff(diff, fmt)) }],
          structuredContent: {
            _meta: {
              tool: "opengrok_get_file_diff",
              project: args.project,
              path: args.path,
              rev1: args.rev1,
              rev2: args.rev2,
              fetchedAt: new Date().toISOString(),
              version: __VERSION__,
            },
            stats: diff.stats,
            hunks: diff.hunks.map(h => ({
              oldStart: h.oldStart, oldCount: h.oldCount,
              newStart: h.newStart, newCount: h.newCount,
              lines: h.lines.length,
            })),
          } as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return makeToolError("opengrok_get_file_diff", err);
      }
    }
  );

  server.registerTool(
    "opengrok_browse_directory",
    {
      title: "Browse Directory",
      description: desc("List files and subdirectories in a project directory.", "(fallback) list directory contents"),
      inputSchema: BrowseDirectoryArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_browse_directory" });
      try {
        const entries = await client.browseDirectory(args.project, args.path);
        return {
          content: [
            {
              type: "text",
              text: capResponse(formatDirectoryListing(entries, args.project, args.path)),
            },
          ],
        };
      } catch (err) {
        return makeToolError("opengrok_browse_directory", err);
      }
    }
  );

  server.registerTool(
    "opengrok_list_projects",
    {
      title: "List Projects",
      description: desc("List all indexed OpenGrok projects.", "(fallback) list all indexed projects"),
      inputSchema: ListProjectsArgs.shape,
      outputSchema: ProjectsListOutput.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_list_projects" });
      try {
        const format = args.response_format ?? "auto";
        const { text, structured } = await executeListProjects(args, client);
        return formatResponse(text, structured as unknown as Record<string, unknown>, format, "generic");
      } catch (err) {
        return makeToolError("opengrok_list_projects", err);
      }
    }
  );

  server.registerTool(
    "opengrok_get_file_annotate",
    {
      title: "Get File Annotate",
      description: desc(
        "Annotate each line with its last commit (git blame).",
        "(fallback) line-by-line blame"
      ),
      inputSchema: GetFileAnnotateArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_file_annotate" });
      try {
        const annotated = await client.getAnnotate(args.project, args.path);
        return {
          content: [
            {
              type: "text",
              text: capResponse(formatAnnotate(annotated, args.start_line, args.end_line)),
            },
          ],
        };
      } catch (err) {
        return makeToolError("opengrok_get_file_annotate", err);
      }
    }
  );

  server.registerTool(
    "opengrok_search_suggest",
    {
      title: "Search Suggest",
      description: desc("Autocomplete suggestions for a partial search query.", "(fallback) search autocomplete suggestions"),
      inputSchema: SearchSuggestArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_search_suggest" });
      try {
        const result = await client.suggest(args.query, args.project, args.field);
        let text: string;
        if (result.suggestions.length) {
          text = "Suggestions:\n" + result.suggestions.map((s) => `  ${s}`).join("\n");
        } else if (result.time === 0) {
          text =
            "No suggestions found. The suggester index appears to be empty — an OpenGrok admin may need to rebuild it.";
        } else {
          text = "No suggestions found.";
        }
        return { content: [{ type: "text", text: capResponse(text) }] };
      } catch (err) {
        // 404/405 means the suggester endpoint is not available on this server
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("404") || msg.includes("405")) {
          return {
            content: [{
              type: "text",
              text: "Search suggestions are not supported by this OpenGrok instance. " +
                "Use opengrok_search_code instead.",
            }],
          };
        }
        return makeToolError("opengrok_search_suggest", err);
      }
    }
  );

  // -----------------------------------------------------------------------
  // Compound tools
  // -----------------------------------------------------------------------

  server.registerTool(
    "opengrok_batch_search",
    {
      title: "Batch Search",
      description: desc(
        "Execute 2-5 parallel OpenGrok searches in one call.",
        "(fallback) 2–5 parallel searches in 1 call"
      ),
      inputSchema: BatchSearchArgs.shape,
      outputSchema: BatchSearchOutput.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_batch_search" });
      if (toolRateLimiter) await toolRateLimiter.acquire("opengrok_batch_search");
      try {
        const format = args.response_format ?? "auto";
        const { text, structured } = await executeBatchSearch(args, client, config);
        return formatResponse(text, structured as unknown as Record<string, unknown>, format, "search");
      } catch (err) {
        return makeToolError("opengrok_batch_search", err);
      }
    }
  );

  server.registerTool(
    "opengrok_search_and_read",
    {
      title: "Search and Read",
      description: desc(
        "Search then read matching files in a single call.",
        "(fallback) search + surrounding code in 1 call"
      ),
      inputSchema: SearchAndReadArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_search_and_read" });
      try {
        const text = await handleSearchAndRead(
          args as unknown as Record<string, unknown>,
          client,
          config
        );
        return { content: [{ type: "text", text: capResponse(text) }] };
      } catch (err) {
        return makeToolError("opengrok_search_and_read", err);
      }
    }
  );

  server.registerTool(
    "opengrok_get_symbol_context",
    {
      title: "Get Symbol Context",
      description: desc(
        "Complete symbol investigation: definition + header + references in one call.",
        "(fallback) symbol definition + header + refs in 1 call"
      ),
      inputSchema: GetSymbolContextArgs.shape,
      outputSchema: SymbolContextOutput.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_symbol_context" });
      try {
        const format = (args.response_format ?? "auto") as ResponseFormat;
        const { text, structured } = await handleGetSymbolContextStructured(
          args as unknown as Record<string, unknown>,
          client,
          config
        );
        const effectiveFmt = selectFormat("symbol", format);
        let displayText: string;
        if (effectiveFmt === "json") {
          displayText = capResponse(JSON.stringify(structured, null, 2));
        } else if (effectiveFmt === "yaml") {
          displayText = capResponse(
            formatSymbolContextYAML(structured as unknown as SymbolContextResult)
          );
        } else {
          displayText = capResponse(text);
        }
        return {
          content: [{ type: "text", text: displayText }],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return makeToolError("opengrok_get_symbol_context", err);
      }
    }
  );

  server.registerTool(
    "opengrok_index_health",
    {
      title: "Index Health",
      description: desc(
        "Check OpenGrok server health and indexed project list.",
        "(fallback) server connectivity and index status"
      ),
      inputSchema: IndexHealthArgs.shape,
      outputSchema: {
        connected: z.boolean().describe("Whether the OpenGrok server is reachable"),
        latencyMs: z.number().optional().describe("Round-trip latency in milliseconds"),
        indexedProjects: z.number().describe("Number of indexed projects"),
        latencyTrend: z.enum(["stable", "increasing", "first_check"]).describe("Latency trend since last check"),
        stalenessScore: z.enum(["healthy", "possibly_stale", "likely_stale"]).describe("Index freshness estimate"),
        warnings: z.array(z.string()).describe("Any connectivity or index warnings"),
        message: z.string().describe("Human-readable status message"),
      },
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_index_health" });
      try {
        const format = selectFormat("generic", (args as unknown as { response_format?: string }).response_format as never);

        const start = Date.now();
        const ok = await client.testConnection();
        const latencyMs = Date.now() - start;

        // Collect project count and any warnings
        let indexedProjects = 0;
        const warnings: string[] = [];
        try {
          const projects = await client.listProjects();
          indexedProjects = projects.length;
        } catch {
          warnings.push("Could not retrieve project list");
        }

        // Compute staleness signals
        let latencyTrend: "stable" | "increasing" | "first_check" = "first_check";
        let stalenessScore: "healthy" | "possibly_stale" | "likely_stale" = "healthy";

        if (lastHealthCheckLatencyMs !== null) {
          latencyTrend = latencyMs > lastHealthCheckLatencyMs * 1.5 ? "increasing" : "stable";
        }
        lastHealthCheckLatencyMs = latencyMs;

        if (latencyMs > 500) {
          stalenessScore = latencyTrend === "increasing" ? "likely_stale" : "possibly_stale";
        }
        if (indexedProjects === 0 && ok) {
          warnings.push("No projects indexed");
          stalenessScore = "possibly_stale";
        }

        if (ok) {
          client.warmCache();
        }

        const message = ok
          ? `OpenGrok: connected (${latencyMs}ms, ${indexedProjects} projects, staleness: ${stalenessScore})`
          : "OpenGrok: connection failed";

        const health = { connected: ok, latencyMs, indexedProjects, latencyTrend, stalenessScore, warnings, message };

        if (format === "json") {
          return {
            content: [{ type: "text", text: JSON.stringify(health, null, 2) }],
            structuredContent: health,
          };
        }

        const lines = [
          "# OpenGrok Health",
          "",
          `- **Connected:** ${health.connected}`,
          `- **Latency:** ${health.latencyMs}ms`,
          `- **Indexed projects:** ${health.indexedProjects}`,
          `- **Latency trend:** ${health.latencyTrend}`,
          `- **Staleness:** ${health.stalenessScore}`,
          ...(health.warnings.length > 0 ? [`- **Warnings:** ${health.warnings.join(", ")}`] : []),
        ].join("\n");

        return {
          content: [{ type: "text", text: lines }],
          structuredContent: health,
        };
      } catch (err) {
        return makeToolError("opengrok_index_health", err);
      }
    }
  );

  server.registerTool(
    "opengrok_get_compile_info",
    {
      title: "Get Compile Info",
      description: desc(
        "Get compiler flags and include paths from compile_commands.json.",
        "(fallback) compiler flags for a file (requires local compile_commands.json)"
      ),
      inputSchema: GetCompileInfoArgs.shape,
      annotations: READ_ONLY_LOCAL,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_compile_info" });
      try {
        const text = await handleGetCompileInfo(
          args as unknown as Record<string, unknown>,
          config,
          local
        );
        return { content: [{ type: "text", text: capResponse(text) }] };
      } catch (err) {
        return makeToolError("opengrok_get_compile_info", err);
      }
    }
  );

  server.registerTool(
    "opengrok_get_file_symbols",
    {
      title: "Get File Symbols",
      description: desc(
        "List all symbols (functions, classes, variables) defined in a file.",
        "(fallback) file symbols list — call before get_file_content"
      ),
      inputSchema: GetFileSymbolsArgs.shape,
      outputSchema: FileSymbolsOutput.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_get_file_symbols" });
      try {
        const result = await client.getFileSymbols(args.project, args.path);
        const structured = {
          _meta: {
            tool: "opengrok_get_file_symbols",
            project: args.project,
            path: args.path,
            fetchedAt: new Date().toISOString(),
            version: __VERSION__,
          },
          symbols: result.symbols.map((s) => ({
            name: s.symbol,
            type: s.type,
            line: s.line,
          })),
        };
        if (!result.symbols.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No symbols found for ${args.path} in project ${args.project}. The file may not be indexed or the OpenGrok instance does not support the /api/v1/file/defs endpoint.`,
              },
            ],
            structuredContent: structured as unknown as Record<string, unknown>,
          };
        }
        return {
          content: [
            { type: "text" as const, text: capResponse(formatFileSymbols(result)) },
            { type: "resource_link" as const, uri: `${config.OPENGROK_BASE_URL}/xref/${args.project}${args.path}`, name: args.path, mimeType: getMimeType(args.path) },
          ],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return makeToolError("opengrok_get_file_symbols", err);
      }
    }
  );

  server.registerTool(
    "opengrok_call_graph",
    {
      title: "Get Call Graph",
      description: desc(
        "Find all callers and callees of a function or method symbol.",
        "(fallback) callers and callees of a symbol"
      ),
      inputSchema: CallGraphArgs.shape,
      outputSchema: SearchResultsOutput.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_call_graph" });
      try {
        const parsed = CallGraphArgs.parse(args as unknown as Record<string, unknown>);
        const results = await client.getCallGraph(parsed.project, parsed.symbol);
        const fmt = selectFormat("search", parsed.response_format as ResponseFormat | undefined);
        const maxBytes = MAX_RESPONSE_BYTES_OVERRIDE ?? BUDGET_LIMITS[getActiveBudget()].maxResponseBytes;
        const text = pickSearchFormatter(fmt, maxBytes)(results);
        const structured = {
          _meta: {
            tool: "opengrok_call_graph",
            project: parsed.project,
            symbol: parsed.symbol,
            fetchedAt: new Date().toISOString(),
            version: __VERSION__,
          },
          results: results.results.map((r: SearchResult) => ({
            file: r.path,
            project: r.project,
            lines: r.matches.map((m: SearchMatch) => ({
              number: m.lineNumber,
              content: m.lineContent,
            })),
          })),
        };
        return {
          content: [{ type: "text", text }],
          ...(fmt === "json" ? { structuredContent: structured as unknown as Record<string, unknown> } : {}),
        };
      } catch (err) {
        return makeToolError("opengrok_call_graph", err);
      }
    }
  );

  server.registerTool(
    "opengrok_what_changed",
    {
      title: "What Changed",
      description: desc(
        "Show which lines changed recently in a file, grouped by commit.",
        "(fallback) recent line changes grouped by commit"
      ),
      inputSchema: WhatChangedArgs.shape,
      outputSchema: WhatChangedOutput.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_what_changed" });
      try {
        const parsed = WhatChangedArgs.parse(args);
        const [history, annotation] = await Promise.all([
          client.getFileHistory(parsed.project, parsed.path),
          client.getAnnotate(parsed.project, parsed.path),
        ]);
        const text = formatWhatChanged(history, annotation, parsed.since_days);

        // Build structured changes from the same logic as formatWhatChanged
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - parsed.since_days);
        const recentRevisions = new Set<string>();
        for (const entry of history.entries) {
          const entryDate = new Date(entry.date);
          if (!isNaN(entryDate.getTime()) && entryDate >= cutoff) {
            recentRevisions.add(entry.revision);
          }
        }
        const byRevision = new Map<string, { author: string; date: string; lines: number[] }>();
        for (const line of annotation.lines) {
          if (!recentRevisions.has(line.revision)) continue;
          let group = byRevision.get(line.revision);
          if (!group) {
            group = { author: line.author, date: line.date, lines: [] };
            byRevision.set(line.revision, group);
          }
          group.lines.push(line.lineNumber);
        }
        const changes = [...byRevision.entries()].map(([commit, { author, date, lines }]) => ({
          commit,
          author,
          date,
          lines,
        }));

        const structured = {
          _meta: {
            tool: "opengrok_what_changed",
            project: parsed.project,
            path: parsed.path,
            fetchedAt: new Date().toISOString(),
            version: __VERSION__,
          },
          changes,
        };
        return {
          content: [{ type: "text" as const, text: capResponse(text) }],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return makeToolError("opengrok_what_changed", err);
      }
    }
  );

  server.registerTool(
    "opengrok_blame",
    {
      title: "Git Blame",
      description: desc(
        "Git blame with optional diff for a file path.",
        "(fallback) git blame annotation"
      ),
      inputSchema: BlameArgs.shape,
      outputSchema: BlameOutput.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_blame" });
      try {
        const parsed = BlameArgs.parse(args);
        const annotations = await client.getAnnotate(parsed.project, parsed.path);
        const text = formatBlame(annotations, parsed.line_start, parsed.line_end, parsed.include_diff);

        let displayLines = annotations.lines;
        if (parsed.line_start !== undefined || parsed.line_end !== undefined) {
          /* v8 ignore start */
          const s = parsed.line_start ?? 1;
          const e = parsed.line_end ?? Infinity;
          /* v8 ignore stop */
          displayLines = annotations.lines.filter((l) => l.lineNumber >= s && l.lineNumber <= e);
        }

        const structured: z.infer<typeof BlameOutput> = {
          _meta: { tool: "opengrok_blame", project: parsed.project, path: parsed.path, fetchedAt: new Date().toISOString(), version: VERSION },
          entries: displayLines.map((l) => ({
            line: l.lineNumber,
            commit: l.revision ?? "",
            author: l.author ?? "",
            date: l.date ?? "",
            content: l.content,
          })),
        };

        return {
          content: [{ type: "text", text: capResponse(text) }],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return makeToolError("opengrok_blame", err);
      }
    }
  );

  server.registerTool(
    "opengrok_dependency_map",
    {
      title: "Dependency Map",
      description: desc(
        "Build #include/import dependency graph (configurable depth).",
        "(fallback) #include/import dependency graph, configurable depth"
      ),
      inputSchema: DependencyMapArgs.shape,
      outputSchema: DependencyMapOutput.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_dependency_map" });
      if (toolRateLimiter) await toolRateLimiter.acquire("opengrok_dependency_map");
      try {
        const parsed = DependencyMapArgs.parse(args);
        const nodes = await buildDependencyGraph(client, parsed.project, parsed.path, parsed.depth, parsed.direction);
        const text = formatDependencyMap(parsed.path, parsed.depth, nodes);
        const structured = {
          _meta: {
            tool: "opengrok_dependency_map",
            project: parsed.project,
            path: parsed.path,
            fetchedAt: new Date().toISOString(),
            version: __VERSION__,
          },
          nodes: nodes.map((n) => ({
            path: n.path,
            level: n.level,
            direction: n.direction,
          })),
        };

        // For large graphs, use MCP Sampling to generate an intelligent summary
        let summarySection = "";
        if (nodes.length > 10) {
          const nodeList = nodes.slice(0, 30).map((n) => `  ${n.direction} ${n.path} (level ${n.level})`).join("\n");
          const summary = await sampleOrNull(server, [
            {
              role: "user",
              content: {
                type: "text",
                text: `This dependency graph for \`${parsed.path}\` has ${nodes.length} nodes:\n${nodeList}${nodes.length > 30 ? `\n  ... and ${nodes.length - 30} more` : ""}\n\nIn 2-3 sentences, summarize the key dependency structure and any notable patterns.`,
              },
            },
          ], { maxTokens: 200, systemPrompt: "You are a code architecture analyst. Be concise and precise." });
          if (summary) {
            summarySection = `\n\n**Summary**: ${summary}`;
          }
        }

        return {
          content: [{ type: "text" as const, text: capResponse(text) + summarySection }],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return makeToolError("opengrok_dependency_map", err);
      }
    }
  );

  // Memory bank tools — available when a MemoryBank is provided
  if (memoryBank) {
    registerMemoryTools(server, memoryBank, config);
  }
  // registerLegacyTools intentionally returns void — server is mutated in place
}

// ---------------------------------------------------------------------------
// Task 3B: MCP Resources — tool documentation at opengrok-docs://tools/{name}
// ---------------------------------------------------------------------------

function registerToolDocResources(server: McpServer): void {
  try {
    server.resource(
      'opengrok-tool-docs',
      new ResourceTemplate('opengrok-docs://tools/{name}', { list: undefined }),
      (uri, variables) => {
        const name = String(variables['name'] ?? '');
        const doc = TOOL_DOCS[name];
        if (!doc) {
          throw new Error(`No documentation found for tool: ${name}`);
        }
        return {
          contents: [{ uri: uri.href, mimeType: 'text/markdown', text: doc }],
        };
      }
    );
  } catch {
    // Resource registration may not be supported in all SDK versions — skip gracefully
  }
}

// ---------------------------------------------------------------------------
// Task 4.5: MCP Resources — expose memory bank files for direct browsing
// ---------------------------------------------------------------------------

function registerMemoryResources(server: McpServer, memoryBank: MemoryBank): void {
  for (const filename of ALLOWED_FILES) {
    const uri = `opengrok-memory://${filename}`;
    server.registerResource(
      filename,
      uri,
      {
        description: `OpenGrok memory bank file: ${filename}`,
        mimeType: "text/markdown",
      },
      async () => {
        const content = await memoryBank.read(filename) ?? "";
        return {
          contents: [{ uri, mimeType: "text/markdown", text: content }],
        };
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Task 4.6: MCP Prompts — reusable investigation workflows
// ---------------------------------------------------------------------------

/**
 * Sanitize user-supplied prompt arguments to prevent injection of template
 * directives or tool instructions into the prompt messages.
 * Strips backtick sequences (MCP tool-call syntax), angle brackets, and
 * removes embedded newlines that could inject extra instructions.
 */
function sanitizePromptArg(value: string): string {
  return value
    .replace(/`[^`]*`/g, (m) => m.replace(/[<>]/g, ""))  // strip angle brackets inside backticks
    .replace(/[\r\n]+/g, " ")                              // collapse newlines → space
    .trim()
    .slice(0, 256);                                        // hard cap to prevent oversized inputs
}

function registerInvestigationPrompts(server: McpServer): void {
  server.registerPrompt(
    "investigate-symbol",
    {
      description:
        "Investigate a symbol across definition, usages, callers, and recent changes. " +
        "Guides the LLM through a structured symbol-level investigation.",
      argsSchema: {
        symbol: z.string().describe("The symbol name to investigate (function, class, variable, etc.)"),
        project: z.string().optional().describe("OpenGrok project to scope the search to"),
      },
    },
    ({ symbol, project }) => {
      const sym = sanitizePromptArg(symbol);
      const proj = project ? sanitizePromptArg(project) : undefined;
      const scope = proj ? ` in project \`${proj}\`` : "";
      return {
        description: `Investigate symbol \`${sym}\`${scope}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Investigate the symbol \`${sym}\`${scope} using the OpenGrok MCP server.`,
                "",
                "Follow these steps in order:",
                `1. **Definition** — use \`opengrok_search_code\` with type \`defs\` to find where \`${sym}\` is defined.`,
                `2. **Usages** — use \`opengrok_search_code\` with type \`refs\` to find all references.`,
                `3. **Symbol context** — use \`opengrok_get_symbol_context\` to see the full declaration with surrounding code.`,
                `4. **Recent changes** — use \`opengrok_what_changed\` or \`opengrok_get_file_history\` on the definition file.`,
                "",
                "Summarise: what the symbol does, where it is defined, how widely it is used, and any recent modifications.",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "find-feature",
    {
      description:
        "Find where a feature is implemented in the codebase. " +
        "Guides the LLM through searching, reading key files, and mapping entry points.",
      argsSchema: {
        feature: z.string().describe("Description of the feature to locate (e.g. 'rate limiting', 'authentication')"),
        project: z.string().optional().describe("OpenGrok project to scope the search to"),
      },
    },
    ({ feature, project }) => {
      const feat = sanitizePromptArg(feature);
      const proj = project ? sanitizePromptArg(project) : undefined;
      const scope = proj ? ` in project \`${proj}\`` : "";
      return {
        description: `Find feature: ${feat}${scope}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Find where the feature "${feat}" is implemented${scope}.`,
                "",
                "Approach:",
                `1. **Full-text search** — use \`opengrok_search_code\` with type \`full\` for keywords related to "${feat}".`,
                "2. **Path search** — use \`opengrok_search_code\` with type \`path\` to find files named after the feature.",
                "3. **Read candidates** — use \`opengrok_get_file_content\` to read the most relevant files.",
                "4. **Browse structure** — use \`opengrok_browse_directory\` on relevant directories to map the module layout.",
                "",
                "Summarise: the entry point(s), key files, and a brief explanation of how the feature works.",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "review-file",
    {
      description:
        "Perform a code review of a specific file. " +
        "Guides the LLM through reading, history, callers, and producing a structured review.",
      argsSchema: {
        path: z.string().describe("Repository-relative path to the file to review"),
        project: z.string().describe("OpenGrok project the file belongs to"),
      },
    },
    ({ path: filePath, project }) => {
      const fp = sanitizePromptArg(filePath);
      const proj = sanitizePromptArg(project);
      return {
        description: `Review file: ${fp}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Perform a code review of \`${fp}\` in project \`${proj}\`.`,
                "",
                "Steps:",
                `1. **Read file** — use \`opengrok_get_file_content\` for project \`${proj}\`, path \`${fp}\`.`,
                `2. **File history** — use \`opengrok_get_file_history\` to understand recent changes.`,
                `3. **Symbols** — use \`opengrok_get_file_symbols\` to list the public API surface.`,
                `4. **Callers** — for each exported symbol, check \`opengrok_search_code\` with type \`refs\` to understand how it is used.`,
                `5. **Annotations** — use \`opengrok_get_file_annotate\` to see which commits touched which lines.`,
                "",
                "Produce a structured review covering:",
                "- **Purpose**: what the file does",
                "- **Design observations**: naming, structure, separation of concerns",
                "- **Potential issues**: bugs, edge cases, error handling",
                "- **Test coverage signals**: anything that looks under-tested",
                "- **Recommendations**: concrete, prioritised action items",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );
}

// ---------------------------------------------------------------------------
// Run the server over stdio
// ---------------------------------------------------------------------------

/**
 * Per-tool rate limiter using token bucket algorithm.
 * Prevents any single tool from monopolizing the connection.
 * Applies per-tool limits on top of the global client rate limit.
 */
class ToolRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private readonly limits: Map<string, number>; // tool name → calls per minute
  private readonly defaultLimit: number;

  constructor(limits: Record<string, number>, defaultLimit: number = 60) {
    this.limits = new Map(Object.entries(limits));
    this.defaultLimit = defaultLimit;
  }

  /**
   * Acquire a token for the given tool name.
   * Returns immediately if a token is available, otherwise waits up to
   * `maxWaitMs` (default 30 s). Throws if the limit cannot be satisfied
   * within the timeout to prevent indefinite request queuing.
   */
  async acquire(toolName: string, maxWaitMs = 30_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;

    return new Promise((resolve, reject) => {
      const checkToken = (): void => {
        if (Date.now() > deadline) {
          reject(new Error(`Rate limit exceeded for ${toolName}: no token available within ${maxWaitMs}ms`));
          return;
        }

        const limit = this.limits.get(toolName) ?? this.defaultLimit;
        const interval = 60000 / limit; // ms per token
        const now = Date.now();

        let bucket = this.buckets.get(toolName);
        if (!bucket) {
          bucket = { tokens: limit, lastRefill: now };
          this.buckets.set(toolName, bucket);
        }

        // Refill tokens based on elapsed time
        const elapsed = now - bucket.lastRefill;
        const tokensToAdd = (elapsed / interval) * 1;
        bucket.tokens = Math.min(limit, bucket.tokens + tokensToAdd);
        bucket.lastRefill = now;

        if (bucket.tokens >= 1) {
          bucket.tokens -= 1;
          resolve();
        } else {
          // Wait for next token to be available, then try again
          const waitMs = Math.min(
            Math.max(10, (1 - bucket.tokens) * interval),
            deadline - Date.now()
          );
          if (waitMs <= 0) {
            reject(new Error(`Rate limit exceeded for ${toolName}: no token available within ${maxWaitMs}ms`));
          } else {
            setTimeout(checkToken, waitMs);
          }
        }
      };

      checkToken();
    });
  }
}

/**
 * Task 4.9: Setup handlers for notifications/tools/list_changed.
 * Monitors for config changes (SIGHUP) and connectivity status changes.
 */
function setupNotificationHandlers(server: McpServer, client: OpenGrokClient, config: Config): void {
  // On SIGHUP, reload config and notify if code mode changed
  process.on("SIGHUP", () => {
    try {
      auditLog({ type: "config_load", detail: "SIGHUP: config reload initiated" });
      logger.info("Received SIGHUP, reloading config...");

      // Clear the singleton so loadConfig() re-reads from process.env
      resetConfig();
      const newConfig = loadConfig();
        
        // Check if code mode changed
        if (newConfig.OPENGROK_CODE_MODE !== config.OPENGROK_CODE_MODE) {
          logger.info(
            `Code Mode changed: ${config.OPENGROK_CODE_MODE} → ${newConfig.OPENGROK_CODE_MODE}`,
            { detail: "Notifying clients of tool list change" }
          );
          server.sendToolListChanged();
          auditLog({ 
            type: "config_load", 
            detail: `SIGHUP: Code Mode toggled to ${newConfig.OPENGROK_CODE_MODE}` 
          });
        }
    } catch (err) {
      logger.error("SIGHUP reload failed", { error: String(err) });
    }
  });
}

/**
 * Task 4.9: Start health check polling after server connects.
 * Every 5 minutes, tests connectivity and sends notification if status changes.
 * Returns the interval ID so it can be cleaned up if needed.
 */
export function startHealthCheckPolling(server: McpServer, client: OpenGrokClient): NodeJS.Timeout {
  let lastConnected = false;

  return setInterval(() => {
    void (async () => {
      try {
        const ok = await client.testConnection();
        if (ok !== lastConnected) {
          lastConnected = ok;
          logger.info(`Connectivity status changed: ${ok ? "connected" : "disconnected"}`);
          server.sendToolListChanged();
          auditLog({
            type: "config_load",
            detail: `Connectivity status changed to ${ok ? "connected" : "disconnected"}`
          });
        }
      } catch {
        // Silently ignore health check errors
      }
    })();
  }, 5 * 60 * 1000);
}

/* v8 ignore start -- runServer connects to stdio transport; integration-level */
export async function runServer(
  client: OpenGrokClient,
  config: Config,
  memoryBank?: MemoryBank
): Promise<void> {
  // Inject memory status into instructions so the LLM sees prior context at session start.
  const codeMode = config.OPENGROK_CODE_MODE;
  const baseTemplate = codeMode ? SERVER_INSTRUCTIONS_CODE_MODE_TEMPLATE : SERVER_INSTRUCTIONS_TEMPLATE;
  let resolvedInstructions = baseTemplate;
  if (memoryBank) {
    try {
      const memStatus = await memoryBank.getStatusLine();
      resolvedInstructions = baseTemplate.replace("{{MEMORY_STATUS}}", memStatus);
    } catch {
      resolvedInstructions = baseTemplate.replace("{{MEMORY_STATUS}}", "[Memory] No prior context.");
    }
  } else {
    resolvedInstructions = baseTemplate.replace("{{MEMORY_STATUS}}", "[Memory] No prior context.");
  }

  const server = createServer(client, config, memoryBank, resolvedInstructions);
  const transport = new StdioServerTransport();

  const state: { healthCheckInterval?: NodeJS.Timeout } = {};

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    if (state.healthCheckInterval) clearInterval(state.healthCheckInterval);
    await client.close();
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

  // Security: warn when credentials are transmitted over plaintext HTTP
  if (
    config.OPENGROK_BASE_URL.startsWith("http://") &&
    (config.OPENGROK_USERNAME || config.OPENGROK_PASSWORD)
  ) {
    logger.warn(
      "Credentials configured but base URL uses plaintext HTTP. Use HTTPS to protect credentials in transit."
    );
  }

  logger.info(`Starting server v${VERSION}, connected to: ${config.OPENGROK_BASE_URL}`);

  if (!config.OPENGROK_USERNAME) {
    logger.warn(
      "OPENGROK_USERNAME not configured. Set OPENGROK_USERNAME and OPENGROK_PASSWORD environment variables."
    );
  }

  // Task 4.14: Check credential age and warn if stale
  const credentialAgeWarning = getCredentialAgeWarning();
  if (credentialAgeWarning) {
    logger.warn(`Task 4.14 — ${credentialAgeWarning}`);
    auditLog({ type: "config_load", detail: credentialAgeWarning });
  }

  // Task 4.9: Monitor config changes and connectivity for tool list changes
  setupNotificationHandlers(server, client, config);

  await server.connect(transport);

  // Start health check polling after server connects
  state.healthCheckInterval = startHealthCheckPolling(server, client);
}
/* v8 ignore stop */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeErrorMessage(message: string): string {
  let sanitized = message.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]");
  sanitized = sanitized.replace(/:[^:@\s]+@/g, ":***@");
  sanitized = sanitized.replace(
    /\/(?:home|tmp|var|usr|build|opt|mnt|srv)(?:\/\S+)/g,
    "[path]"
  );
  sanitized = sanitized.replace(
    /[A-Z]:\\(?:Users|Windows|Program Files|build)(?:\\\S+)/gi,
    "[path]"
  );
  return sanitized;
}

/**
 * Get credential age warning (if applicable).
 * Task 4.14: Credential Rotation Warnings
 * Returns warning string if credentials are older than 90 days.
 */
function getCredentialAgeWarning(): string | null {
  try {
    const configDir = getConfigDirectory();
    return checkCredentialAge(configDir);
  } catch {
    return null; // config module or directory check failed
  }
}

/**
 * Build a dependency graph for a file by searching up to `depth` levels.
 * "uses"    — finds files that this file imports/includes (full-text search for
 *             include/import/require/use directives within the target file's content).
 *             Uses "full" search on import/include patterns to find what the file depends on.
 * "used_by" — finds files that reference/call symbols from this file (refs search by filename).
 */
async function buildDependencyGraph(
  client: OpenGrokClient,
  project: string,
  filePath: string,
  depth: number,
  direction: "uses" | "used_by" | "both"
): Promise<DependencyNode[]> {
  const nodes: DependencyNode[] = [];
  const seenUsesPaths = new Set<string>();
  const seenUsedByPaths = new Set<string>();

  const rootName = filePath.split("/").pop() ?? "";

  // "uses" direction: level-parallel BFS — all nodes at the same depth are searched concurrently.
  if (direction === "uses" || direction === "both") {
    let frontier: string[] = [filePath];
    const expandedUses = new Set<string>();

    for (let level = 1; level <= depth && frontier.length > 0; level++) {
      const toExpand = frontier.filter((p) => !expandedUses.has(p));
      toExpand.forEach((p) => expandedUses.add(p));
      frontier = [];

      if (toExpand.length === 0) break;

      // Issue all searches at this BFS level in parallel
      const levelResults = await Promise.all(
        toExpand.map((currentPath) => {
          const currentName = currentPath.split("/").pop() ?? "";
          return client.search(currentName, "path", [project], 20);
        })
      );

      for (const results of levelResults) {
        for (const r of results.results) {
          if (r.path === filePath) continue;
          if (!seenUsesPaths.has(r.path)) {
            seenUsesPaths.add(r.path);
            nodes.push({ path: r.path, level, direction: "uses" });
          }
          if (level < depth) frontier.push(r.path);
        }
      }
    }
  }

  // "used_by" direction: level-parallel BFS — find files that reference this file's symbols.
  if (direction === "used_by" || direction === "both") {
    let frontier: string[] = [rootName];
    const expandedUsedBy = new Set<string>();

    for (let level = 1; level <= depth && frontier.length > 0; level++) {
      const toExpand = frontier.filter((n) => !expandedUsedBy.has(n));
      toExpand.forEach((n) => expandedUsedBy.add(n));
      frontier = [];

      if (toExpand.length === 0) break;

      // Issue all searches at this BFS level in parallel
      const levelResults = await Promise.all(
        toExpand.map((filename) =>
          client.search(filename, "refs", [project], 20)
        )
      );

      for (const results of levelResults) {
        for (const r of results.results) {
          if (r.path === filePath) continue;
          const rName = r.path.split("/").pop() ?? "";
          if (!seenUsedByPaths.has(r.path)) {
            seenUsedByPaths.add(r.path);
            nodes.push({ path: r.path, level, direction: "used_by" });
          }
          if (level < depth) frontier.push(rName);
        }
      }
    }
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  capResponse as _capResponse,
  sanitizeErrorMessage as _sanitizeErrorMessage,
  resolveFileFromIndex as _resolveFileFromIndex,
  buildLocalLayer as _buildLocalLayer,
  tryLocalRead as _tryLocalRead,
  readFileAtAbsPath as _readFileAtAbsPath,
  applyDefaultProject as _applyDefaultProject,
  dispatchTool as _dispatchTool,
  SERVER_INSTRUCTIONS as _SERVER_INSTRUCTIONS,
  capCodeModeResult as _capCodeModeResult,
  deduplicateAcrossQueries as _deduplicateAcrossQueries,
};
export type { LocalLayer as _LocalLayer };
