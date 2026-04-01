/**
 * Data models and Zod validation schemas for OpenGrok MCP Server.
 * v4.0: Added response_format field, structured output schemas.
 */

import { z } from "zod";

// Shared response format field added to all tool input schemas.
// Extended with compact formats: tsv (tabular, ~50% token savings), yaml (hierarchical, ~35% savings),
// text (raw code, minimal overhead), auto (server picks best format per response type).
// NOTE: .optional().default("auto") ordering ensures the inferred output type is always `string`
// (not `string | undefined`), avoiding redundant null-guards in tool handlers.
const RESPONSE_FORMAT = z
  .enum(["markdown", "json", "tsv", "yaml", "text", "toon", "auto"])
  .optional()
  .default("auto")
  .describe("Output format: markdown, json, tsv, toon, yaml, text, or auto.");

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const SearchType = {
  FULL: "full",
  DEFS: "defs",
  REFS: "refs",
  PATH: "path",
  HIST: "hist",
} as const;

export type SearchTypeValue = (typeof SearchType)[keyof typeof SearchType];

// ---------------------------------------------------------------------------
// Tool argument schemas (used for input validation in server.ts)
// ---------------------------------------------------------------------------

const FILE_TYPE_DESC = "Filter by language: c, cxx (C++), java, python, javascript, typescript, csharp, golang, ruby, perl, php, scala, kotlin, swift, rust, sql, xml, json, yaml, shell, makefile, etc.";

export const SearchCodeArgs = z.object({
  query: z.string().min(1, "query must not be empty").describe('Search query. Supports OpenGrok syntax: +required -excluded "exact phrase"'),
  search_type: z.enum(["full", "defs", "refs", "path", "hist"]).default("full"),
  projects: z.array(z.string()).optional().describe("Filter by project names. Omit to use the server default project."),
  max_results: z.number().int().min(1).max(100).default(10),
  start_index: z.number().int().min(0).default(0),
  file_type: z.string().optional().describe(FILE_TYPE_DESC),
  response_format: RESPONSE_FORMAT,
});

export const SearchPatternArgs = z.object({
  pattern: z.string().min(1).refine((p) => { try { new RegExp(p); return true; } catch { return false; } }, { message: "pattern must be a valid regular expression" }).describe("Regular expression pattern to search for"),
  projects: z.array(z.string()).optional().describe("Limit to specific projects"),
  file_type: z.string().optional().describe(FILE_TYPE_DESC),
  max_results: z.number().int().min(1).max(100).default(20).describe("Maximum results to return"),
  response_format: RESPONSE_FORMAT,
});
export type SearchPatternArgs = z.infer<typeof SearchPatternArgs>;

export const FindFileArgs = z.object({
  path_pattern: z.string().min(1, "path_pattern must not be empty").describe("Path pattern (e.g., config.ts, test*.js)"),
  projects: z.array(z.string()).optional(),
  max_results: z.number().int().min(1).max(100).default(10),
  start_index: z.number().int().min(0).default(0),
  response_format: RESPONSE_FORMAT,
});

export const GetFileContentArgs = z.object({
  project: z.string().min(1),
  path: z.string().min(1),
  start_line: z.number().int().min(1).optional().describe("Start line (1-indexed)"),
  end_line: z.number().int().min(1).optional().describe("End line (1-indexed)"),
  response_format: RESPONSE_FORMAT,
});

export const GetFileHistoryArgs = z.object({
  project: z.string().min(1),
  path: z.string().min(1),
  max_entries: z.number().int().min(1).max(50).default(10),
  response_format: RESPONSE_FORMAT,
});

export const BrowseDirectoryArgs = z.object({
  project: z.string().min(1),
  path: z.string().default(""),
  response_format: RESPONSE_FORMAT,
});

export const ListProjectsArgs = z.object({
  filter: z.string().optional().describe("Filter projects by substring or glob pattern (e.g., 'myproject', 'release-*')"),
  response_format: RESPONSE_FORMAT,
});

export const GetFileAnnotateArgs = z.object({
  project: z.string().min(1),
  path: z.string().min(1),
  start_line: z.number().int().min(1).optional().describe("Start line (1-indexed)"),
  end_line: z.number().int().min(1).optional().describe("End line (1-indexed)"),
  response_format: RESPONSE_FORMAT,
});

