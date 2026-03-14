/**
 * OpenGrok MCP Server — tool definitions and handlers.
 * v3.0: compact output, response size cap, compound tools, MCP instructions.
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import type { OpenGrokClient } from "./client.js";
import { extractLineRange } from "./client.js";
import type { Config } from "./config.js";
import {
  formatAnnotate,
  formatBatchSearchResults,
  formatCompileInfo,
  formatDirectoryListing,
  formatFileContent,
  formatFileHistory,
  formatFileSymbols,
  formatProjectsList,
  formatSearchAndRead,
  formatSearchResults,
  formatSymbolContext,
} from "./formatters.js";
import type {
  SearchAndReadEntry,
  SymbolContextResult,
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
  SearchSuggestArgs,
  FindFileArgs,
} from "./models.js";
import type { FileContent } from "./models.js";
import { TOOL_DEFINITIONS } from "./tool-schemas.js";

import { logger } from "./logger.js";

// Hard cap on response payload sent to the LLM (in bytes).
// Override with OPENGROK_MAX_RESPONSE_BYTES env var.
const MAX_RESPONSE_BYTES = parseInt(
  process.env.OPENGROK_MAX_RESPONSE_BYTES ?? "16384",
  10
);

// Cap for the search_and_read compound tool (in bytes).
// Override with OPENGROK_SEARCH_AND_READ_CAP env var.
const SEARCH_AND_READ_CAP = parseInt(
  process.env.OPENGROK_SEARCH_AND_READ_CAP ?? "8192",
  10
);

function capResponse(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_RESPONSE_BYTES) return text;
  // Truncate at the last newline within the budget
  const buf = Buffer.from(text, "utf8").subarray(0, MAX_RESPONSE_BYTES);
  const truncated = buf.toString("utf8");
  const lastNl = truncated.lastIndexOf("\n");
  const safeText = lastNl > 0 ? truncated.slice(0, lastNl) : truncated;
  return (
    safeText +
    `\n[Response truncated at ${Math.round(MAX_RESPONSE_BYTES / 1024)} KB. Narrow your query or use line ranges.]`
  );
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

declare const __VERSION__: string;

/* v8 ignore start -- compile-time constant injected by esbuild */
const VERSION = (typeof __VERSION__ !== "undefined"
  ? __VERSION__
  : (process.env.npm_package_version ?? "3.0.0"));
/* v8 ignore stop */

// Instructions injected as system-level guidance for the LLM.
const SERVER_INSTRUCTIONS = `
OpenGrok MCP server. Rules to maximise efficiency:
- Use the configured default project unless the user specifies a different one.
- Use get_symbol_context instead of separate search_code + get_file_content for symbol investigations.
- Use search_and_read instead of search_code followed by get_file_content.
- Use batch_search instead of multiple sequential search_code calls.
- Always pass start_line and end_line to get_file_content. Never fetch full files.
- For known symbol names (CamelCase, PascalCase), prefer search_type=defs or refs over full.
- Use search_type=hist to search commit messages and changelogs.
- Use file_type to narrow results by language: cxx (C++), c, java, python, javascript, typescript, csharp, golang, ruby, etc.
- Use get_compile_info to get compiler flags and include paths for a source file (local layer must be enabled).
- Use get_file_symbols to understand a file's structure (functions, classes, macros) before reading it with get_file_content.
- batch_search: pass queries as top-level "queries" array, file_type is top-level not per-query.
- list_projects: filter is a substring match (e.g. "release" matches all release-* projects).
`.trim();

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

  // Load all compile_commands.json files once (shared by inferBuildRoot + parseCompileCommands)
  const loaded = loadCompileCommandsJson(dbPaths);

  // Infer the build/source root from the `directory` fields in the compile databases.
  const inferredRoot = inferBuildRoot(dbPaths, loaded);

  let resolvedInferredRoot: string | undefined;
  if (inferredRoot) {
    try {
      resolvedInferredRoot = fs.realpathSync(inferredRoot);
    } catch {
      logger.warn(`Local layer: inferred build root not found locally: ${inferredRoot}`);
    }
  }

  // Allowed roots for path boundary checks during parsing:
  // - the inferred build root (where compiled source files actually live on disk)
  // - parent directories of the compile_commands.json files themselves
  const allowedRoots: string[] = resolvedInferredRoot ? [resolvedInferredRoot] : [];
  for (const r of resolveAllowedRoots(dbPaths)) {
    if (!allowedRoots.includes(r)) allowedRoots.push(r);
  }

  if (!allowedRoots.length) {
    logger.warn("Local layer: no valid allowed roots — local layer disabled");
    return { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() };
  }

  const index = parseCompileCommands(dbPaths, allowedRoots, loaded);

  // Build suffix index for O(1) resolveFileFromIndex lookups
  const suffixIndex = new Map<string, string>();
  for (const key of index.keys()) {
    const normalized = key.replace(/\\/g, "/");
    const parts = normalized.split("/");
    // Store suffixes of depth 1..4 for quick matching
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

/**
 * Attempt to read a file from the local filesystem.
 * The OpenGrok-relative `filePath` (e.g. "GridNode/EventLoop.cpp") is joined
 * against each configured source root. The resolved path is validated with
 * fs.realpathSync to prevent path traversal and symlink escapes.
 * Returns null on any failure so the caller can fall back to the API.
 */
async function tryLocalRead(
  filePath: string,
  roots: string[],
  startLine?: number,
  endLine?: number
): Promise<FileContent | null> {
  // Strip leading slashes and reject traversal sequences
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
      continue; // Does not exist in this root
    }

    // Boundary check — must remain within this root
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
      continue; // Unreadable — try next root
      /* v8 ignore stop */
    }
  }

  return null;
}

