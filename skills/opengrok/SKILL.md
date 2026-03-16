---
name: opengrok
description: >
  Use this skill whenever the user wants to search, navigate, or understand
  source code in a large codebase — even when they don't say "OpenGrok".
  Trigger for: finding where a function or class is defined, tracking where
  something is called or referenced, reading a remote source file, checking
  who last changed a line (blame/annotate), browsing a directory tree,
  exploring commit history, or comparing code across projects. Activate when
  the user says "search the codebase", "find where X is defined", "who changed
  this", "show me the source for", "look up that function", or mentions
  cross-referencing or OpenGrok by name. If the target code lives on a remote
  server or indexed repository rather than locally, this skill applies.
---

# OpenGrok Skill

> **OpenGrok** is Oracle's open-source, Lucene-powered source code search and
> cross-reference engine. It indexes 30+ programming languages via Universal
> Ctags, integrates with Git/Mercurial/SVN/CVS/SCCS/Perforce, and serves a REST
> API for full-text, definition, reference, path, and history searches across
> multi-project codebases. All tools in this MCP server carry the `opengrok_`
> prefix.
>
> **When not to use:** If the target files are already on the local filesystem,
> use standard file tools instead — these tools are for remote or indexed
> codebases.

## Quick Start

Find where `EventLoop` is defined and who calls it — one call does it all:

```json
{
  "tool": "opengrok_get_symbol_context",
  "arguments": {
    "symbol": "EventLoop",
    "file_type": "cxx",
    "context_lines": 20,
    "max_refs": 10,
    "include_header": true
  }
}
```

Returns the definition source, surrounding context, reference locations, and the
matching `.h`/`.hpp` header — replacing 3+ separate tool calls.

## Tool Selection

Pick the right tool for the job — compound tools save 75–92 % of tokens compared
to chaining individual calls.

### Start Here (Compound Tools)

| Goal | Tool | Why |
|------|------|-----|
| Understand a symbol (definition + context + references) | `opengrok_get_symbol_context` | Replaces 3 separate calls. Returns definition source, surrounding context, and reference locations in one shot. Set `include_header: true` for C/C++ to also fetch the matching `.h`/`.hpp`. |
| Search and immediately read matching files | `opengrok_search_and_read` | Replaces search → read chains. Returns search hits with inline file content. Use `context_lines` (1–50, default 10) to control how much surrounding code is shown. |
| Run multiple search queries at once | `opengrok_batch_search` | Replaces sequential `opengrok_search_code` calls. Pass up to 5 queries in a `queries` array (max 25 results per query). `file_type` is top-level, not per-query. |
| Check if OpenGrok is reachable | `opengrok_index_health` | Quick connectivity and index status diagnostic. |

### Individual Tools

| Goal | Tool |
|------|------|
| Full-text, definition, reference, path, or commit message search | `opengrok_search_code` |
| Find files by name or path pattern | `opengrok_find_file` |
| Read file contents (always pass `start_line`/`end_line`) | `opengrok_get_file_content` |
| File commit history | `opengrok_get_file_history` |
| List directory contents | `opengrok_browse_directory` |
| List all accessible projects | `opengrok_list_projects` |
| Git blame / annotate with optional line range | `opengrok_get_file_annotate` |
| List top-level symbols in a file (functions, classes, macros) | `opengrok_get_file_symbols` |
| Autocomplete suggestions for partial queries | `opengrok_search_suggest` |
| Compiler flags and include paths (requires local `compile_commands.json`) | `opengrok_get_compile_info` |

> **`opengrok_find_file` vs `search_type: "path"`:** Use `find_file` for
> filename/glob patterns (e.g., `config.ts`, `test*.js`). Use `opengrok_search_code`
> with `search_type: "path"` for full path string searches that benefit from
> Lucene syntax (e.g., `+src -test`).
>
> **`project` vs `projects`:** File-level tools (`get_file_content`,
> `get_file_history`, `browse_directory`, `get_file_annotate`, `get_file_symbols`)
> take a single `project: string`. Search tools (`search_code`, `search_and_read`,
> `batch_search`, `get_symbol_context`) take `projects: string[]` — omit the
> field to use the server default project.