export const SearchSuggestArgs = z.object({
  query: z.string().min(1),
  project: z.string().optional(),
  field: z.enum(["full", "defs", "refs", "path"]).default("full"),
  response_format: RESPONSE_FORMAT,
});

export const WhatChangedArgs = z.object({
  project: z.string().min(1).describe("Project name"),
  path: z.string().min(1).describe("Path to a specific file (not a directory) relative to project root"),
  since_days: z.number().int().min(1).max(90).default(7).describe("How many days of history to include (1–90, default 7)"),
  response_format: RESPONSE_FORMAT,
});
export type WhatChangedArgs = z.infer<typeof WhatChangedArgs>;

export const DependencyMapArgs = z.object({
  project: z.string().min(1).describe("Project name"),
  path: z.string().min(1).describe("File path relative to project root"),
  depth: z.number().int().min(1).max(3).default(2).describe("How many levels deep to trace (1–3, default 2)"),
  direction: z.enum(["uses", "used_by", "both"]).default("both").describe("Trace what this file uses, what uses it, or both"),
  response_format: RESPONSE_FORMAT,
});
export type DependencyMapArgs = z.infer<typeof DependencyMapArgs>;

export const BlameArgs = z.object({
  project: z.string().min(1).describe("Project name"),
  path: z.string().min(1).describe("File path relative to project root"),
  line_start: z.number().int().min(1).optional().describe("Start line (1-indexed, default 1)"),
  line_end: z.number().int().min(1).optional().describe("End line (inclusive, default: all lines)"),
  include_diff: z.boolean().default(false).describe("Include the commit diff summary for each unique commit"),
  response_format: RESPONSE_FORMAT,
}).superRefine((data, ctx) => {
  if (data.line_start !== undefined && data.line_end !== undefined && data.line_end < data.line_start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "line_end must be >= line_start",
      path: ["line_end"],
    });
  }
});
export type BlameArgs = z.infer<typeof BlameArgs>;

// ---------------------------------------------------------------------------
// Compound tool argument schemas
// ---------------------------------------------------------------------------

export const BatchSearchArgs = z.object({
  queries: z
    .array(
      z.object({
        query: z.string().min(1),
        search_type: z.enum(["full", "defs", "refs", "path", "hist"]).default("full"),
        max_results: z.number().int().min(1).max(25).default(5),
      })
    )
    .min(1)
    .max(5)
    .describe("Search queries to execute in parallel"),
  projects: z.array(z.string()).optional(),
  file_type: z.string().optional().describe(FILE_TYPE_DESC),
  response_format: RESPONSE_FORMAT,
});

export const SearchAndReadArgs = z.object({
  query: z.string().min(1),
  search_type: z.enum(["full", "defs", "refs", "path", "hist"]).default("full"),
  projects: z.array(z.string()).optional(),
  context_lines: z.number().int().min(1).max(50).default(5).describe("Lines of context around each match"),
  max_results: z.number().int().min(1).max(10).default(3),
  file_type: z.string().optional().describe(FILE_TYPE_DESC),
  response_format: RESPONSE_FORMAT,
});

export const GetSymbolContextArgs = z.object({
  symbol: z.string().min(1).describe("Symbol name (class, function, method, etc.)"),
  projects: z.array(z.string()).optional(),
  context_lines: z.number().int().min(5).max(50).default(20).describe("Lines of context around the definition"),
  max_refs: z.number().int().min(1).max(20).default(5),
  include_header: z.boolean().default(true).describe("Also fetch corresponding .h/.hpp if a .cpp definition is found"),
  file_type: z.string().optional().describe(FILE_TYPE_DESC),
  response_format: RESPONSE_FORMAT,
});

export const IndexHealthArgs = z.object({
  response_format: RESPONSE_FORMAT,
});