/**
 * Look up the authoritative on-disk path for a file using the compile index.
 * The OpenGrok-relative path (e.g. "/pandora/source/.../foo.cpp") is matched
 * by suffix against compile index keys (e.g. "/build/.../pandora/source/.../foo.cpp").
 * Returns the absolute path or null.
 */
function resolveFileFromIndex(
  opengrokPath: string,
  index: Map<string, CompileInfo>,
  suffixIndex: Map<string, string>
): string | null {
  if (!index.size) return null;
  // Direct key hit (caller already has an absolute path)
  if (index.has(opengrokPath)) return opengrokPath;
  const normalizedRequest = opengrokPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const suffix = "/" + normalizedRequest;
  // O(1) suffix index lookup
  const hit = suffixIndex.get(suffix);
  if (hit) return hit;
  // Fallback to linear scan for paths not in suffix index
  for (const key of index.keys()) {
    if (key.replace(/\\/g, "/").endsWith(suffix)) return key;
  }
  return null;
}

/**
 * Read a file from an absolute on-disk path with optional line range.
 * Returns null on any I/O failure so the caller can fall back to the API.
 */
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

export function createServer(
  client: OpenGrokClient,
  config: Config
): Server {
  const server = new Server(
    { name: "opengrok-mcp", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  // Build the local layer once at startup (compile_commands.json index)
  const local = buildLocalLayer(config);

  /* v8 ignore start -- MCP SDK framework callbacks; logic tested via _dispatchTool */
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      const raw = await dispatchTool(name, args, client, config, local);
      const text = capResponse(raw);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      logger.error(`Tool "${name}" failed:`, err);

      let userMessage: string;
      if (err instanceof ZodError) {
        const issues = err.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        userMessage = `**Invalid arguments:** ${issues}`;
      } else if (err instanceof Error) {
        userMessage = `**Error:** ${sanitizeErrorMessage(err.message)}`;
      } else {
        userMessage = "**Error:** An unexpected error occurred. Check server logs.";
      }

      return { content: [{ type: "text", text: userMessage }] };
    }
  });
  /* v8 ignore stop */

  return server;
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

/**
 * Apply the default project from config when no projects are specified.
 * Returns the original array if non-empty, or [defaultProject] if configured.
 */
function applyDefaultProject(
  projects: string[] | undefined,
  config: Config
): string[] | undefined {
  if (projects && projects.length > 0) return projects;
  const defaultProject = config.OPENGROK_DEFAULT_PROJECT?.trim();
  return defaultProject ? [defaultProject] : projects;
}

// ---------------------------------------------------------------------------
// Extracted handlers (long compound-tool logic)
// ---------------------------------------------------------------------------

async function handleSearchAndRead(
  rawArgs: Record<string, unknown>,
  client: OpenGrokClient,
  config: Config,
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

      if (totalOutputBytes >= SEARCH_AND_READ_CAP) break;
    } catch {
      // Skip files that can't be read; don't abort the whole operation
    }
  }

  return formatSearchAndRead(
    args.query,
    searchResults.totalCount,
    entries
  );
}

