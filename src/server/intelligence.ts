/**
 * Server-side intelligence: pre-computed file overviews and call chains.
 * These functions run on the host process and produce structured summaries
 * that the sandbox code (Code Mode) can request via the API object,
 * avoiding expensive multi-step LLM round trips.
 *
 * Design decisions:
 * - buildCallChain returns empty callees[] — callee direction requires AST,
 *   which OpenGrok's search API does not provide.
 * - getEnclosingFunction requires a non-empty project string (caller must supply it).
 * - buildSymbolTree skips enclosure check when endLine is missing (symbols from
 *   OpenGrok sometimes lack line-end information).
 * - Max traversal depth is capped at 4 to prevent runaway recursion.
 */

import type { OpenGrokClient } from "./client.js";
import type {
  CallChainAPIResult,
  CallNode,
  FileOverviewAPIResult,
} from "./api-types.js";

// ---------------------------------------------------------------------------
// File overview
// ---------------------------------------------------------------------------

/**
 * Build a compact file overview combining symbols, recent history, and imports.
 * Uses parallel requests for efficiency.
 */
export async function buildFileOverview(
  client: OpenGrokClient,
  project: string,
  filePath: string
): Promise<FileOverviewAPIResult> {
  const lang = langFromPath(filePath);

  // Parallel: symbols + file head (for import extraction) + history
  const [symbolsResult, headContent, historyResult] = await Promise.allSettled([
    client.getFileSymbols(project, filePath),
    client.getFileContent(project, filePath, 1, 30),
    client.getFileHistory(project, filePath, 3),
  ]);

  const symbols =
    symbolsResult.status === "fulfilled" ? symbolsResult.value.symbols : [];
  const headText =
    headContent.status === "fulfilled" ? headContent.value.content : "";
  const history =
    historyResult.status === "fulfilled" ? historyResult.value.entries : [];

  const imports = extractImports(headText, lang);
  const recentAuthors = [
    ...new Set(history.map((h) => h.author.split("<")[0].trim())),
  ].slice(0, 3);
  const lastRevision = history[0]?.revision.slice(0, 8) ?? "unknown";

  // Compute total line count and size from the head result
  const sizeLines =
    headContent.status === "fulfilled" ? headContent.value.lineCount : 0;
  const sizeBytes =
    headContent.status === "fulfilled" ? headContent.value.sizeBytes : 0;

  return {
    project,
    path: filePath,
    lang,
    sizeLines,
    sizeBytes,
    imports,
    topLevelSymbols: buildSymbolTree(symbols),
    recentAuthors,
    lastRevision,
  };
}

// ---------------------------------------------------------------------------
// Call chain
// ---------------------------------------------------------------------------

const MAX_CALL_CHAIN_DEPTH = 4;

/**
 * Trace callers (or callees) of a symbol up to MAX_CALL_CHAIN_DEPTH.
 *
 * IMPORTANT: callees direction is NOT implemented (requires AST).
 * When direction is "callees" or "both", callees array is always empty.
 */