export const GetCompileInfoArgs = z.object({
  path: z.string().min(1, "path must not be empty").refine(
    (p) => !/[\0\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/.test(p) && !/(^|[/\\])\.\.([/\\]|$)/.test(p) && !/%2e%2e/i.test(p),
    { message: "path contains unsafe traversal sequences" }
  ).describe("Absolute or project-relative path (e.g., GridNode/EventLoop.cpp)."),
  response_format: RESPONSE_FORMAT,
});

export const GetFileSymbolsArgs = z.object({
  project: z.string().min(1).describe("OpenGrok project name"),
  path: z.string().min(1).describe("Path to the file within the project (e.g. GridNode/EventLoop.cpp)"),
  response_format: RESPONSE_FORMAT,
});

export const CallGraphArgs = z.object({
  project: z.string().min(1).describe("OpenGrok project name"),
  symbol: z.string().min(1).describe("Symbol name (function or method name) to get call graph for"),
  response_format: RESPONSE_FORMAT,
});

export const GetFileDiffArgs = z.object({
  project: z.string().min(1).describe("OpenGrok project name"),
  path: z.string().min(1).describe("File path within the project (e.g. src/Foo.cpp)"),
  rev1: z.string().min(1).describe("First (older) revision hash — get from opengrok_get_file_history."),
  rev2: z.string().min(1).describe("Second (newer) revision hash"),
  response_format: RESPONSE_FORMAT,
});

// ---------------------------------------------------------------------------
// Domain model interfaces
// ---------------------------------------------------------------------------

export interface SearchMatch {
  lineNumber: number;
  lineContent: string;
}

export interface SearchResult {
  project: string;
  path: string;
  matches: SearchMatch[];
}

export interface SearchResults {
  query: string;
  searchType: SearchTypeValue;
  totalCount: number;
  timeMs: number;
  results: SearchResult[];
  startIndex: number;
  endIndex: number;
}

export interface HistoryEntry {
  revision: string;
  date: string;
  author: string;
  message: string;
  updateForm?: string;
  mergeRequest?: string;
}

export interface FileHistory {
  project: string;
  path: string;
  entries: HistoryEntry[];
}

export interface FileContent {
  project: string;
  path: string;
  content: string;
  lineCount: number;
  sizeBytes: number;
  startLine?: number;
}

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
  path: string;
  size?: number;
  lastModified?: string;
}

export interface Project {
  name: string;
  category?: string;
  description?: string;
}

export interface AnnotateLine {
  lineNumber: number;
  revision: string;
  author: string;
  date: string;
  content: string;
}

export interface AnnotatedFile {
  project: string;
  path: string;
  lines: AnnotateLine[];
}

export interface FileSymbol {
  symbol: string;
  type: string;
  signature: string | null;
  line: number;
  lineStart: number;
  lineEnd: number;
  namespace: string | null;
}

export interface FileSymbols {
  project: string;
  path: string;
  symbols: FileSymbol[];
}

