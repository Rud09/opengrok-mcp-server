/**
 * Data models and Zod validation schemas for OpenGrok MCP Server.
 */

import { z } from "zod";

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
});

export const FindFileArgs = z.object({
  path_pattern: z.string().min(1, "path_pattern must not be empty").describe("Path pattern (e.g., config.ts, test*.js)"),
  projects: z.array(z.string()).optional(),
  max_results: z.number().int().min(1).max(100).default(10),
  start_index: z.number().int().min(0).default(0),
});

export const GetFileContentArgs = z.object({
  project: z.string().min(1),
  path: z.string().min(1),
  start_line: z.number().int().min(1).optional().describe("Start line (1-indexed)"),
  end_line: z.number().int().min(1).optional().describe("End line (1-indexed)"),
});

export const GetFileHistoryArgs = z.object({
  project: z.string().min(1),
  path: z.string().min(1),
  max_entries: z.number().int().min(1).max(50).default(10),
});

export const BrowseDirectoryArgs = z.object({
  project: z.string().min(1),
  path: z.string().default(""),
});

export const ListProjectsArgs = z.object({
  filter: z.string().optional().describe("Filter projects by substring or glob pattern (e.g., 'myproject', 'release-*')"),
});

export const GetFileAnnotateArgs = z.object({
  project: z.string().min(1),
  path: z.string().min(1),
  start_line: z.number().int().min(1).optional().describe("Start line (1-indexed)"),
  end_line: z.number().int().min(1).optional().describe("End line (1-indexed)"),
});

export const SearchSuggestArgs = z.object({
  query: z.string().min(1),
  project: z.string().optional(),
  field: z.enum(["full", "defs", "refs", "path"]).default("full"),
});

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
});

export const SearchAndReadArgs = z.object({
  query: z.string().min(1),
  search_type: z.enum(["full", "defs", "refs", "path", "hist"]).default("full"),
  projects: z.array(z.string()).optional(),
  context_lines: z.number().int().min(1).max(50).default(10).describe("Lines of context around each match"),
  max_results: z.number().int().min(1).max(10).default(3),
  file_type: z.string().optional().describe(FILE_TYPE_DESC),
});

export const GetSymbolContextArgs = z.object({
  symbol: z.string().min(1).describe("Symbol name (class, function, method, etc.)"),
  projects: z.array(z.string()).optional(),
  context_lines: z.number().int().min(5).max(50).default(20).describe("Lines of context around the definition"),
  max_refs: z.number().int().min(1).max(20).default(5),
  include_header: z.boolean().default(true).describe("Also fetch corresponding .h/.hpp if a .cpp definition is found"),
  file_type: z.string().optional().describe(FILE_TYPE_DESC),
});

export const IndexHealthArgs = z.object({});

export const GetCompileInfoArgs = z.object({
  path: z.string().min(1, "path must not be empty").describe("Source file path. Accepts absolute paths or OpenGrok-relative paths (e.g., GridNode/EventLoop.cpp)."),
});

export const GetFileSymbolsArgs = z.object({
  project: z.string().min(1).describe("OpenGrok project name"),
  path: z.string().min(1).describe("Path to the file within the project (e.g. GridNode/EventLoop.cpp)"),
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
