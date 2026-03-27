/**
 * Compact formatters for MCP tool responses.
 * Optimised for minimal token footprint: no decorative markdown, no links,
 * one-line-per-match for search, dense formats for history/blame/directory.
 *
 * v5.0: Added compact formats — TSV (search results, ~50% savings),
 *       YAML (hierarchical, ~35% savings), Text (raw code, minimal overhead).
 */

import yaml from "js-yaml";
import type {
  AnnotatedFile,
  DirectoryEntry,
  FileContent,
  FileHistory,
  FileSymbols,
  Project,
  SearchResults,
} from "./models.js";
import type { CompileInfo } from "./local/compile-info.js";

// ---------------------------------------------------------------------------
// Response format type + global format selector
// ---------------------------------------------------------------------------

export type ResponseFormat = "markdown" | "json" | "tsv" | "yaml" | "text" | "auto";

/**
 * Resolve the effective format for a given response type.
 * Global OPENGROK_RESPONSE_FORMAT_OVERRIDE takes priority over the per-call preference.
 * "auto" defers to the responseType-specific best choice.
 */
export function selectFormat(
  responseType: "search" | "symbol" | "code" | "generic",
  perCallFormat?: ResponseFormat | null
): ResponseFormat {
  // Global override (for rollback / experimentation)
  const globalOverride = process.env.OPENGROK_RESPONSE_FORMAT_OVERRIDE?.trim().toLowerCase();
  const validFormats: ResponseFormat[] = ["markdown", "json", "tsv", "yaml", "text", "auto"];
  const override = validFormats.includes(globalOverride as ResponseFormat)
    ? (globalOverride as ResponseFormat)
    : undefined;

  const effective = override ?? perCallFormat ?? "auto";

  if (effective !== "auto") return effective;

  // Auto-selection based on response type
  switch (responseType) {
    case "search":  return "tsv";      // Flat, tabular — TSV is most compact
    case "symbol":  return "yaml";     // Hierarchical — YAML preserves structure
    case "code":    return "text";     // Raw code — no markdown overhead
    case "generic": return "markdown"; // Fallback
  }
}



// Max lines returned for a full-file read (no line range specified).
// Override with OPENGROK_MAX_INLINE_LINES env var.
const MAX_INLINE_LINES = parseInt(
  process.env.OPENGROK_MAX_INLINE_LINES ?? "200",
  10
);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const HTML_NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
  "#39": "'",
};

