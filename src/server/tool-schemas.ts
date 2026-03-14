/**
 * Tool definitions for MCP — generated from Zod schemas (single source of truth).
 * Descriptions are hand-written; inputSchema is derived from the Zod schemas in models.ts.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import {
  SearchCodeArgs,
  FindFileArgs,
  GetFileContentArgs,
  GetFileHistoryArgs,
  BrowseDirectoryArgs,
  ListProjectsArgs,
  GetFileAnnotateArgs,
  SearchSuggestArgs,
  BatchSearchArgs,
  SearchAndReadArgs,
  GetSymbolContextArgs,
  IndexHealthArgs,
  GetCompileInfoArgs,
  GetFileSymbolsArgs,
} from "./models.js";

/**
 * Convert a Zod schema to a JSON Schema object suitable for MCP tool inputSchema.
 * Strips the top-level $schema and additionalProperties keys that MCP doesn't need.
 */
function toInputSchema(schema: ZodTypeAny): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zodToJsonSchema generic is excessively deep
  const raw = zodToJsonSchema(schema as any, { target: "openApi3" }) as Record<string, unknown>;
  delete raw.$schema;
  delete raw.additionalProperties;
  return raw;
}

export const TOOL_DEFINITIONS = [
  // ------------------------------------------------------------------
  // Core tools
  // ------------------------------------------------------------------
  {
    name: "search_code",
    description:
      "Search OpenGrok. Types: full (text), defs (definitions), refs (references), path (filenames), hist (commit messages). Prefer defs/refs for known symbol names. Use batch_search for multiple queries.",
    inputSchema: toInputSchema(SearchCodeArgs),
  },
  {
    name: "find_file",
    description: "Find files by name/path pattern across the codebase.",
    inputSchema: toInputSchema(FindFileArgs),
  },
  {
    name: "get_file_content",
    description:
      "Get file contents. ALWAYS pass start_line/end_line — never fetch full files. Use search_code first to find line numbers. For full symbol context use get_symbol_context.",
    inputSchema: toInputSchema(GetFileContentArgs),
  },
  {
    name: "get_file_history",
    description: "Commit history for a file.",
    inputSchema: toInputSchema(GetFileHistoryArgs),
  },
  {
    name: "browse_directory",
    description: "List files/subdirectories at a path.",
    inputSchema: toInputSchema(BrowseDirectoryArgs),
  },
  {
    name: "list_projects",
    description: "List indexed OpenGrok projects.",
    inputSchema: toInputSchema(ListProjectsArgs),
  },
  {
    name: "get_file_annotate",
    description: "Blame annotations (who changed each line). Use start_line/end_line to limit output.",
    inputSchema: toInputSchema(GetFileAnnotateArgs),
  },
  {
    name: "search_suggest",
    description: "Autocomplete suggestions for a partial query.",
    inputSchema: toInputSchema(SearchSuggestArgs),
  },
  // ------------------------------------------------------------------
  // Compound tools (high efficiency — use these first)
  // ------------------------------------------------------------------
  {
    name: "batch_search",
    description:
      "Execute up to 5 searches in parallel in one call. Always prefer this over multiple search_code calls for the same investigation.",
    inputSchema: toInputSchema(BatchSearchArgs),
  },
  {
    name: "search_and_read",
    description:
      "Search and return matching code with surrounding context in one call. Use instead of search_code + get_file_content. Never fetches full files.",
    inputSchema: toInputSchema(SearchAndReadArgs),
  },
  {
    name: "get_symbol_context",
    description:
      "Complete symbol investigation in one call: definition with context + corresponding header + references. Use this first for any unknown C++ symbol or function.",
    inputSchema: toInputSchema(GetSymbolContextArgs),
  },
  {
    name: "index_health",
    description: "OpenGrok server connection status and diagnostics. Call if results seem stale or incomplete.",
    inputSchema: toInputSchema(IndexHealthArgs),
  },
  {
    name: "get_compile_info",
    description:
      "Get compilation details for a source file: compiler, include paths, preprocessor defines, and language standard. Requires compile_commands.json to be present in the workspace.",
    inputSchema: toInputSchema(GetCompileInfoArgs),
  },
  {
    name: "get_file_symbols",
    description:
      "List all symbols defined in a file: functions, classes, structs, macros with line numbers and signatures. Use this to understand a file's structure before reading it.",
    inputSchema: toInputSchema(GetFileSymbolsArgs),
  },
];
