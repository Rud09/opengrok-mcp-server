/**
 * OpenGrok MCP Server — tool definitions and handlers.
 * v4.0: McpServer high-level API, opengrok_ prefixed tools, tool annotations,
 *       structured output, isError responses, security hardening.
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, ZodError } from "zod";
import type { OpenGrokClient } from "./client.js";
import { extractLineRange } from "./client.js";
import type { Config } from "./config.js";
import { parsePerToolLimits, parseAllowedClientIds, getConfigDirectory, checkCredentialAge, loadConfig } from "./config.js";
import {
  formatAnnotate,
  formatBatchSearchResults,
  formatBatchSearchResultsTSV,
  formatBlame,
  formatCompileInfo,
  formatDirectoryListing,
  formatFileContent,
  formatFileContentText,
  formatFileHistory,
  formatFileSymbols,
  formatProjectsList,
  formatSearchAndRead,
  formatSearchResults,
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
  GetFileHistoryArgs,
  GetFileSymbolsArgs,
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
} from "./models.js";
import type {
  FileContent,
  SearchResults,
  Project,
} from "./models.js";
import { BUDGET_LIMITS } from "./config.js";
import type { ContextBudget } from "./config.js";
import type { ResponseFormat } from "./formatters.js";
import { MemoryBank, ALLOWED_FILES } from "./memory-bank.js";
import { ObservationMasker } from "./observation-masker.js";
import { createSandboxAPI, executeInSandbox, API_SPEC } from "./sandbox.js";
import { SandboxWorkerPool } from "./worker-pool.js";
import * as taskRegistry from "./task-registry.js";
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
  const buf = Buffer.from(text, "utf8").subarray(0, limit);
  const truncated = buf.toString("utf8");
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

const SERVER_INSTRUCTIONS = `
OpenGrok MCP — Code intelligence for large, multi-language codebases.

## SESSION STARTUP (do this once, in order)
1. opengrok_memory_status → check for prior investigation state (1 call)
2. opengrok_read_memory("active-task.md") → if populated, read it (restores last task)
3. opengrok_read_memory("investigation-log.md") → if populated, read recent entries
4. opengrok_index_health → verify connectivity

Note: For general codebase context (conventions, architecture, AI rules), use VS Code's
built-in memory tool (/memory command in chat) — it auto-loads at every session.

## TOOL SELECTION — DECISION TREE
Single symbol lookup         → opengrok_get_symbol_context (1 call, replaces 3–5)
2–5 parallel searches        → opengrok_batch_search (1 call)
Search + read code           → opengrok_search_and_read (1 call)
Multi-step (3+ calls needed) → opengrok_execute (1 call, logic runs in sandbox)
Single search                → opengrok_search_code

NEVER: search_code + get_file_content → use search_and_read
NEVER: multiple search_code calls → use batch_search
NEVER: get_file_content on file > 50 lines without start_line + end_line

## LEGACY TOOL RULES
- ALWAYS call get_file_symbols before get_file_content to find line ranges cheaply
- ALWAYS pass file_type to narrow results (cxx, java, python, etc.)
- LIMIT max_results to 5 unless asked for more

## CODE MODE — opengrok_execute
- Call opengrok_api ONCE at session start for the API spec
- All env.opengrok.* calls are synchronous from your code's perspective
- Use env.opengrok.batchSearch([...]) for parallel searches — do NOT write Promise.all()
- Filter data inside the sandbox — only return what is needed

## MEMORY — MANDATORY BEFORE FINAL ANSWER
You MUST do both of these before responding to the user:
  1. opengrok_update_memory("active-task.md", <current state>, "overwrite")
  2. If a significant finding: opengrok_update_memory("investigation-log.md", <summary>, "append")

Memory files: active-task.md (current task) | investigation-log.md (findings log)
`.trim();

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
    const candidate = path.join(root, normalized);
    let resolved: string;
    try {
      resolved = await fsp.realpath(candidate);
    } catch {
      continue;
    }

    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
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
 * Applies capResponse to protect LLM context windows. structuredContent is
 * always returned for programmatic consumers regardless of response_format.
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
    structuredContent: structured,
  };
}

// ---------------------------------------------------------------------------
// Apply default project helper
// ---------------------------------------------------------------------------

function applyDefaultProject(
  projects: string[] | undefined,
  config: Config
): string[] | undefined {
  if (projects && projects.length > 0) return projects;
  const defaultProject = config.OPENGROK_DEFAULT_PROJECT?.trim();
  return defaultProject ? [defaultProject] : projects;
}

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
  const text = fmt === "tsv" ? formatSearchResultsTSV(results) : formatSearchResults(results);
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
  const seen = new Set<string>();
  return results.map((queryResult) => ({
    ...queryResult,
    results: {
      ...queryResult.results,
      results: queryResult.results.results
        .map((hit) => ({
          ...hit,
          matches: hit.matches.filter((match) => {
            const key = `${hit.path}:${match.lineNumber}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        }))
        .filter((hit) => hit.matches.length > 0),
    },
  }));
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
    fmt === "tsv"
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
    3,
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
      const headerResults = await client.search(
        args.symbol,
        "defs",
        effectiveProjects,
        5,
        0,
        args.file_type
      );
      const headerMatch = headerResults.results.find((r) =>
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
      return fmt === "tsv" ? formatSearchResultsTSV(results) : formatSearchResults(results);
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
      
      // Construct the result object
      const health = {
        connected: ok,
        latencyMs,
        indexedProjects,
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
  memoryBank?: MemoryBank
): McpServer {
  const codeMode = config.OPENGROK_CODE_MODE;

  const server = new McpServer(
    { name: "opengrok-mcp", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  const local = buildLocalLayer(config);

  // Initialize per-tool rate limiter
  const perToolLimits = parsePerToolLimits(config.OPENGROK_PER_TOOL_RATELIMIT);
  const toolRateLimiter = new ToolRateLimiter(perToolLimits);

  // Always register legacy tools — useful for simple lookups
  registerLegacyTools(server, client, config, local, codeMode, memoryBank, toolRateLimiter);

  // Also register Code Mode tools when enabled — LLM chooses best approach
  if (codeMode && memoryBank) {
    registerCodeModeTools(server, client, config, memoryBank, local, toolRateLimiter);
  }

  // Task 4.5: Register memory files as MCP Resources
  if (memoryBank) {
    registerMemoryResources(server, memoryBank);
  }

  // Task 4.6: Register MCP Prompts
  registerInvestigationPrompts(server);

  return server;
}

// ---------------------------------------------------------------------------
// Shared memory bank tool registrations (used by both Code Mode and legacy)
// ---------------------------------------------------------------------------

function registerMemoryTools(
  server: McpServer,
  memoryBank: MemoryBank
): void {
  server.registerTool(
    "opengrok_memory_status",
    {
      title: "Memory Bank Status",
      description:
        "Returns status of all OpenGrok memory files. Call once at session start " +
        "to check whether there is prior investigation state to restore.",
      inputSchema: { _: z.string().optional().describe("(no input required)") },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true, destructiveHint: false },
    },
    async () => {
      auditLog({ type: "tool_invoke", tool: "opengrok_memory_status" });
      try {
        const lines: string[] = ["# OpenGrok Memory Status"];
        for (const filename of ALLOWED_FILES) {
          const content = await memoryBank.read(filename);
          if (!content) {
            lines.push(`- ${filename}: empty`);
          } else {
            const bytes = Buffer.byteLength(content, "utf8");
            const firstLine = content.split("\n").find(l => l.trim().length > 0) ?? "";
            const preview = firstLine.trim().slice(0, 60);
            lines.push(`- ${filename}: ${bytes}B — "${preview}"`);
          }
        }
        lines.push("");
        lines.push("Note: For general codebase context (conventions, architecture), use VS Code's");
        lines.push("built-in memory tool (/memory command) — it auto-loads at every session.");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return makeToolError("opengrok_memory_status", err);
      }
    }
  );

  server.registerTool(
    "opengrok_read_memory",
    {
      title: "Read Memory Bank",
      description:
        "Read a Living Document file. Call at session start to restore context. " +
        "Files: active-task.md (current task state), investigation-log.md (findings history)",
      inputSchema: {
        filename: z.enum(["active-task.md", "investigation-log.md"]
        ).describe("File to read from the memory bank"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_read_memory" });
      try {
        const content = await memoryBank.read(args.filename);
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
      description:
        "Write findings to a Living Document file. Use mode=append for investigation-log.md. " +
        "MANDATORY: Update active-task.md before every final answer.",
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

let executeCallCount = 0;

const workerPool = new SandboxWorkerPool();

function registerCodeModeTools(
  server: McpServer,
  client: OpenGrokClient,
  config: Config,
  memoryBank: MemoryBank,
  local: LocalLayer,
  toolRateLimiter: ToolRateLimiter
): void {
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
      description:
        "Get the full API specification for Code Mode. " +
        "Call this ONCE at session start before writing any opengrok_execute code.",
      inputSchema: { _ : z.string().optional().describe("(no input required)") },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true, destructiveHint: false },
    },
    async () => {
      auditLog({ type: "tool_invoke", tool: "opengrok_api" });
      try {
        const specText = yaml.dump(API_SPEC, { lineWidth: 120, noRefs: true });
        return { content: [{ type: "text", text: capResponse(specText) }] };
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
      description:
        "Execute JavaScript code in a secure sandbox with access to the env.opengrok API object. " +
        "All API calls are synchronous from your code's perspective. " +
        "Return values via 'return' (not 'export default'). Use env.opengrok.* for API calls.",
      inputSchema: {
        code: z.string().min(1).describe(
          "JavaScript code to execute. Must be able to run as a function body. " +
          "Use the opengrok object to access the API. Return a value."
        ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false, destructiveHint: false },
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_execute" });
      if (toolRateLimiter) await toolRateLimiter.acquire("opengrok_execute");
      const currentTurn = ++turn;
      try {
        const budget = BUDGET_LIMITS[getActiveBudget()];
        const sandboxApi = createSandboxAPI(client, memoryBank, getCompileInfoFn);
        const workerHandle = await workerPool.acquire();
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
          ], { maxTokens: 256, systemPrompt: "You are a helpful code debugger. Be concise." });
          if (suggestion) {
            return { content: [{ type: "text", text: `${result}\n\nSuggestion: ${suggestion}` }] };
          }
          return { content: [{ type: "text", text: result }] };
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

  // Tool 3: opengrok_get_task_result — poll for task completion (Task 4.16)
  server.registerTool(
    "opengrok_get_task_result",
    {
      title: "Get Task Result",
      description:
        "Poll for the result of a long-running opengrok_execute task. " +
        "Returns the task status (running/completed/error) and result if available.",
      inputSchema: {
        taskId: z.string().describe("Task ID returned by a previous opengrok_execute call"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const task = taskRegistry.getTask(args.taskId);
        if (!task) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "Task not found or expired", taskId: args.taskId }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                taskId: args.taskId,
                status: task.status,
                result: task.result,
                error: task.error,
                createdAt: task.createdAt,
                completedAt: task.completedAt,
              }),
            },
          ],
        };
      } catch (err) {
        return makeToolError("opengrok_get_task_result", err);
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
  codeMode: boolean,
  memoryBank?: MemoryBank,
  toolRateLimiter?: ToolRateLimiter
): void {
  const desc = (full: string, compact: string): string => codeMode ? compact : full;
  server.registerTool(
    "opengrok_search_code",
    {
      title: "Search Code",
      description: desc(
        "Search OpenGrok. Types: full (text), defs (definitions), refs (references), path (filenames), hist (commit messages). Prefer defs/refs for known symbol names. Use opengrok_batch_search for multiple queries.",
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
              server.server,
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
      description: desc("Find files by name/path pattern across the codebase.", "(fallback) find file by name pattern"),
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
        const text = fmt === "tsv" ? formatSearchResultsTSV(results) : formatSearchResults(results);
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
        "Search the codebase using a regular expression pattern. More powerful than keyword search for matching code patterns.",
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
        const text = fmt === "tsv" ? formatSearchResultsTSV(results) : formatSearchResults(results);
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
        "Get file contents. ALWAYS pass start_line/end_line — never fetch full files. Use opengrok_search_code first to find line numbers. For full symbol context use opengrok_get_symbol_context.",
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
      description: desc("Commit history for a file.", "(fallback) file commit history"),
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
            { type: "resource_link" as const, uri: `opengrok://file/${args.project}${args.path}`, name: args.path, mimeType: getMimeType(args.path) },
          ],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return makeToolError("opengrok_get_file_history", err);
      }
    }
  );

  server.registerTool(
    "opengrok_browse_directory",
    {
      title: "Browse Directory",
      description: desc("List files/subdirectories at a path.", "(fallback) list directory contents"),
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
      description: desc("List indexed OpenGrok projects.", "(fallback) list all indexed projects"),
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
        "Blame annotations (who changed each line). Use start_line/end_line to limit output.",
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
      description: desc("Autocomplete suggestions for a partial query.", "(fallback) search autocomplete suggestions"),
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
        "Execute up to 5 searches in parallel in one call.\n\n" +
        "**When to use**: Always prefer this over multiple opengrok_search_code calls for the same investigation.\n\n" +
        "**Args**: `queries` array (each with `query`, `search_type`, `max_results`); `projects` and `file_type` apply to all queries.\n\n" +
        "**Example**: Find definition, references, and usage patterns of a symbol in one call.",
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
        "Search and return matching code with surrounding context in one call.\n\n" +
        "**When to use**: Instead of opengrok_search_code + opengrok_get_file_content. Never fetches full files.\n\n" +
        "**When not to use**: When you need the full file or deep symbol analysis — use opengrok_get_symbol_context instead.",
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
        "Complete symbol investigation in one call: definition with context + corresponding header + references.\n\n" +
        "**When to use**: First choice for any unknown C++ symbol or function. Replaces search_code + get_file_content combination.\n\n" +
        "**When not to use**: For simple file reads or when you already have the exact line number.\n\n" +
        "**Args**: `symbol` (required); `projects`, `context_lines`, `max_refs`, `include_header`, `file_type` (optional).\n\n" +
        "**Example**: Use for any CamelCase/PascalCase identifier to get definition + header + callers in one call.",
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
        "OpenGrok server connection status and diagnostics. Call if results seem stale or incomplete.",
        "(fallback) server connectivity and index status"
      ),
      inputSchema: IndexHealthArgs.shape,
      outputSchema: {
        connected: z.boolean().describe("Whether the OpenGrok server is reachable"),
        latencyMs: z.number().optional().describe("Round-trip latency in milliseconds (present when connected)"),
        message: z.string().describe("Human-readable status message"),
      },
      annotations: READ_ONLY_OPEN,
    },
    async () => {
      auditLog({ type: "tool_invoke", tool: "opengrok_index_health" });
      try {
        const start = Date.now();
        const ok = await client.testConnection();
        const latencyMs = Date.now() - start;
        const message = ok
          ? `OpenGrok: connected (${latencyMs}ms latency)`
          : "OpenGrok: connection failed";
        const structuredContent = ok
          ? { connected: true, latencyMs, message }
          : { connected: false, message };
        return {
          content: [{ type: "text", text: message }],
          structuredContent,
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
        "Get compilation details for a source file: compiler, include paths, preprocessor defines, and language standard.\n\n" +
        "**When to use**: When you need compiler flags or include paths for precise analysis of C/C++ files.\n\n" +
        "**When not to use**: For non-C/C++ files or when compile_commands.json is not present.\n\n" +
        "**Args**: `path` — absolute or OpenGrok-relative path (e.g., GridNode/EventLoop.cpp).\n\n" +
        "**Example**: Use before asking about preprocessor macros or platform-specific includes.",
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
        "List all symbols defined in a file: functions, classes, structs, macros with line numbers and signatures.\n\n" +
        "**When to use**: To understand a file's structure before reading it with opengrok_get_file_content.\n\n" +
        "**When not to use**: When you already know exactly which lines to read.\n\n" +
        "**Args**: `project` and `path` (required).\n\n" +
        "**Example**: Use before opengrok_get_file_content to identify which function/class starts at which line.",
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
            { type: "resource_link" as const, uri: `opengrok://file/${args.project}${args.path}`, name: args.path, mimeType: getMimeType(args.path) },
          ],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return makeToolError("opengrok_get_file_symbols", err);
      }
    }
  );

  server.registerTool(
    "opengrok_what_changed",
    {
      title: "What Changed",
      description: desc(
        "Show which lines changed recently in a file, grouped by commit. Combines file history + blame in one call.\n\n" +
        "**When to use**: To understand what recently changed in a file and who changed it.\n\n" +
        "**Args**: `project`, `path` (required), `since_days` (1–90, default 7).\n\n" +
        "**Example**: Use to audit recent changes to a critical source file before code review.",
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
          if (!byRevision.has(line.revision)) {
            byRevision.set(line.revision, { author: line.author, date: line.date, lines: [] });
          }
          byRevision.get(line.revision)!.lines.push(line.lineNumber);
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
        "Get git blame/annotation for a file — shows who changed each line and when. Optionally filter to a line range.\n\n" +
        "**When to use**: To understand ownership of specific lines, track down when a bug was introduced, or audit authorship.\n\n" +
        "**Args**: `project`, `path` (required); `line_start`, `line_end` (optional line range); `include_diff` (default false).\n\n" +
        "**Example**: Use on a function body to see who last touched each line.",
        "(fallback) git blame annotation"
      ),
      inputSchema: BlameArgs.shape,
      annotations: READ_ONLY_OPEN,
    },
    async (args) => {
      auditLog({ type: "tool_invoke", tool: "opengrok_blame" });
      try {
        const parsed = BlameArgs.parse(args);
        const annotations = await client.getAnnotate(parsed.project, parsed.path);
        const text = formatBlame(annotations, parsed.line_start, parsed.line_end, parsed.include_diff);
        return { content: [{ type: "text", text: capResponse(text) }] };
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
        "**When to use**: To understand a file's dependencies or find all callers/includers across a project.\n\n" +
        "**Args**: `project`, `path` (required); `depth` (1–3, default 2); `direction` (uses|used_by|both, default both).\n\n" +
        "**Example**: Use on a header file to find all translation units that include it.",
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
    registerMemoryTools(server, memoryBank);
  }
  // registerLegacyTools intentionally returns void — server is mutated in place
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
      const scope = project ? ` in project \`${project}\`` : "";
      return {
        description: `Investigate symbol \`${symbol}\`${scope}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Investigate the symbol \`${symbol}\`${scope} using the OpenGrok MCP server.`,
                "",
                "Follow these steps in order:",
                `1. **Definition** — use \`opengrok_search_code\` with type \`defs\` to find where \`${symbol}\` is defined.`,
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
      const scope = project ? ` in project \`${project}\`` : "";
      return {
        description: `Find feature: ${feature}${scope}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Find where the feature "${feature}" is implemented${scope}.`,
                "",
                "Approach:",
                `1. **Full-text search** — use \`opengrok_search_code\` with type \`full\` for keywords related to "${feature}".`,
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
    ({ path: filePath, project }) => ({
      description: `Review file: ${filePath}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Perform a code review of \`${filePath}\` in project \`${project}\`.`,
              "",
              "Steps:",
              `1. **Read file** — use \`opengrok_get_file_content\` for project \`${project}\`, path \`${filePath}\`.`,
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
    })
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
   * Returns immediately if a token is available, otherwise waits.
   */
  async acquire(toolName: string): Promise<void> {
    return new Promise((resolve) => {
      const checkToken = (): void => {
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
          const waitMs = Math.max(10, (1 - bucket.tokens) * interval);
          setTimeout(checkToken, waitMs);
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
  process.on("SIGHUP", async () => {
    try {
      auditLog({ type: "config_load", detail: "SIGHUP: config reload initiated" });
      logger.info("Received SIGHUP, reloading config...");
      
      // Re-read config from environment
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

  return setInterval(async () => {
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
  }, 5 * 60 * 1000);
}

/* v8 ignore start -- runServer connects to stdio transport; integration-level */
export async function runServer(
  client: OpenGrokClient,
  config: Config,
  memoryBank?: MemoryBank
): Promise<void> {
  const server = createServer(client, config, memoryBank);
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
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
  startHealthCheckPolling(server, client);
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
 * Validate that the request originates from an allowed client (if configured).
 * Task 4.13: Request Origin Validation
 * If OPENGROK_ALLOWED_CLIENT_IDS is set, throws if clientId is not in the list.
 * @unused - Reserved for future middleware integration in SDK versions with client context support
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function validateOrigin(clientId: string | undefined, config: Config): void {
  const allowed = parseAllowedClientIds(config.OPENGROK_ALLOWED_CLIENT_IDS);
  if (!allowed || allowed.length === 0) return; // no restriction
  if (!clientId || !allowed.includes(clientId)) {
    auditLog({ type: "auth_used", detail: `unauthorized client: ${clientId || "unknown"}` });
    throw new Error("Unauthorized client");
  }
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
 * Build a dependency graph for a file by searching refs up to `depth` levels.
 * "uses"    — finds files that reference/call symbols from this file (refs search).
 *             Note: true include-graph traversal requires content parsing; this is a
 *             best-effort approximation using OpenGrok's refs index.
 * "used_by" — same semantics; both directions use refs search on the filename.
 */
async function buildDependencyGraph(
  client: OpenGrokClient,
  project: string,
  filePath: string,
  depth: number,
  direction: "uses" | "used_by" | "both"
): Promise<DependencyNode[]> {
  const nodes: DependencyNode[] = [];

  // Track which filenames have been expanded per direction to avoid cycles
  const expandedUses = new Set<string>();
  const expandedUsedBy = new Set<string>();
  // Track full paths already added to nodes to prevent diamond-dependency duplicates
  const seenUsesPaths = new Set<string>();
  const seenUsedByPaths = new Set<string>();

  // Queue: [filename, level]
  const usesQueue: [string, number][] = [];
  const usedByQueue: [string, number][] = [];

  const rootName = filePath.split("/").pop()!;

  if (direction === "uses" || direction === "both") {
    usesQueue.push([rootName, 1]);
  }
  if (direction === "used_by" || direction === "both") {
    usedByQueue.push([rootName, 1]);
  }

  while (usesQueue.length > 0) {
    const [filename, level] = usesQueue.shift()!;
    if (level > depth) continue;
    if (expandedUses.has(filename)) continue;
    expandedUses.add(filename);

    const results = await client.search(filename, "refs", [project], 20);
    for (const r of results.results) {
      if (r.path === filePath) continue; // skip exact self
      const rName = r.path.split("/").pop()!;
      if (!seenUsesPaths.has(r.path)) {
        seenUsesPaths.add(r.path);
        nodes.push({ path: r.path, level, direction: "uses" });
      }
      if (level < depth) {
        usesQueue.push([rName, level + 1]);
      }
    }
  }

  while (usedByQueue.length > 0) {
    const [filename, level] = usedByQueue.shift()!;
    if (level > depth) continue;
    if (expandedUsedBy.has(filename)) continue;
    expandedUsedBy.add(filename);

    const results = await client.search(filename, "refs", [project], 20);
    for (const r of results.results) {
      if (r.path === filePath) continue; // skip exact self
      const rName = r.path.split("/").pop()!;
      if (!seenUsedByPaths.has(r.path)) {
        seenUsedByPaths.add(r.path);
        nodes.push({ path: r.path, level, direction: "used_by" });
      }
      if (level < depth) {
        usedByQueue.push([rName, level + 1]);
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
