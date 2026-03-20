/**
 * Code Mode sandbox — worker_threads + QuickJS WASM execution.
 *
 * Architecture:
 * - LLM writes JavaScript code that runs inside a QuickJS WASM VM (in a Worker thread)
 * - The sandbox exposes an `env.opengrok` API object; all calls are synchronous
 *   from the LLM's perspective (the worker blocks via Atomics.wait while the main
 *   thread performs the async HTTP call)
 * - Intermediate results stay inside the QuickJS VM — only the final return value
 *   (captured via `export default`) crosses back to the LLM context window
 *
 * Buffer layout (pinned — must exactly match sandbox-worker.ts):
 *   Bytes 0–15:  Int32Array  statusArray  — [0]: 0=idle, 1=pending_call, 2=result_ready
 *   Bytes 16–19: Uint32Array lengthArray  — [0]: byte count of JSON payload
 *   Bytes 20+:   Uint8Array  dataArray    — JSON payload (max 1 MB)
 *   TOTAL: SHARED_BUFFER_SIZE = 20 + 1024 * 1024
 *
 * Critical design decisions:
 * - Worker spawned with __dirname path (CJS, not import.meta.url)
 * - stopped flag + safeResolve() prevents double-resolution
 * - handleWorkerCall() setImmediate poll loop; checks stopped first
 * - Overflow guard: encoded result > dataArray.length → write __error
 * - 10s hardTimeout terminates worker unconditionally (covers Atomics.wait stalls)
 * - capFn applied to final output (delegates truncation to caller)
 */

import * as fs from "fs";
import * as path from "path";
import { Worker } from "worker_threads";
import type { OpenGrokClient } from "./client.js";
import type { MemoryBank } from "./memory-bank.js";
import type { HealthAPIResult } from "./api-types.js";
import { buildFileOverview, buildCallChain } from "./intelligence.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Buffer layout constants (must match sandbox-worker.ts)
// ---------------------------------------------------------------------------

const SHARED_BUFFER_SIZE = 20 + 1024 * 1024;

// ---------------------------------------------------------------------------
// API_SPEC — the auto-generated documentation exposed by opengrok_api
// ---------------------------------------------------------------------------

/**
 * API specification object returned by the opengrok_api tool.
 * The LLM reads this once to understand the available methods, then calls
 * opengrok_execute with JavaScript code that uses them.
 *
 * IMPORTANT notes embedded in the spec:
 * - batchSearch returns an array of result sets (not a single result)
 * - callees direction always returns empty (not yet implemented)
 * - Promise.all does NOT parallelize inside sandbox — use batchSearch instead
 */