function stripHtmlTags(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    // Named HTML entities
    .replace(/&(lt|gt|amp|quot|apos|nbsp|#39);/g, (_, e) => /* v8 ignore next */ HTML_NAMED_ENTITIES[e] ?? _)
    // Decimal numeric references: &#60; → '<'
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    // Hex numeric references: &#x3C; → '<'
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

const LANGUAGE_MAP: Record<string, string> = {
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  c: "c",
  h: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  java: "java",
  py: "python",
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  go: "go",
  rs: "rust",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  sql: "sql",
  xml: "xml",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  txt: "",
  log: "",
  rb: "ruby",
  cs: "csharp",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  php: "php",
  html: "html",
  css: "css",
  scss: "scss",
  vue: "vue",
  scala: "scala",
  gradle: "groovy",
  dart: "dart",
  zig: "zig",
  lua: "lua",
  r: "r",
  m: "objc",
  mm: "objcpp",
  pl: "perl",
  pm: "perl",
  tf: "hcl",
  toml: "toml",
  ini: "ini",
  proto: "protobuf",
};

function langForPath(path: string): string {
  const ext = path.includes(".") ? (path.split(".").pop() ?? "").toLowerCase() : "";
  return LANGUAGE_MAP[ext] ?? "";
}

// ---------------------------------------------------------------------------
// Search results -- compact one-line-per-match format
// ---------------------------------------------------------------------------

export function formatSearchResults(
  results: SearchResults,
): string {
  const lines: string[] = [];
  lines.push(
    `Search: "${results.query}" -- ${results.totalCount.toLocaleString()} matches (${results.timeMs}ms)`
  );

  if (!results.results.length) {
    lines.push("No results found.");
    return lines.join("\n");
  }

  for (const result of results.results) {
    for (const match of result.matches.slice(0, 5)) {
      lines.push(
        `${result.path} (${result.project}) L${match.lineNumber}: ${stripHtmlTags(match.lineContent).trim()}`
      );
    }
    if (result.matches.length > 5) {
      lines.push(`  ... +${result.matches.length - 5} more in ${result.path}`);
    }
  }

  if (results.endIndex < results.totalCount) {
    lines.push(
      `Showing ${results.results.length} of ${results.totalCount} results. Narrow query or increase max_results.`
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// File content -- with smart truncation for full-file reads
// ---------------------------------------------------------------------------

export function formatFileContent(
  content: FileContent,
  showLineNumbers = true
): string {
  const lines: string[] = [];
  const filename = /* v8 ignore next */ content.path.split("/").pop() ?? content.path;
  const lang = langForPath(content.path);

  lines.push(
    `${filename} (${content.project}) -- ${content.lineCount} lines, ${content.sizeBytes.toLocaleString()} bytes`
  );

  const contentLines = content.content.split("\n");
  let truncated = false;
  let displayLines = contentLines;

  if (contentLines.length > MAX_INLINE_LINES) {
    displayLines = contentLines.slice(0, MAX_INLINE_LINES);
    truncated = true;
  }

  lines.push(`\`\`\`${lang}`);
  if (showLineNumbers) {
    const firstLineNum = content.startLine ?? 1;
    for (const [i, line] of displayLines.entries()) {
      const lineNum = firstLineNum + i;
      lines.push(`${filename}:${lineNum}: ${line}`);
    }
  } else {
    lines.push(displayLines.join("\n"));
  }
  lines.push("```");

  if (truncated) {
    lines.push(
      `*Showing first ${MAX_INLINE_LINES} of ${content.lineCount} lines. Use start_line/end_line to read specific sections.*`
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// File history -- compact one-line-per-entry format
// ---------------------------------------------------------------------------

export function formatFileHistory(
  history: FileHistory,
): string {
  const lines: string[] = [];
  const filename = /* v8 ignore next */ history.path.split("/").pop() ?? history.path;
  lines.push(
    `History: ${filename} (${history.project}) -- ${history.entries.length} commits`
  );

  if (!history.entries.length) {
    lines.push("No history entries found.");
    return lines.join("\n");
  }

  for (const entry of history.entries) {
    const revShort =
      entry.revision.length > 8 ? entry.revision.slice(0, 8) : entry.revision;
    const author = entry.author.split("<")[0].trim();
    const msg =
      entry.message.length > 72
        ? entry.message.slice(0, 72) + "..."
        : entry.message;
    lines.push(
      `[${revShort}] ${author} (${entry.date}): "${msg.replace(/\n/g, " ")}"`
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Directory listing -- compact two-column format
// ---------------------------------------------------------------------------

export function formatDirectoryListing(
  entries: DirectoryEntry[],
  project: string,
  path: string,
): string {
  const lines: string[] = [];
  const displayPath = path || "/";
  lines.push(`Directory: ${displayPath} (${project})`);

  if (!entries.length) {
    lines.push("(empty)");
    return lines.join("\n");
  }

  const dirs = entries
    .filter((e) => e.isDirectory)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const files = entries
    .filter((e) => !e.isDirectory)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  for (const d of dirs) lines.push(`DIR  ${d.name}/`);
  for (const f of files) {
    const sizeStr =
      f.size !== undefined ? ` (${f.size.toLocaleString()} bytes)` : "";
    lines.push(`FILE ${f.name}${sizeStr}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Projects list
// ---------------------------------------------------------------------------

export function formatProjectsList(projects: Project[]): string {
  const lines: string[] = [];

  if (!projects.length) {
    lines.push("No projects found.");
    return lines.join("\n");
  }

  lines.push(`${projects.length} projects:`);

  const categories = new Map<string, Project[]>();
  for (const p of projects) {
    const cat = p.category ?? "Other";
    if (!categories.has(cat)) categories.set(cat, []);
    const arr = categories.get(cat);
    if (arr) arr.push(p);
  }

  for (const [category, projs] of categories) {
    lines.push(`### ${category}`);
    for (const p of projs.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`  ${p.name}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Annotate / blame -- grouped consecutive same-author lines, respects range
// ---------------------------------------------------------------------------

export function formatAnnotate(
  annotate: AnnotatedFile,
  startLine?: number,
  endLine?: number
): string {
  const lines: string[] = [];
  const filename = /* v8 ignore next */ annotate.path.split("/").pop() ?? annotate.path;
  lines.push(`Blame: ${filename} (${annotate.project})`);

  if (!annotate.lines.length) {
    lines.push("No annotations found.");
    return lines.join("\n");
  }

  // Apply line range filter
  let displayLines = annotate.lines;
  if (startLine !== undefined || endLine !== undefined) {
    /* v8 ignore start -- coverage misreports ?? for undefined */
    const s = startLine ?? 1;
    const e = endLine ?? Infinity;
    /* v8 ignore stop */
    displayLines = annotate.lines.filter(
      (l) => l.lineNumber >= s && l.lineNumber <= e
    );
  } else {
    // Default cap: 50 lines for full-file views
    displayLines = annotate.lines.slice(0, 50);
  }

  if (!displayLines.length) {
    lines.push("No lines in specified range.");
    return lines.join("\n");
  }

  lines.push("```");

  // Show per-line blame with revision+author on first line of each group
  let prevKey = "";
  for (const line of displayLines) {
    const rev = line.revision ? line.revision.slice(0, 7) : "       ";
    const author = (line.author ?? "").padEnd(8).slice(0, 8);
    const key = `${rev}|${line.author}`;
    const prefix = key !== prevKey ? `${rev} ${author}` : "               ";
    prevKey = key;
    lines.push(`${prefix} L${line.lineNumber}: ${line.content.trimEnd()}`);
  }
  lines.push("```");

  const totalLines = annotate.lines.length;
  const shown = displayLines.length;
  if (shown < totalLines && startLine === undefined && endLine === undefined) {
    lines.push(
      `*Showing first ${shown} of ${totalLines} lines. Use start_line/end_line for a specific range.*`
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Compound: search_and_read
// ---------------------------------------------------------------------------

export interface SearchAndReadEntry {
  project: string;
  path: string;
  matchLine: number;
  context: string;
  lang: string;
}

export function formatSearchAndRead(
  query: string,
  totalCount: number,
  entries: SearchAndReadEntry[]
): string {
  const lines: string[] = [];
  lines.push(
    `Search+Read: "${query}" -- ${totalCount.toLocaleString()} total matches, showing ${entries.length}`
  );

  for (const entry of entries) {
    lines.push(
      `\n--- ${entry.path} (${entry.project}) around L${entry.matchLine} ---`
    );
    lines.push(`\`\`\`${entry.lang}`);
    lines.push(entry.context);
    lines.push("```");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Compound: batch_search
// ---------------------------------------------------------------------------

export function formatBatchSearchResults(
  queryResults: Array<{
    query: string;
    searchType: string;
    results: SearchResults;
  }>
): string {
  const lines: string[] = [];
  const totalMatches = queryResults.reduce(
    (s, r) => s + r.results.totalCount,
    0
  );
  lines.push(
    `Batch search: ${queryResults.length} queries, ${totalMatches.toLocaleString()} total matches`
  );

  for (const { query, searchType, results } of queryResults) {
    lines.push(`\n[${searchType}] "${query}" -- ${results.totalCount} matches:`);
    if (!results.results.length) {
      lines.push("  (no results)");
      continue;
    }
    for (const result of results.results) {
      for (const match of result.matches.slice(0, 3)) {
        lines.push(
          `  ${result.path} (${result.project}) L${match.lineNumber}: ${stripHtmlTags(match.lineContent).trim()}`
        );
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Compound: get_symbol_context
// ---------------------------------------------------------------------------

export interface SymbolContextResult {
  found: boolean;
  symbol: string;
  kind: string;
  definition?: {
    project: string;
    path: string;
    line: number;
    context: string;
    lang: string;
  };
  header?: {
    project: string;
    path: string;
    context: string;
    lang: string;
  };
  references: {
    totalFound: number;
    samples: Array<{
      path: string;
      project: string;
      lineNumber: number;
      content: string;
    }>;
  };
  fileSymbols?: Array<{ symbol: string; type: string; line: number }>;
}

export function formatSymbolContext(result: SymbolContextResult): string {
  if (!result.found) {
    return `Symbol "${result.symbol}" not found.`;
  }

  const lines: string[] = [];
  lines.push(`Symbol: ${result.symbol} (${result.kind})`);

  /* v8 ignore start */
  if (result.definition) {
  /* v8 ignore stop */
    const d = result.definition;
    lines.push(`\nDefinition: ${d.path} (${d.project}) L${d.line}`);
    lines.push(`\`\`\`${d.lang}`);
    lines.push(d.context);
    lines.push("```");
  }

  if (result.header) {
    const h = result.header;
    lines.push(`\nHeader: ${h.path} (${h.project})`);
    lines.push(`\`\`\`${h.lang}`);
    lines.push(h.context);
    lines.push("```");
  }

  if (result.references.totalFound > 0) {
    lines.push(`\nReferences: ${result.references.totalFound} total`);
    for (const ref of result.references.samples) {
      lines.push(
        `  ${ref.path} (${ref.project}) L${ref.lineNumber}: ${stripHtmlTags(ref.content).trim()}`
      );
    }
  } else {
    lines.push("\nReferences: none found");
  }

  if (result.fileSymbols && result.fileSymbols.length > 0) {
    lines.push(`\nFile symbols (${result.fileSymbols.length}):`);
    // Group by type for compact display
    const byType = new Map<string, typeof result.fileSymbols>();
    for (const s of result.fileSymbols) {
      if (!byType.has(s.type)) byType.set(s.type, []);
      const arr = byType.get(s.type);
      if (arr) arr.push(s);
    }
    for (const [type, syms] of byType) {
      const sorted = [...syms].sort((a, b) => a.line - b.line);
      lines.push(`  ${type}: ${sorted.map((s) => `${s.symbol}:L${s.line}`).join(", ")}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Local: get_compile_info
// ---------------------------------------------------------------------------

export function formatCompileInfo(
  info: CompileInfo | null,
  requestedPath: string
): string {
  if (!info) {
    const name =
      /* v8 ignore next */ requestedPath.split(/[/\\]/).pop() ?? requestedPath;
    return `No compile information found for: ${name}`;
  }

  const lines: string[] = [];
  const filename = /* v8 ignore next */ info.file.split(/[/\\]/).pop() ?? info.file;
  lines.push(`Compile: ${filename}`);
  lines.push(`  file:     ${info.file}`);
  lines.push(`  compiler: ${info.compiler}`);
  if (info.standard) {
    lines.push(`  std:      ${info.standard}`);
  }
  if (info.includes.length) {
    lines.push(`  includes (${info.includes.length}):`);
    for (const inc of info.includes) {
      lines.push(`    ${inc}`);
    }
  }
  if (info.defines.length) {
    // Compact: all defines on one line; each is short
    lines.push(`  defines:  ${info.defines.join("  ")}`);
  }
  if (info.extraFlags.length) {
    lines.push(`  flags:    ${info.extraFlags.join(" ")}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// get_file_symbols
// ---------------------------------------------------------------------------

export function formatFileSymbols(result: FileSymbols): string {
  const filename = /* v8 ignore next */ result.path.split("/").pop() ?? result.path;
  const lines: string[] = [];

  if (!result.symbols.length) {
    lines.push(`Symbols: ${filename} (${result.project}) -- 0 symbols`);
    lines.push("No symbols found.");
    return lines.join("\n");
  }

  lines.push(`Symbols: ${filename} (${result.project}) -- ${result.symbols.length} symbols`);

  // Group by type, sort each group by line number
  const groups = new Map<string, typeof result.symbols>();
  for (const sym of result.symbols) {
    const key = sym.type ?? "Unknown";
    if (!groups.has(key)) groups.set(key, []);
    const arr = groups.get(key);
    if (arr) arr.push(sym);
  }

  // Sort groups by first occurrence line (keeps logical order)
  const sortedGroups = [...groups.entries()].sort(
    ([, a], [, b]) => (a[0]?.lineStart ?? 0) - (b[0]?.lineStart ?? 0)
  );

  for (const [type, syms] of sortedGroups) {
    const sorted = [...syms].sort((a, b) => (a.lineStart ?? a.line) - (b.lineStart ?? b.line));
    lines.push(`\n${type} (${sorted.length}):`);
    for (const sym of sorted) {
      const lineNum = sym.lineStart ?? sym.line;
      let entry = `  ${sym.symbol}  L${lineNum}`;
      if (sym.signature) {
        const sig = sym.signature.length > 80 ? sym.signature.slice(0, 77) + "..." : sym.signature;
        entry += `  ${sig}`;
      }
      lines.push(entry);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// COMPACT FORMATTERS — Phase 2 response format upgrades
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TSV: search results (~50% token savings vs JSON)
// Format: path\tproject\tline\tcontent
// ---------------------------------------------------------------------------

/**
 * Format search results as TSV (tab-separated).
 * Header row: path, project, line, content
 * ~50% fewer tokens than JSON; safe for C++ (no comma ambiguity).
 */
export function formatSearchResultsTSV(results: SearchResults): string {
  const rows: string[] = [];
  rows.push(
    `# Search: "${results.query}" -- ${results.totalCount.toLocaleString()} matches (${results.timeMs}ms)`
  );
  rows.push("path\tproject\tline\tcontent");

  for (const result of results.results) {
    for (const match of result.matches.slice(0, 5)) {
      // Tabs in content → spaces; newlines → space — keeps TSV well-formed
      const content = stripHtmlTags(match.lineContent)
        .trim()
        .replace(/\t/g, "  ")
        .replace(/\n/g, " ");
      rows.push(`${result.path}\t${result.project}\t${match.lineNumber}\t${content}`);
    }
    if (result.matches.length > 5) {
      rows.push(`# ... +${result.matches.length - 5} more in ${result.path}`);
    }
  }

  if (results.endIndex < results.totalCount) {
    rows.push(
      `# Showing ${results.results.length} of ${results.totalCount}. Narrow query or increase max_results.`
    );
  }

  return rows.join("\n");
}

// ---------------------------------------------------------------------------
// YAML: symbol context (~35% savings, preserves hierarchy, handles C++ safely)
// ---------------------------------------------------------------------------

/**
 * Format symbol context result as YAML.
 * Uses js-yaml with block scalars for code content — handles C++ safely
 * (colons, braces, hashes in code won't break YAML structure).
 */
export function formatSymbolContextYAML(result: SymbolContextResult): string {
  if (!result.found) {
    return yaml.dump({ found: false, symbol: result.symbol, kind: result.kind });
  }

  const doc: Record<string, unknown> = {
    found: true,
    symbol: result.symbol,
    kind: result.kind,
  };

  if (result.definition) {
    const d = result.definition;
    doc["definition"] = {
      project: d.project,
      path: d.path,
      line: d.line,
      lang: d.lang,
      // Block scalar (literal | style) prevents C++ code from breaking YAML
      context: d.context,
    };
  }

  if (result.header) {
    const h = result.header;
    doc["header"] = {
      project: h.project,
      path: h.path,
      lang: h.lang,
      context: h.context,
    };
  }

  doc["references"] = {
    totalFound: result.references.totalFound,
    samples: result.references.samples.map((s) => ({
      path: s.path,
      project: s.project,
      line: s.lineNumber,
      content: stripHtmlTags(s.content).trim(),
    })),
  };

  if (result.fileSymbols && result.fileSymbols.length > 0) {
    doc["fileSymbols"] = result.fileSymbols.map((s) => ({
      symbol: s.symbol,
      type: s.type,
      line: s.line,
    }));
  }

  return yaml.dump(doc, {
    lineWidth: 120,
    quotingType: "'",
    forceQuotes: false,
    noRefs: true,
  });
}

// ---------------------------------------------------------------------------
// Text: raw file content with minimal header (no markdown code fences)
// ---------------------------------------------------------------------------

/**
 * Format file content as plain text with a compact header.
 * Saves ~15 tokens per file vs markdown (no ``` fences, no line-number padding).
 */
export function formatFileContentText(content: FileContent): string {
  const filename = /* v8 ignore next */ content.path.split("/").pop() ?? content.path;
  const startL = content.startLine ?? 1;
  const endL = startL + content.lineCount - 1;
  const header = `-- ${filename} (${content.project}) L${startL}-${endL} --\n`;

  const contentLines = content.content.split("\n");
  let displayLines = contentLines;

  if (contentLines.length > MAX_INLINE_LINES) {
    displayLines = contentLines.slice(0, MAX_INLINE_LINES);
  }

  const lines: string[] = [];
  for (const [i, line] of displayLines.entries()) {
    const lineNum = startL + i;
    lines.push(`${filename}:${lineNum}: ${line}`);
  }

  return header + lines.join("\n");
}