## Search Types

`opengrok_search_code` supports these `search_type` values:

| Type | When to use |
|------|-------------|
| `full` | General text search — grep-like, matches anywhere in file content |
| `defs` | Find where a symbol is **defined** (function, class, variable declaration). Prefer this for known symbol names. |
| `refs` | Find where a symbol is **referenced** (called, imported, used). |
| `path` | Search file paths/names. |
| `hist` | Search commit messages and changelogs. |

For known symbol names (CamelCase, snake_case identifiers), always prefer `defs` or `refs` over `full` — they use the Ctags symbol index and are faster and more precise.

## Query Syntax

OpenGrok uses Lucene query syntax under the hood. These patterns work in the `query` parameter of `opengrok_search_code`, `opengrok_search_and_read`, `opengrok_batch_search`, and `opengrok_get_symbol_context`:

| Pattern | Example | Meaning |
|---------|---------|---------|
| Plain word | `EventLoop` | Matches any occurrence of the term |
| `"exact phrase"` | `"thread pool"` | Matches the exact phrase |
| `+required -excluded` | `+init -test` | Must contain `init`, must not contain `test` |
| Wildcard `*` | `get*Config` | Matches zero or more characters |
| Wildcard `?` | `nod?` | Matches exactly one character |
| Boolean `AND` / `OR` | `EventLoop AND destroy` | Combine terms logically |

> **Note:** Wildcards and boolean operators work inside the `query` string. Do
> not confuse them with `search_type` — the type selects which Lucene field
> (full text, definitions, references, path, history) is searched.

## Narrowing Results

### file_type filter

These tools accept an optional `file_type` to restrict results by language:
- `opengrok_search_code`
- `opengrok_batch_search`
- `opengrok_search_and_read`
- `opengrok_get_symbol_context`

Common values: `c`, `cxx` (C++), `java`, `python`, `javascript`, `typescript`, `csharp`, `golang`, `ruby`, `perl`, `php`, `scala`, `kotlin`, `swift`, `rust`, `sql`, `xml`, `json`, `yaml`, `shell`, `makefile`

### response_format

All 14 tools accept `response_format`:
- `"markdown"` (default) — human-readable, optimized for LLM consumption
- `"json"` — structured output for programmatic use

### Line ranges

Always pass `start_line` and `end_line` to `opengrok_get_file_content`. Never fetch a full file — it wastes tokens and may hit the response cap.

### Pagination

`opengrok_search_code`, `opengrok_search_and_read`, and `opengrok_batch_search` support pagination. JSON responses include `hasMore` and `nextOffset`. Pass `nextOffset` as the `start_index` parameter to fetch the next page.


## Gotchas

1. **Fetch files with targeted line ranges.** Without `start_line`/`end_line`, `opengrok_get_file_content` hits the 16 KB response cap and truncates — wasting tokens and losing data. Use `opengrok_get_file_symbols` first to find interesting functions or classes, then read specific ranges.

2. **`opengrok_batch_search` queries structure.** Pass queries as a top-level `queries` array (max 5). The `file_type` filter is top-level, not per-query. Each query object has its own `search_type` and `query`.

3. **`opengrok_list_projects` filter is substring match.** Passing `"release"` matches `release-1.0`, `release-2.0`, etc. Omit the filter to list all projects.

4. **Responses are capped.** Default 16 KB (configurable via `OPENGROK_MAX_RESPONSE_BYTES`). If results are truncated, narrow your query with `file_type`, specific projects, smaller `max_results`, or line ranges.

5. **Use the configured default project.** Unless the user specifies a different project, use whatever project is configured. Don't prompt for project selection unnecessarily.

6. **`opengrok_get_file_annotate` supports line ranges.** Pass `start_line`/`end_line` to avoid fetching blame for entire large files.