export const API_SPEC = {
  intro:
    "OpenGrok Code Mode API. Write JavaScript that uses the `env.opengrok` object below. " +
    "Return a value via `return` — it will be shown to the user. " +
    "ALL env.opengrok calls are synchronous from your perspective (the host bridges async for you).",

  important: [
    "Do NOT use Promise.all — calls are serialized. Use env.opengrok.batchSearch() for parallel searches.",
    "Prefer env.opengrok.getSymbolContext() over separate search+getFileContent.",
    "Prefer env.opengrok.batchSearch() over multiple env.opengrok.search() calls.",
    "Always pass project as a string, not an array.",
    "env.opengrok.traceCallChain() callees direction returns empty (requires AST, not yet supported).",
    "env.opengrok.readMemory() returns undefined for uninitialized files — handle gracefully.",
  ],

  methods: {
    search: {
      signature: "env.opengrok.search(query, opts?)",
      opts: "{ searchType?: 'full'|'defs'|'refs'|'path'|'hist', projects?: string[], maxResults?: number, startIndex?: number, fileType?: string }",
      returns: "SearchAPIResult: { query, searchType, totalCount, results: [{project,path,matches:[{lineNumber,lineContent}]}] }",
    },
    batchSearch: {
      signature: "env.opengrok.batchSearch(queries, opts?)",
      queries: "Array<{ query: string, searchType?: string, maxResults?: number }>",
      opts: "{ projects?: string[], fileType?: string }",
      returns:
        "SearchAPIResult[] — one result-set per query. " +
        "Access: const results = env.opengrok.batchSearch([...]); results[0].results[0].path",
    },
    getFileContent: {
      signature: "env.opengrok.getFileContent(project, path, opts?)",
      opts: "{ startLine?: number, endLine?: number }",
      returns: "FileContentAPIResult: { project, path, content, lineCount, sizeBytes, startLine }",
    },
    getSymbolContext: {
      signature: "env.opengrok.getSymbolContext(symbol, opts?)",
      opts: "{ projects?: string[], contextLines?: number, maxRefs?: number, includeHeader?: boolean, fileType?: string }",
      returns: "SymbolContextAPIResult: { found, symbol, kind, definition, header, references, fileSymbols }",
    },
    getFileSymbols: {
      signature: "env.opengrok.getFileSymbols(project, path)",
      returns: "SymbolsAPIResult: { project, path, symbols: [{symbol,type,signature,line,lineStart,lineEnd,namespace}] }",
    },
    getFileHistory: {
      signature: "env.opengrok.getFileHistory(project, path, opts?)",
      opts: "{ maxEntries?: number }",
      returns: "HistoryAPIResult: { project, path, entries: [{revision,date,author,message}] }",
    },
    getFileAnnotate: {
      signature: "env.opengrok.getFileAnnotate(project, path)",
      returns: "AnnotateAPIResult: { project, path, lines: [{lineNumber,revision,author,date,content}] }",
    },
    browseDir: {
      signature: "env.opengrok.browseDir(project, path?)",
      returns: "DirAPIResult: { project, path, entries: [{name,isDirectory,path,size}] }",
    },
    findFile: {
      signature: "env.opengrok.findFile(pattern, opts?)",
      opts: "{ projects?: string[], maxResults?: number }",
      returns: "SearchAPIResult (search_type=path)",
    },
    getFileOverview: {
      signature: "env.opengrok.getFileOverview(project, path)",
      returns:
        "FileOverviewAPIResult: { lang, sizeLines, sizeBytes, imports, topLevelSymbols, recentAuthors, lastRevision }",
      note: "Server-side intelligence: combines symbols + imports + history in one call.",
    },
    traceCallChain: {
      signature: "env.opengrok.traceCallChain(symbol, opts?)",
      opts: "{ direction?: 'callers'|'callees'|'both', depth?: number, project?: string }",
      returns:
        "CallChainAPIResult: { symbol, direction, callers: [{symbol,path,project,line,depth}], callees: [] }",
      note: "callers direction supported. callees always returns empty (requires AST, not yet implemented).",
    },
    searchSuggest: {
      signature: "env.opengrok.searchSuggest(query, opts?)",
      opts: "{ project?: string, field?: 'full'|'defs'|'refs'|'path' }",
      returns: "SuggestAPIResult: { query, field, suggestions: string[], time }",
    },
    getCompileInfo: {
      signature: "env.opengrok.getCompileInfo(path)",
      returns:
        "CompileInfoAPIResult | null: { file, compiler, standard, includes, defines, extraFlags }",
      note: "Returns null if local compile layer is not enabled.",
    },
    indexHealth: {
      signature: "env.opengrok.indexHealth()",
      returns: "HealthAPIResult: { connected, latencyMs, baseUrl }",
    },
    readMemory: {
      signature: "env.opengrok.readMemory(filename)",
      allowed:
        "'AGENTS.md' | 'codebase-map.md' | 'symbol-index.md' | 'known-patterns.md' | 'investigation-log.md' | 'active-context.md'",
      returns: "string | undefined — undefined means file is uninitialized stub",
    },
    writeMemory: {
      signature: "env.opengrok.writeMemory(filename, content, mode?)",
      mode: "'overwrite' | 'append' (default: 'overwrite')",
      note: "Always call writeMemory at session end to persist findings.",
    },
  },

  example: `
// Example: find all callers of a crash function and read the most relevant one
const refs = env.opengrok.search("handleCrash", { searchType: "refs", maxResults: 5 });
if (refs.results.length === 0) return "No references found";
const first = refs.results[0];
const content = env.opengrok.getFileContent(first.project, first.path, {
  startLine: Math.max(1, first.matches[0].lineNumber - 5),
  endLine: first.matches[0].lineNumber + 10
});
return { callerFile: first.path, code: content.content };
`.trim(),
};

// ---------------------------------------------------------------------------
// Sandbox API interface
// ---------------------------------------------------------------------------