async function handleGetSymbolContext(
  rawArgs: Record<string, unknown>,
  client: OpenGrokClient,
  config: Config,
): Promise<string> {
  const args = GetSymbolContextArgs.parse(rawArgs);
  const effectiveProjects = applyDefaultProject(args.projects, config);

  // Step 1: find definition
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
    return formatSymbolContext(result);
  }

  const defResult = defResults.results[0];
  const defMatch = defResult.matches[0];
  const defStartLine = Math.max(1, defMatch.lineNumber - args.context_lines);
  const defEndLine = defMatch.lineNumber + args.context_lines;
  const defLang = defResult.path.includes(".")
    ? (/* v8 ignore next */ defResult.path.split(".").pop()?.toLowerCase() ?? "")
    : "";

  // Step 2: fetch definition context
  const defContent = await client.getFileContent(
    defResult.project,
    defResult.path,
    defStartLine,
    defEndLine
  );

  // Step 2.5: fetch file symbol map for the definition file
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

  // Step 3: try to find corresponding header (if definition is in .cpp)
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
        /* v8 ignore start -- header extension detection; test data uses extensionless paths */
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

  // Step 4: find references
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

  // Infer kind from extension / context
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

  return formatSymbolContext(symbolResult);
}

async function handleGetCompileInfo(
  rawArgs: Record<string, unknown>,
  config: Config,
  local: LocalLayer,
): Promise<string> {
  const args = GetCompileInfoArgs.parse(rawArgs);

  if (!local.enabled) {
    return (
      "Local layer is not enabled. " +
      "Open a workspace containing compile_commands.json files to enable it automatically."
    );
  }

  if (!local.index.size) {
    return "Local layer is enabled but no compile entries were loaded. " +
      "No compile_commands.json files found under the build root — build the project first.";
  }

  const requestedPath = args.path;
  let info: CompileInfo | undefined;

  // 1. Absolute path — direct index lookup
  if (path.isAbsolute(requestedPath)) {
    try {
      const resolved = await fsp.realpath(requestedPath);
      info = local.index.get(resolved);
    } catch {
      // Path doesn't exist — fall through to other strategies
    }
  }

  // 2. Relative path — try joining against each root
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

  // 3. Basename match — last resort for short names like "EventLoop.cpp"
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

async function dispatchTool(
  name: string,
  rawArgs: Record<string, unknown>,
  client: OpenGrokClient,
  config: Config,
  local: LocalLayer
): Promise<string> {
  switch (name) {
    // ----------------------------------------------------------------
    // Core tools
    // ----------------------------------------------------------------
    case "search_code": {
      const args = SearchCodeArgs.parse(rawArgs);
      const results = await client.search(
        args.query,
        args.search_type,
        applyDefaultProject(args.projects, config),
        args.max_results,
        args.start_index,
        args.file_type
      );
      return formatSearchResults(results);
    }

    case "find_file": {
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

    case "get_file_content": {
      const args = GetFileContentArgs.parse(rawArgs);

      // Step 2-D: Try local filesystem first when local layer is enabled.
      // Priority 1: suffix-match the OpenGrok path against compile index keys.
      // This directly uses the authoritative absolute path from compile_commands.json
        // without needing to infer roots.
      if (local.enabled && local.index.size > 0) {
        const absPath = resolveFileFromIndex(args.path, local.index, local.suffixIndex);
        /* v8 ignore start */
        if (absPath) {
        /* v8 ignore stop */
          const localContent = await readFileAtAbsPath(absPath, args.start_line, args.end_line);
          if (localContent) return formatFileContent(localContent);
        }
      }

      // Priority 2: path-join against roots (catches header files not in compile index).
      if (local.enabled && local.roots.length > 0) {
        const localContent = await tryLocalRead(
          args.path,
          local.roots,
          args.start_line,
          args.end_line
        );
        if (localContent) {
          return formatFileContent(localContent);
        }
      }

      const content = await client.getFileContent(
        args.project,
        args.path,
        args.start_line,
        args.end_line
      );
      return formatFileContent(content);
    }

    case "get_file_history": {
      const args = GetFileHistoryArgs.parse(rawArgs);
      const history = await client.getFileHistory(
        args.project,
        args.path,
        args.max_entries
      );
      return formatFileHistory(history);
    }

    case "browse_directory": {
      const args = BrowseDirectoryArgs.parse(rawArgs);
      const entries = await client.browseDirectory(args.project, args.path);
      return formatDirectoryListing(
        entries,
        args.project,
        args.path,
      );
    }

    case "list_projects": {
      const args = ListProjectsArgs.parse(rawArgs);
      const projects = await client.listProjects(args.filter);
      return formatProjectsList(projects);
    }

    case "get_file_annotate": {
      const args = GetFileAnnotateArgs.parse(rawArgs);
      const annotated = await client.getAnnotate(args.project, args.path);
      return formatAnnotate(
        annotated,
        args.start_line,
        args.end_line
      );
    }

    case "search_suggest": {
      const args = SearchSuggestArgs.parse(rawArgs);
      const result = await client.suggest(
        args.query,
        args.project,
        args.field
      );
      if (result.suggestions.length) {
        return "Suggestions:\n" + result.suggestions.map((s) => `  ${s}`).join("\n");
      }
      if (result.time === 0) {
        return "No suggestions found. The suggester index appears to be empty — an OpenGrok admin may need to rebuild it.";
      }
      return "No suggestions found.";
    }

    // ----------------------------------------------------------------
    // Compound tools
    // ----------------------------------------------------------------
    case "batch_search": {
      const args = BatchSearchArgs.parse(rawArgs);
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
      return formatBatchSearchResults(queryResults);
    }

    case "search_and_read":
      return handleSearchAndRead(rawArgs, client, config);

    case "get_symbol_context":
      return handleGetSymbolContext(rawArgs, client, config);

    case "index_health": {
      IndexHealthArgs.parse(rawArgs);
      const start = Date.now();
      const ok = await client.testConnection();
      const latencyMs = Date.now() - start;
      return ok
        ? `OpenGrok: connected (${latencyMs}ms latency)`
        : "OpenGrok: connection failed";
    }

    case "get_compile_info":
      return handleGetCompileInfo(rawArgs, config, local);

    case "get_file_symbols": {
      const args = GetFileSymbolsArgs.parse(rawArgs);
      const result = await client.getFileSymbols(args.project, args.path);
      if (!result.symbols.length) {
        return `No symbols found for ${args.path} in project ${args.project}. The file may not be indexed or the OpenGrok instance does not support the /api/v1/file/defs endpoint.`;
      }
      return formatFileSymbols(result);
    }

    default:
      return `**Error:** Unknown tool: "${name}"`;
  }
}

// ---------------------------------------------------------------------------
// Run the server over stdio
// ---------------------------------------------------------------------------

/* v8 ignore start -- runServer connects to stdio transport; integration-level */
export async function runServer(
  client: OpenGrokClient,
  config: Config
): Promise<void> {
  const server = createServer(client, config);
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    await client.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info(`Starting server v${VERSION}, connected to: ${config.OPENGROK_BASE_URL}`);

  if (!config.OPENGROK_USERNAME) {
    logger.warn(
      "OPENGROK_USERNAME not configured. Set OPENGROK_USERNAME and OPENGROK_PASSWORD environment variables."
    );
  }

  await server.connect(transport);
}
/* v8 ignore stop */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeErrorMessage(message: string): string {
  let sanitized = message.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]");
  sanitized = sanitized.replace(/:[^:@\s]+@/g, ":***@");
  // Strip absolute filesystem paths that may leak internal infrastructure
  sanitized = sanitized.replace(/\/(?:home|tmp|var|usr|build|opt|mnt|srv)(?:\/\S+)/g, "[path]");
  sanitized = sanitized.replace(/[A-Z]:\\(?:Users|Windows|Program Files|build)(?:\\\S+)/gi, "[path]");
  return sanitized;
}

// Exported for testing only
export {
  capResponse as _capResponse,
  sanitizeErrorMessage as _sanitizeErrorMessage,
  resolveFileFromIndex as _resolveFileFromIndex,
  buildLocalLayer as _buildLocalLayer,
  tryLocalRead as _tryLocalRead,
  readFileAtAbsPath as _readFileAtAbsPath,
  applyDefaultProject as _applyDefaultProject,
  dispatchTool as _dispatchTool,
};
export type { LocalLayer as _LocalLayer };