7. **`opengrok_search_suggest` is for autocomplete only.** It returns partial matches for UI-style suggestions, not full search results. Use `opengrok_search_code` for actual searches.

8. **`opengrok_get_compile_info` requires local layer.** This only works when `compile_commands.json` is configured via `OPENGROK_LOCAL_COMPILE_DB_PATHS`. It returns compiler flags, include paths, defines, and language standard for a source file.

9. **`opengrok_get_symbol_context` has `include_header`.** For C/C++ codebases, set `include_header: true` (default) to automatically fetch the matching `.h`/`.hpp` file alongside a `.cpp` definition — saves an extra read call.

10. **All tools are read-only.** Every tool has `readOnlyHint: true` and `destructiveHint: false`. They never modify the OpenGrok index or source files.

## Error Recovery

| Error | Next step |
|-------|-----------|
| Connection failed / timeout | Run `opengrok_index_health` to diagnose. Check if `OPENGROK_BASE_URL` is reachable. |
| 401 Unauthorized | Credentials are wrong or expired. User needs to reconfigure via `OpenGrok: Configure Credentials`. |
| 403 Forbidden | User doesn't have access to the requested project. Try a different project or check permissions. |
| Empty search results | Try broader terms, switch `search_type` (e.g., `full` instead of `defs`), remove `file_type` filter, or check project name. |
| Response truncated | Narrow query: add `file_type`, reduce `max_results`, use line ranges for file reads. |
| "Path traversal not allowed" | File path contains `..` or encoded traversal sequences. Use clean relative paths from search results. |

## Workflow Patterns

### "Exploring an unfamiliar project for the first time"

*Step 1* — list available projects:
```json
{ "tool": "opengrok_list_projects", "arguments": {} }
```

*Step 2* — browse the directory tree:
```json
{ "tool": "opengrok_browse_directory", "arguments": { "project": "myproj", "path": "src" } }
```

*Step 3* — once you find an interesting file, see its symbols before reading it:
```json
{ "tool": "opengrok_get_file_symbols", "arguments": { "project": "myproj", "path": "src/Server.java" } }
```

### "Known symbol name — find definition + all call sites"

Use `opengrok_get_symbol_context` — see the Quick Start example at the top of this skill.

### "Search for pattern and show me the code"
```json
{
  "tool": "opengrok_search_and_read",
  "arguments": {
    "query": "\"thread pool\" AND init",
    "search_type": "full",
    "file_type": "java",
    "context_lines": 15,
    "max_results": 5
  }
}
```
Returns search hits with inline file content.

### "Compare how X is used across projects"
```json
{
  "tool": "opengrok_batch_search",
  "arguments": {
    "queries": [
      { "query": "handleRequest", "search_type": "refs" },
      { "query": "handleRequest", "search_type": "defs" }
    ],
    "file_type": "java"
  }
}
```

### "Understand a file's structure before diving in"

*Step 1* — see all symbols:
```json
{ "tool": "opengrok_get_file_symbols", "arguments": { "project": "myproj", "path": "src/EventLoop.cpp" } }
```

*Step 2* — read the interesting function:
```json
{ "tool": "opengrok_get_file_content", "arguments": { "project": "myproj", "path": "src/EventLoop.cpp", "start_line": 42, "end_line": 90 } }
```

### "Check recent changes to a file"

*Step 1* — see commit history:
```json
{ "tool": "opengrok_get_file_history", "arguments": { "project": "myproj", "path": "src/EventLoop.cpp", "max_entries": 10 } }
```

*Step 2* — blame a suspicious region:
```json
{ "tool": "opengrok_get_file_annotate", "arguments": { "project": "myproj", "path": "src/EventLoop.cpp", "start_line": 100, "end_line": 130 } }
```

### "Find all config files across the codebase"
```json
{
  "tool": "opengrok_search_code",
  "arguments": {
    "query": "*.config.*",
    "search_type": "path",
    "max_results": 20
  }
}
```