export interface DiffLine {
  /** 'added' = new line (+), 'removed' = old line (-), 'context' = unchanged */
  type: 'added' | 'removed' | 'context';
  oldLineNumber?: number;
  newLineNumber?: number;
  /** Raw line content (no +/- prefix) */
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface FileDiff {
  project: string;
  path: string;
  rev1: string;
  rev2: string;
  /** Structured list of change hunks */
  hunks: DiffHunk[];
  /** Standard unified diff string (git-diff compatible) */
  unifiedDiff: string;
  stats: { added: number; removed: number };
}

// ---------------------------------------------------------------------------
// Structured output schemas (Phase 4 — priority tools)
// ---------------------------------------------------------------------------

const SearchMatchSchema = z.object({
  lineNumber: z.number(),
  lineContent: z.string(),
});

const SearchResultSchema = z.object({
  project: z.string(),
  path: z.string(),
  matches: z.array(SearchMatchSchema),
});

/** Output schema for opengrok_search_code */
export const SearchResultsOutput = z.object({
  query: z.string(),
  searchType: z.string(),
  totalCount: z.number(),
  timeMs: z.number(),
  results: z.array(SearchResultSchema),
  startIndex: z.number(),
  endIndex: z.number(),
  hasMore: z.boolean(),
  nextOffset: z.number().optional(),
});

/** Output schema for opengrok_get_file_content */
export const FileContentOutput = z.object({
  project: z.string(),
  path: z.string(),
  content: z.string(),
  lineCount: z.number(),
  sizeBytes: z.number(),
  startLine: z.number().optional(),
});

/** Output schema for opengrok_list_projects */
export const ProjectsListOutput = z.object({
  projects: z.array(
    z.object({
      name: z.string(),
      category: z.string().optional(),
      description: z.string().optional(),
    })
  ),
  total: z.number(),
});

const BatchQueryResultSchema = z.object({
  query: z.string(),
  searchType: z.string(),
  results: z.object({
    query: z.string(),
    searchType: z.string(),
    totalCount: z.number(),
    timeMs: z.number(),
    results: z.array(SearchResultSchema),
    startIndex: z.number(),
    endIndex: z.number(),
  }),
});

/** Output schema for opengrok_batch_search */
export const BatchSearchOutput = z.object({
  queryResults: z.array(BatchQueryResultSchema),
});

/** Output schema for opengrok_get_symbol_context */
export const SymbolContextOutput = z.object({
  found: z.boolean(),
  symbol: z.string(),
  kind: z.string(),
  definition: z
    .object({
      project: z.string(),
      path: z.string(),
      line: z.number(),
      context: z.string(),
      lang: z.string(),
    })
    .optional(),
  header: z
    .object({
      project: z.string(),
      path: z.string(),
      context: z.string(),
      lang: z.string(),
    })
    .optional(),
  references: z.object({
    totalFound: z.number(),
    samples: z.array(
      z.object({
        path: z.string(),
        project: z.string(),
        lineNumber: z.number(),
        content: z.string(),
      })
    ),
  }),
  fileSymbols: z
    .array(
      z.object({
        symbol: z.string(),
        type: z.string(),
        line: z.number(),
      })
    )
    .optional(),
});

const MetaSchema = z.object({
  tool: z.string(),
  project: z.string().optional(),
  path: z.string().optional(),
  fetchedAt: z.string(),
  version: z.string(),
});

/** Output schema for opengrok_get_file_history */
export const FileHistoryOutput = z.object({
  _meta: MetaSchema,
  entries: z.array(
    z.object({
      revision: z.string(),
      author: z.string(),
      date: z.string(),
      message: z.string(),
    })
  ),
});

/** Output schema for opengrok_get_file_symbols */
export const FileSymbolsOutput = z.object({
  _meta: MetaSchema,
  symbols: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      line: z.number(),
    })
  ),
});

/** Output schema for opengrok_what_changed */
export const WhatChangedOutput = z.object({
  _meta: MetaSchema,
  changes: z.array(
    z.object({
      commit: z.string(),
      author: z.string(),
      date: z.string(),
      lines: z.array(z.number()),
    })
  ),
});

/** Output schema for opengrok_dependency_map */
export const DependencyMapOutput = z.object({
  _meta: MetaSchema,
  nodes: z.array(
    z.object({
      path: z.string(),
      level: z.number(),
      direction: z.enum(["uses", "used_by"]),
    })
  ),
});

/** Output schema for opengrok_blame */
export const BlameLineEntry = z.object({
  line: z.number(),
  commit: z.string(),
  author: z.string(),
  date: z.string(),
  content: z.string(),
});

export const BlameOutput = z.object({
  _meta: MetaSchema,
  entries: z.array(BlameLineEntry),
});

/** Output schema for opengrok_get_file_diff */
export const FileDiffOutput = z.object({
  _meta: z.object({
    tool: z.string(),
    project: z.string(),
    path: z.string(),
    rev1: z.string(),
    rev2: z.string(),
    fetchedAt: z.string(),
    version: z.string(),
  }),
  stats: z.object({
    linesAdded: z.number(),
    linesRemoved: z.number(),
  }).optional(),
  hunks: z.array(
    z.object({
      oldStart: z.number(),
      oldCount: z.number(),
      newStart: z.number(),
      newCount: z.number(),
      lines: z.number(),
    })
  ),
});

/** Output schema for opengrok_call_graph */
export const CallGraphOutput = z.object({
  _meta: z.object({
    tool: z.string(),
    project: z.string(),
    symbol: z.string(),
    fetchedAt: z.string(),
    version: z.string(),
  }),
  results: z.array(
    z.object({
      file: z.string(),
      project: z.string(),
      lines: z.array(
        z.object({
          number: z.number(),
          content: z.string(),
        })
      ),
    })
  ),
});