export interface SandboxAPI {
  search(query: string, opts?: {
    searchType?: string;
    projects?: string[];
    maxResults?: number;
    startIndex?: number;
    fileType?: string;
  }): Promise<unknown>;

  batchSearch(queries: Array<{ query: string; searchType?: string; maxResults?: number }>, opts?: {
    projects?: string[];
    fileType?: string;
  }): Promise<unknown>;

  getFileContent(project: string, path: string, opts?: {
    startLine?: number;
    endLine?: number;
  }): Promise<unknown>;

  getSymbolContext(symbol: string, opts?: {
    projects?: string[];
    contextLines?: number;
    maxRefs?: number;
    includeHeader?: boolean;
    fileType?: string;
  }): Promise<unknown>;

  getFileSymbols(project: string, path: string): Promise<unknown>;
  getFileHistory(project: string, path: string, opts?: { maxEntries?: number }): Promise<unknown>;
  getFileAnnotate(project: string, path: string): Promise<unknown>;
  browseDir(project: string, path?: string): Promise<unknown>;
  findFile(pattern: string, opts?: { projects?: string[]; maxResults?: number }): Promise<unknown>;
  getFileOverview(project: string, path: string): Promise<unknown>;
  traceCallChain(symbol: string, opts?: {
    direction?: "callers" | "callees" | "both";
    depth?: number;
    project?: string;
  }): Promise<unknown>;
  searchSuggest(query: string, opts?: { project?: string; field?: string }): Promise<unknown>;
  getCompileInfo(path: string): Promise<unknown>;
  indexHealth(): Promise<unknown>;
  readMemory(filename: string): Promise<unknown>;
  writeMemory(filename: string, content: string, mode?: "overwrite" | "append"): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// createSandboxAPI — synchronous factory (no async)
// ---------------------------------------------------------------------------

/**
 * Create the host-side API object that bridges sandbox method calls to the real
 * OpenGrokClient. This function is synchronous — it returns immediately.
 * The actual async work happens when sandbox code triggers these methods via
 * the SharedArrayBuffer bridge from the worker thread.
 */
export function createSandboxAPI(
  client: OpenGrokClient,
  memoryBank: MemoryBank
): SandboxAPI {
  return {
    async search(query, opts = {}) {
      const { searchType = "full", projects, maxResults = 5, startIndex = 0, fileType } = opts;
      return client.search(query, searchType as any, projects, maxResults, startIndex, fileType);
    },

    async batchSearch(queries, opts = {}) {
      const { projects, fileType } = opts;
      return Promise.all(queries.map((q) =>
        client.search(q.query, (q.searchType ?? "full") as any, projects, q.maxResults ?? 5, 0, fileType)
      ));
    },

    async getFileContent(project, path, opts = {}) {
      return client.getFileContent(project, path, opts.startLine, opts.endLine);
    },

    async getSymbolContext(symbol, opts = {}) {
      const { projects, contextLines = 10, maxRefs = 5, includeHeader = true, fileType } = opts;
      const [defResults, refResults] = await Promise.all([
        client.search(symbol, "defs", projects, 3, 0, fileType),
        client.search(symbol, "refs", projects, maxRefs, 0, fileType),
      ]);

      if (!defResults.results.length || !defResults.results[0].matches.length) {
        return {
          found: false,
          symbol,
          kind: "unknown",
          references: { totalFound: refResults.totalCount, samples: [] },
        };
      }

      const defResult = defResults.results[0];
      const defMatch = defResult.matches[0];
      const defContent = await client.getFileContent(
        defResult.project,
        defResult.path,
        Math.max(1, defMatch.lineNumber - contextLines),
        defMatch.lineNumber + contextLines
      );

      let header;
      if (includeHeader && defResult.path.match(/\.(cpp|cc|cxx)$/i)) {
        const headerResults = await client.search(symbol, "defs", projects, 5, 0, fileType);
        const headerMatch = headerResults.results.find((r) => r.path.match(/\.(h|hpp|hxx)$/i));
        if (headerMatch?.matches.length) {
          const hLine = headerMatch.matches[0].lineNumber;
          const hContent = await client.getFileContent(
            headerMatch.project, headerMatch.path,
            Math.max(1, hLine - 10), hLine + 10
          );
          header = { project: headerMatch.project, path: headerMatch.path, context: hContent.content, lang: "cpp" };
        }
      }

      return {
        found: true,
        symbol,
        kind: defResult.path.match(/\.(h|hpp|hxx)$/i) ? "class/struct" : "function/method",
        definition: {
          project: defResult.project,
          path: defResult.path,
          line: defMatch.lineNumber,
          context: defContent.content,
          lang: defResult.path.split(".").pop() ?? "",
        },
        header,
        references: {
          totalFound: refResults.totalCount,
          samples: refResults.results.flatMap((r) =>
            r.matches.slice(0, 2).map((m) => ({
              path: r.path, project: r.project,
              lineNumber: m.lineNumber, content: m.lineContent,
            }))
          ),
        },
      };
    },

    async getFileSymbols(project, path) {
      return client.getFileSymbols(project, path);
    },

    async getFileHistory(project, path, opts = {}) {
      return client.getFileHistory(project, path, opts.maxEntries ?? 10);
    },

    async getFileAnnotate(project, path) {
      return client.getAnnotate(project, path);
    },

    async browseDir(project, path = "") {
      const entries = await client.browseDirectory(project, path);
      return { project, path, entries };
    },

    async findFile(pattern, opts = {}) {
      return client.search(pattern, "path", opts.projects, opts.maxResults ?? 10, 0);
    },

    async getFileOverview(project, path) {
      return buildFileOverview(client, project, path);
    },

    async traceCallChain(symbol, opts = {}) {
      const { direction = "callers", depth = 2, project } = opts;
      return buildCallChain(client, symbol, direction, depth, project);
    },

    async searchSuggest(query, opts = {}) {
      const result = await client.suggest(query, opts.project, (opts.field ?? "full") as any);
      return { query, field: opts.field ?? "full", suggestions: result.suggestions, time: result.time };
    },

    async getCompileInfo(_path) {
      return null;
    },

    async indexHealth() {
      const start = Date.now();
      const connected = await client.testConnection();
      const result: HealthAPIResult = {
        connected,
        latencyMs: Date.now() - start,
        baseUrl: "",
      };
      return result;
    },

    async readMemory(filename) {
      return memoryBank.read(filename);
    },

    async writeMemory(filename, content, mode = "overwrite") {
      await memoryBank.write(filename, content, mode);
      return `Written: ${filename}`;
    },
  };
}

// ---------------------------------------------------------------------------
// executeInSandbox — core execution engine
// ---------------------------------------------------------------------------

/**
 * Execute LLM-written JavaScript inside a QuickJS WASM sandbox (Worker thread).
 *
 * The code has access to `env.opengrok.*` methods that bridge back to the host
 * via SharedArrayBuffer + Atomics (synchronous from code's perspective).
 *
 * @param capFn  — response-size cap function (e.g. capResponse from server.ts)
 * Returns: capFn-capped result string, or an error message.
 */
export async function executeInSandbox(
  code: string,
  api: SandboxAPI,
  capFn: (text: string) => string,
  budgetBytes: number
): Promise<string> {
  // Create shared communication buffer (layout pinned — must match sandbox-worker.ts)
  const sharedBuffer = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
  const statusArray = new Int32Array(sharedBuffer, 0, 4);  // bytes 0–15
  const lengthArray = new Uint32Array(sharedBuffer, 16, 1); // bytes 16–19
  const dataArray   = new Uint8Array(sharedBuffer, 20);     // bytes 20+

  let stopped = false;
  let _resolve!: (value: string) => void;

  function safeResolve(value: string): void {
    if (stopped) return;
    stopped = true;
    _resolve(value);
  }

  // ---------------------------------------------------------------------------
  // Poll loop — processes pending API calls from the worker
  // ---------------------------------------------------------------------------

  async function handleWorkerCall(): Promise<void> {
    if (stopped) return;

    if (Atomics.load(statusArray, 0) === 1) {
      // Worker has a pending API call — deserialize it
      try {
        const callLen  = lengthArray[0];
        const callJson = Buffer.from(dataArray.subarray(0, callLen)).toString("utf8");
        const { method, args } = JSON.parse(callJson) as { method: string; args: unknown[] };

        const apiMethod = (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
        if (typeof apiMethod !== "function") {
          throw new Error(`Unknown API method: ${method}`);
        }

        // Execute the real async HTTP call on the main thread
        const result = await apiMethod(...args);

        // Write result back into the buffer
        const resultJson    = JSON.stringify({ data: result ?? null });
        const resultEncoded = Buffer.from(resultJson, "utf8");

        if (resultEncoded.length > dataArray.length) {
          // Overflow: result too large — send error sentinel
          const errJson    = JSON.stringify({ __error: `API result too large: ${resultEncoded.length} bytes` });
          const errEncoded = Buffer.from(errJson, "utf8");
          lengthArray[0]   = errEncoded.length;
          dataArray.set(errEncoded, 0);
        } else {
          lengthArray[0] = resultEncoded.length;
          dataArray.set(resultEncoded, 0);
        }
      } catch (err) {
        // Write error back into the buffer using __error sentinel
        const errMsg     = (err as Error).message ?? "Unknown API error";
        const errJson    = JSON.stringify({ __error: errMsg });
        const errEncoded = Buffer.from(errJson, "utf8");
        lengthArray[0]   = errEncoded.length;
        dataArray.set(errEncoded, 0);
      }

      // Signal: result_ready — wake up the blocked worker thread
      Atomics.store(statusArray, 0, 2);
      Atomics.notify(statusArray, 0);
    }

    if (!stopped) {
      setImmediate(() => {
        handleWorkerCall().catch((err) => {
          logger.error("Sandbox poll error:", err);
        });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Spawn worker and wire up result handling
  // ---------------------------------------------------------------------------

  // Resolve worker path: works in both compiled (out/server/) and test (src/server/) contexts
  const localWorkerPath = path.join(__dirname, "sandbox-worker.js");
  const devWorkerPath = path.join(__dirname, "..", "..", "out", "server", "sandbox-worker.js");
  const workerPath = fs.existsSync(localWorkerPath) ? localWorkerPath : devWorkerPath;
  const worker = new Worker(workerPath, { workerData: { sharedBuffer, code } });

  return new Promise<string>((resolve) => {
    _resolve = resolve;

    // Hard timeout — terminates worker unconditionally at 10 s
    // (covers cases where worker is blocked in Atomics.wait during a slow API call)
    const hardTimeoutId = setTimeout(() => {
      worker.terminate();
      safeResolve(
        "Error: Sandbox execution timed out (10s limit). Simplify your code or reduce the number of API calls."
      );
    }, 10_000);

    worker.on("message", (result: { ok: boolean; data?: unknown; error?: { name: string; message: string } }) => {
      clearTimeout(hardTimeoutId);

      if (!result.ok) {
        const { name, message } = result.error ?? { name: "Error", message: "Unknown" };
        if (name === "ExecutionTimeout" || (name === "InternalError" && message === "interrupted")) {
          safeResolve(
            "Error: Sandbox execution timed out (9s limit). Simplify your code or reduce the number of API calls."
          );
          return;
        }
        if (message?.toLowerCase().includes("memory limit") || message?.toLowerCase().includes("out of memory")) {
          safeResolve(
            "Error: Sandbox memory limit exceeded (128 MB). Reduce data volume — filter results before storing."
          );
          return;
        }
        logger.error("Sandbox execution error:", `${name}: ${message}`);
        safeResolve(`Error: ${message ?? "Unknown sandbox error"}`);
        return;
      }

      const data = result.data;
      if (data === undefined || data === null) {
        safeResolve("(no return value — add a return statement to your code)");
        return;
      }

      const serialized =
        typeof data === "string" ? data : JSON.stringify(data, null, 2);
      safeResolve(capFn(serialized));
    });

    worker.on("error", (err) => {
      clearTimeout(hardTimeoutId);
      logger.error("Sandbox worker error:", err);
      safeResolve(`Error: ${err.message ?? "Worker error"}`);
    });

    worker.on("exit", (code) => {
      clearTimeout(hardTimeoutId);
      if (!stopped) {
        safeResolve(`Error: Sandbox worker exited unexpectedly (code ${code})`);
      }
    });

    // Start the poll loop
    handleWorkerCall().catch((err) => {
      logger.error("Sandbox poll startup error:", err);
    });
  });
}