export async function buildCallChain(
  client: OpenGrokClient,
  symbol: string,
  direction: "callers" | "callees" | "both",
  depth: number,
  project?: string
): Promise<CallChainAPIResult> {
  const cappedDepth = Math.min(depth, MAX_CALL_CHAIN_DEPTH);

  const callers: CallNode[] =
    direction === "callees"
      ? []
      : await traceCallers(client, symbol, cappedDepth, cappedDepth, project, new Set());

  // Callees require AST analysis not available via OpenGrok search API
  const callees: CallNode[] = [];

  let truncatedAt: number | undefined;
  if (cappedDepth < depth) {
    truncatedAt = cappedDepth;
  }

  return {
    symbol,
    direction,
    callers,
    callees,
    truncatedAt,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function traceCallers(
  client: OpenGrokClient,
  symbol: string,
  depth: number,
  maxDepth: number,
  project: string | undefined,
  visited: Set<string>
): Promise<CallNode[]> {
  if (depth === 0 || visited.has(symbol)) return [];
  visited.add(symbol);

  const projects = project ? [project] : undefined;
  let searchResult;
  try {
    searchResult = await client.search(symbol, "refs", projects, 10, 0);
  } catch {
    return [];
  }

  const nodes: CallNode[] = [];

  for (const result of searchResult.results) {
    for (const match of result.matches.slice(0, 3)) {
      const callerSym = await getEnclosingFunction(
        client,
        result.project,
        result.path,
        match.lineNumber
      );

      const node: CallNode = {
        symbol: callerSym ?? `${result.path}:${match.lineNumber}`,
        path: result.path,
        project: result.project,
        line: match.lineNumber,
        depth: maxDepth - depth + 1,
      };
      nodes.push(node);

      if (callerSym && depth > 1) {
        const subCallers = await traceCallers(
          client,
          callerSym,
          depth - 1,
          maxDepth,
          project,
          visited
        );
        nodes.push(...subCallers);
      }
    }
  }

  return nodes;
}

/**
 * Find the symbol that encloses a given line number in a file.
 * Requires a non-empty project string.
 */
async function getEnclosingFunction(
  client: OpenGrokClient,
  project: string,
  filePath: string,
  lineNumber: number
): Promise<string | null> {
  if (!project) return null;

  let symbols;
  try {
    symbols = await client.getFileSymbols(project, filePath);
  } catch {
    return null;
  }

  // Find symbol whose range encloses the target line
  let best: { symbol: string; lineStart: number; lineEnd: number } | null = null;

  for (const sym of symbols.symbols) {
    const start = sym.lineStart ?? sym.line;
    const end = sym.lineEnd;

    // Skip symbols without endLine — can't determine enclosure
    if (!end) continue;

    if (start <= lineNumber && lineNumber <= end) {
      // Prefer the smallest enclosing range (most specific function)
      if (!best || end - start < best.lineEnd - best.lineStart) {
        best = { symbol: sym.symbol, lineStart: start, lineEnd: end };
      }
    }
  }

  return best?.symbol ?? null;
}

/**
 * Build a hierarchical symbol tree from flat symbols array.
 * Skips enclosure grouping when endLine is absent.
 */
function buildSymbolTree(
  symbols: Array<{
    symbol: string;
    type: string;
    line: number;
    lineStart: number;
    lineEnd: number;
    signature: string | null;
    namespace: string | null;
  }>
): FileOverviewAPIResult["topLevelSymbols"] {
  // Sort by line number
  const sorted = [...symbols].sort(
    (a, b) => (a.lineStart ?? a.line) - (b.lineStart ?? b.line)
  );

  const topLevel: FileOverviewAPIResult["topLevelSymbols"] = [];

  for (const sym of sorted) {
    const symLine = sym.lineStart ?? sym.line;

    // Check if this symbol is enclosed by a top-level symbol
    let isChild = false;
    for (const top of topLevel) {
      if (!top.endLine) continue; // Can't determine nesting without end line
      if (symLine > top.line && symLine <= top.endLine) {
        if (!top.children) top.children = [];
        top.children.push({ symbol: sym.symbol, type: sym.type, line: symLine });
        isChild = true;
        break;
      }
    }

    if (!isChild) {
      topLevel.push({
        symbol: sym.symbol,
        type: sym.type,
        line: symLine,
        endLine: sym.lineEnd || undefined,
        children: undefined,
      });
    }
  }

  return topLevel;
}

/**
 * Extract import/include statements from file header text.
 */
export function extractImports(text: string, lang: string): string[] {
  const imports: string[] = [];

  if (lang === "cpp" || lang === "c") {
    // C/C++: #include "..." or <...>
    const matches = text.matchAll(/#include\s+["<]([^">]+)[">]/g);
    for (const m of matches) {
      if (m[1]) imports.push(m[1]);
    }
  } else {
    // Generic: import / require / from statements
    const matches = text.matchAll(/(?:import|require|from)\s+["'`]([^"'`]+)["'`]/g);
    for (const m of matches) {
      if (m[1]) imports.push(m[1]);
    }
  }

  return [...new Set(imports)].slice(0, 20);
}

export function langFromPath(filePath: string): string {
  const ext = (filePath.split(".").pop() ?? "").toLowerCase();
  const map: Record<string, string> = {
    cpp: "cpp", cxx: "cpp", cc: "cpp", c: "c",
    h: "cpp", hpp: "cpp", hxx: "cpp",
    java: "java", py: "python",
    js: "javascript", ts: "typescript",
    go: "go", rs: "rust",
  };
  return map[ext] ?? ext;
}
