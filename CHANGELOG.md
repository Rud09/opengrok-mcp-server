# Changelog

All notable changes to the OpenGrok MCP extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Highlights

### 🚀 v6.0 — Enterprise MCP: HTTP Transport, OAuth 2.1 & RBAC

Streamable HTTP transport for team deployments, OAuth 2.1 with `client_credentials` grant, role-based access control (admin/developer/readonly), OpenGrok API v2 support, and full MCP 2025-06-18 spec compliance: structured tool output (`outputSchema` + `structuredContent`), MCP Resources, Prompts, Elicitation, and Sampling. **26 tools total, 893 tests.**

- 🔍 **v6.1** — `opengrok_get_file_diff` (tool 26): unified diff with context lines via `?format=u` HTML parsing; Code Mode `return_rules` micro-optimizations; typed `CodeModeAnnotations` for interleaved thinking.

### 🧬 v5.0 — Code Mode: Pure-WASM Sandbox + Token Optimization

Code Mode sandbox built on `@sebastianwessel/quickjs` — pure JS + WASM, zero native compilation, no `node-gyp`, works everywhere including `npx` and enterprise Linux. Full token optimization suite: three context budget tiers, compact TSV/YAML/text formats, Living Document memory bank, and session observation masker for long investigations.

- 🔬 **v5.6** — MCP SDK 1.28.0, `outputSchema` + `structuredContent` on 10 tools, MCP Resources/Prompts/Elicitation/Sampling, `opengrok_blame`, per-tool rate limiting, structured audit logging, sandbox sanitization.
- ⚡ **v5.5** — Sandbox worker pool, 4 new tools (`opengrok_what_changed`, `opengrok_dependency_map`, `opengrok_search_pattern`, enhanced `opengrok_index_health`), C++ specialized skill (489 lines), TSV batch format.
- 🗃️ **v5.4** — 2-file memory bank (active-task.md + investigation-log.md), rewritten SERVER_INSTRUCTIONS, `opengrok_memory_status` tool, compact Code Mode descriptions, new session/investigation skills.
- 🐛 **v5.3.2** — P0 bug fixes: activation events, ObservationMasker injection layer, SERVER_INSTRUCTIONS dead references, UI polish.

### 🏗️ v4.0 — Modern MCP SDK & Breaking Tool Rename

McpServer high-level API, `opengrok_` prefixed tool names, tool annotations, structured output, `response_format` parameter, security hardening. Full protocol compliance.

### 🧠 v3.0 — Code Intelligence Engine

6 new compound tools, ~92% fewer tokens, full OpenGrok 1.7.x support, and a zero-config local source layer that knows your compiler flags. The largest update since the original rewrite.

- 🚀 **v3.1** — Auto-update notifications. One click in VS Code, no manual downloads.
- 🌐 **v3.2** — Standalone MCP server. One-command installer, cross-platform credential wrappers, no VS Code required.
- 🛡️ **v3.3** — Security hardening, 100% code coverage, Node 24, enterprise-grade quality. 476 tests, zero audit findings.

### 🔐 v2.0 — Full TypeScript Rewrite

Native MCP integration, OS keychain credentials, 8 OpenGrok tools, SSRF protection, and 45 unit tests. The foundation everything else is built on.

- 🎨 **v2.1** — Brand-new Configuration Manager UI. Dark/light mode, auto-test on save, no more setup prompts.

---

## [6.1.0] - 2026-03-28

### 🔍 New Tool: `opengrok_get_file_diff`

- **`opengrok_get_file_diff`** (tool 26): fetch the unified diff between any two revisions of a file
- Parses OpenGrok's `?format=u` unified HTML endpoint — includes **context lines** around every change so AI can understand what function/scope was modified
- Each hunk contains context lines (`type: "context"`), deleted lines (`type: "removed"`, `oldLineNumber`), and added lines (`type: "added"`, `newLineNumber`)
- Output includes a standard `--- a/... +++ b/...` unified diff string with `@@` hunk headers for direct AI consumption
- Structured JSON output: `hunks[]`, `stats.added`, `stats.removed`, `unifiedDiff`
- Available in both standard mode and Code Mode sandbox (`env.opengrok.getFileDiff(project, path, rev1, rev2)`)

### 🧬 Code Mode Improvements

- **`return_rules`** added to Code Mode `API_SPEC`: three micro-optimization rules directing sandbox scripts to return structured objects with `result` + `summary` fields, keep responses under 2 KB, and avoid re-fetching data within a session
- Fixed `readMemory.allowed` in `API_SPEC` — corrected to the actual 2-file list (`active-task.md | investigation-log.md`) instead of the stale 6-file list

### 🔧 Type Safety

- **`CodeModeAnnotations`** type alias (`ToolAnnotations & { "x-supports-interleaving": true }`) replaces unsafe `as ToolAnnotations` casts on Code Mode tool registrations — TypeScript now correctly models the interleaved thinking annotation

### 📈 Stats

- Tests: 861 → **893** (+32 tests; 37 test files)
- Tools: 25 → **26** (`opengrok_get_file_diff`)

---

## [6.0.0] - 2026-03-28

### 🌐 HTTP Streamable Transport

- **Streamable HTTP transport** (`OPENGROK_HTTP_PORT`): run `npm run serve` or set `OPENGROK_HTTP_PORT=3666` to expose an HTTP endpoint alongside stdio
- Per-session isolated `McpServer` instances via factory pattern — each HTTP client gets its own server context
- Session TTL (30 min default) with background sweep, configurable cap via `OPENGROK_HTTP_MAX_SESSIONS`
- `GET /mcp/sessions` endpoint returns active session stats (count, oldest session age)
- CORS headers and `OPTIONS` preflight support for browser-based MCP clients

### 🔐 OAuth 2.1 Authentication

- Bearer token auth via `OPENGROK_HTTP_AUTH_TOKEN`
- `client_credentials` grant flow with `OPENGROK_HTTP_CLIENT_ID` / `OPENGROK_HTTP_CLIENT_SECRET`
- RFC 8414 discovery document at `/.well-known/oauth-authorization-server`
- RFC 8252 loopback CORS relaxation for native app clients (leverages MCP SDK 1.28.0)
- 401 and 403 responses are fully JSON-RPC 2.0 compliant — no custom error formats

### 👥 Role-Based Access Control (RBAC)

- Three roles: `admin` / `developer` / `readonly` — configured via `OPENGROK_RBAC_TOKENS='tok1:admin,tok2:readonly'`
- **Fail-safe**: unknown or missing tokens default to `readonly` (not `admin`)
- Permission matrix: admin = full access; developer = all tools except RBAC config; readonly = search/read tools only
- RBAC enforced at the HTTP transport layer before tool dispatch

### 🔧 New Tool

- **`opengrok_call_graph`**: traces call chains from a symbol using OpenGrok API v2 `/symbol/{name}/callgraph` endpoint; includes `outputSchema` for structured output and graceful v1 fallback on 404

### 🗄️ OpenGrok API v2

- `OPENGROK_API_VERSION=v2` — all five HTTP client methods (`searchCode`, `getFileContent`, `getFileHistory`, `getFileAnnotate`, `getFileSymbols`) use the configurable `apiPath`; defaults to `/api/v1` for backward compatibility
- `opengrok_call_graph` uses the v2-only `/api/v2/symbol/{name}/callgraph` endpoint with automatic v1 fallback

### 🏢 Enterprise Features

- **FileReferenceCache** (`OPENGROK_ENABLE_FILES_API`): SHA-256 content-addressed cache for `investigation-log.md` reduces repeated read costs
- **Audit log export** (`OPENGROK_AUDIT_LOG_FILE`): structured audit trail written to file in CSV or JSON format; `export-audit` CLI subcommand
- **MCP Completions infrastructure**: project-name autocomplete for all project-scoped parameters (active; full `Completable` field support pending MCP SDK v2)
- **Production MCP Sampling**: `sampleOrNull()` wrapper with retry/backoff, 10 s timeout, model preference via `OPENGROK_SAMPLING_MODEL` / `OPENGROK_SAMPLING_MAX_TOKENS`, SHA-256-based deduplication cache
- **Interleaved thinking** (`x-supports-interleaving` annotation) on `opengrok_api` and `opengrok_execute` Code Mode tools
- **AI-powered index health prediction**: `opengrok_index_health` now returns `stalenessScore` and `latencyTrend` computed from recent search hit rates and index age

### 🐛 Bug Fixes (Quality Review)

- `extractRole()` now defaults to `readonly` instead of `admin` for unknown/missing tokens — critical security fix
- HTTP 403 responses are now JSON-RPC 2.0 format (`{"jsonrpc":"2.0","error":{"code":-32603,...}}`)
- All 5 HTTP client methods now use `this.apiPath` (was silently hardcoded to `/api/v1`)
- Sampling periodic cleanup timer properly cancelled on server close, preventing memory leaks
- SHA-256 upgrade for FileReferenceCache (replaced weak hash)
- `SessionMetadata.role` typed as `Role` instead of `string`
- Dead CORS ternary removed from HTTP transport options

### 📈 Stats

- Tests: 773 → **861** (+88 tests, 42 test files)
- New files: `src/server/http-transport.ts`, `src/server/rbac.ts`, `src/server/file-cache.ts`

### ⚠️ MCP SDK v2 Readiness

This version uses `@modelcontextprotocol/sdk` v1.28.0. MCP SDK v2 is in pre-alpha; we will migrate when stable (expected Q3–Q4 2026). Migration will involve enhanced `Completable` fields, resource template URI variables, and updated method names. A migration guide will be published at release time.

---

## [5.6.0] - 2026-03-27

### 🔬 MCP SDK 1.28.0 Upgrade

- Upgraded `@modelcontextprotocol/sdk` to `1.28.0` (pinned) — the first version with full structured output support
- Added Zod schema validation CI test for `inputSchema` rejection of plain JSON schema objects
- RFC 8252 loopback port relaxation now available for future HTTP transport (Phase 5)

### 📊 Structured Tool Output (MCP 2025-06-18 spec)

All major tools now return both `content` (markdown for LLM) and `structuredContent` (typed JSON for clients):
- `opengrok_index_health` → `IndexHealthOutput` schema (connected, latencyMs, indexedProjects, warnings, stalenessScore)
- `opengrok_memory_status` → `MemoryStatusOutput` schema (files array with name, status, bytes, preview)
- `opengrok_blame` → `BlameOutput` schema (lines with author, date, commit, content)
- `opengrok_what_changed` → `WhatChangedOutput` schema (commits with files and line changes)
- `opengrok_dependency_map` → `DependencyMapOutput` schema (nodes with edges, depth, direction)
- `opengrok_search_pattern` → `SearchPatternOutput` schema (matches with file, line, context)
- `opengrok_batch_search` → `BatchSearchOutput` schema (per-query results with dedup metadata)
- `opengrok_get_symbol_context` → `SymbolContextOutput` schema (definition, references, file content)
- `opengrok_get_file_history` → `FileHistoryOutput` schema
- `opengrok_call_graph` → `CallGraphOutput` schema
- All tools include `_meta` enrichment: `latencyMs`, `cacheHit`, `stalenessHint`
- Resource links (`resource_link` type) in file-returning tool results for lazy-loading via MCP Resources

### 📁 MCP Resources

- `opengrok-memory://active-task.md` and `opengrok-memory://investigation-log.md` registered as readable MCP Resources
- Clients can `resources/read` memory files directly without going through tool calls
- Resource `scopes_supported` declared for access control (leverages MCP SDK 1.28.0 metadata)

### 💬 MCP Prompts

Three reusable investigation prompts registered:
- `investigate-symbol` — systematic symbol investigation workflow (search → read → refs → blame)
- `find-feature` — feature location across project (batch search → dependency map → history)
- `review-file` — file quality review (symbols → history → annotate → blame)

### ❓ MCP Elicitation

- `OPENGROK_ENABLE_ELICITATION=true` enables project picker when no project is specified and >1 project exists
- Uses `server.elicitInput()` with graceful fallback for clients that don't support elicitation
- Form schema: radio selector for project name from `opengrok_list_projects`

### 🤖 MCP Sampling

- `sampleOrNull()` wrapper calls `server.createMessage()` for two use cases:
  1. **Error explanation**: translates cryptic sandbox errors into plain English
  2. **Graph summarization**: converts large dependency maps into readable summaries
- Graceful no-op when client doesn't support sampling capability
- Respects `OPENGROK_SAMPLING_MODEL` and `OPENGROK_SAMPLING_MAX_TOKENS` config

### 🔔 tools/list_changed Notification

- Server sends `notifications/tools/list_changed` when Code Mode is toggled via SIGHUP config reload
- Background connectivity polling every 5 minutes — notifies clients if server becomes unreachable
- `OPENGROK_HTTP_PORT` config changes trigger notification to reload available tools

### 🔨 New Tools

- **`opengrok_blame`**: full git blame with line range (`start_line`/`end_line`), author/date/commit per line, `outputSchema` with `BlameOutput`, `_meta` field, resource link to file
- **`opengrok_get_task_result`**: polls async task status by task ID (for long-running `opengrok_execute` sandbox jobs); returns `pending` / `running` / `done` / `failed` states

### 🔒 Security

- **Sandbox error sanitization**: strips file system paths, Node.js stack frames, and internal module names from QuickJS errors before returning to LLM
- **Structured audit logging**: all 22 tool invocations emit structured JSON to stderr (`{"audit":true,"type":"tool_invoke","tool":"...","durationMs":...}`); optionally written to `OPENGROK_AUDIT_LOG_FILE`
- **Per-tool rate limiting** (`OPENGROK_PER_TOOL_RATELIMIT`): override RPM per tool using `tool:rpm,tool:rpm` format; enforced by `ToolRateLimiter` class
- **Credential rotation warnings**: at startup, warns if `OPENGROK_PASSWORD` or `OPENGROK_PASSWORD_FILE` credentials are older than 90 days (`OPENGROK_CREDENTIAL_MAX_AGE_DAYS`)
- **Request origin validation**: validates `Origin` header on HTTP requests; rejects non-allowlisted origins with 403
- **`OPENGROK_ALLOWED_CLIENT_IDS`**: config key reserved for future per-client enforcement (enforcement pending SDK client-context API stabilization)

### 🗂️ Task Registry

- `src/server/task-registry.ts`: in-memory async task store for `opengrok_execute`
- `createTask()`, `completeTask()`, `failTask()`, `getTask()` with 30-minute TTL for running tasks
- Integrated with `opengrok_execute` handler: long-running sandbox jobs return a task handle, polled via `opengrok_get_task_result`

### 🐛 Bug Fixes (Quality Review)

- Task registry now correctly wired — `opengrok_get_task_result` was always returning "not found" before this fix
- Path sanitizer broadened to catch `/etc`, `/proc`, relative paths, and UNC paths (switched to broad regex)
- Running tasks properly cleaned up with TTL to prevent orphaned state
- `opengrok_blame` `outputSchema` guard added to prevent type mismatch at runtime
- Health-check polling interval properly cleared on server shutdown

### 📈 Stats

- Tests: 613 (v5.5.0) → 673 → **773** (+100 tests total)
- New files: `src/server/audit.ts`, `src/server/elicitation.ts`, `src/server/sampling.ts`, `src/server/task-registry.ts`

---

## [5.5.0] - 2026-03-27

### ⚡ Performance

- **Sandbox worker pool** (`src/server/worker-pool.ts`): `SandboxWorkerPool` keeps up to 2 idle workers warm, reusing QuickJS WASM instances across `opengrok_execute` calls; `acquire()`/`release()`/`drain()` lifecycle with `isAlive` flag preventing recycling of terminated workers
- **HTTP connection pool**: undici pool tuned to `connections: 20`, `keepAliveTimeout: 60_000 ms` for throughput
- **Cache pre-warming**: `warmCache()` called after successful `opengrok_index_health` check to pre-populate project list and hot search paths
- **JSON-aware Code Mode truncation** (`capCodeModeResult()`): truncates large sandbox results at JSON array element boundaries instead of byte boundaries, preserving valid JSON
- **Batch search deduplication** (`deduplicateAcrossQueries()`): removes identical `file:line` hits across parallel query results, eliminating duplicate context tokens
- **Grep-style line format**: TSV and text output now uses `file.ext:line: content` format instead of tabular `60 | content`, reducing tokens ~15%
- **TSV format for batch search**: `opengrok_batch_search` now supports `response_format: "tsv"` for compact output

### 🔧 New Tools

- **`opengrok_what_changed`**: shows recent line changes grouped by commit — author, date, commit SHA, and changed lines with context; useful for "what changed around this crash?"
- **`opengrok_dependency_map`**: BFS traversal of `#include`/`import` chains up to configurable depth (1–3); returns directed graph with `uses`/`used_by` direction; supports `outputSchema`
- **`opengrok_search_pattern`**: regex code search using OpenGrok's `regexp=true` parameter; returns grep-style `file:line:content` matches with `outputSchema`
- **Enhanced `opengrok_index_health`**: now returns `latencyMs`, `indexedProjects` count, per-project staleness warnings, and `indexingInProgress` flag in both text and structured output

### 🎨 UI & VS Code Extension

- **Status bar badge**: OpenGrok status bar item now shows `v6.0.0` version tag
- **Versioned setup prompt key** (`opengrok.setupPrompted.v2`): prevents re-showing setup dialog after upgrades by using a version-scoped key instead of a fixed boolean

### 📖 Skills

- **`skills/opengrok-cpp/SKILL.md`** (new, 489 lines): C++-specialized skill with 7 sections — class/template/macro search, include chain tracing, compiler flag extraction, cross-file impact analysis, and full Code Mode workflow for C++
- **`skills/opengrok/SKILL.md`**: updated tool count, added `opengrok_what_changed`, `opengrok_dependency_map`, `opengrok_search_pattern`, `opengrok_memory_status` to tool selection table

### 🐛 Bug Fixes (Quality Review)

- `opengrok_dependency_map` `uses` direction now correctly uses `refs` search type instead of `path` search (was returning file paths instead of actual references)
- Diamond dependency deduplication: BFS graph builder uses `seenUsesPaths` set to prevent duplicate nodes in diamond-shaped dependency graphs
- `opengrok_search_pattern` `dispatchTool` now correctly passes `response_format` argument (was always returning markdown)
- Self-skip in `opengrok_dependency_map` now compares full paths instead of basenames (prevented different files with the same name from appearing in results)

### 📈 Stats

- Tests: 613 (v5.4.0) → **673** (+60 tests)
- New files: `src/server/worker-pool.ts`, `skills/opengrok-cpp/SKILL.md`

---

## [5.4.0] - 2026-03-27

### 🗃️ 2-File Memory Architecture

Complete redesign of the Living Document memory bank from 6 files to 2 focused files:

**Before (6 files):** `AGENTS.md`, `codebase-map.md`, `symbol-index.md`, `known-patterns.md`, `investigation-log.md`, `active-context.md`  
**After (2 files):** `active-task.md` (≤4 KB, structured task state) + `investigation-log.md` (≤32 KB, append-only log)

Key changes:
- **Automatic migration**: on first startup with old files, migrates `active-context.md` → `active-task.md`, deletes the 4 deprecated files, logs warnings for files with real content (directs user to VS Code `/memory` command)
- **`active-task.md` structured format**: YAML-like front matter (`task:`, `started:`, `last_symbol:`, `last_file:`, `next_step:`, `open_questions:`, `status:`) for easy parsing
- **Auto-timestamp on append**: `investigation-log.md` in append mode automatically adds `## YYYY-MM-DD HH:MM: Session Update` heading when content doesn't start with `## `
- **Delta encoding**: repeated reads return `[unchanged]` when content hash matches last read, eliminating redundant context tokens
- **Richness-scored trimming**: when `investigation-log.md` exceeds capacity, entries are scored by symbol count, conclusion markers, and dead-end penalty; lowest-scoring oldest entries trimmed first (always keeps 2 most recent)
- **Compressed initial read**: when `investigation-log.md` exceeds 8 KB, `readCompressed()` returns last 3 entries + `[N older entries omitted]` header
- **Non-VS Code note**: documented in SERVER_INSTRUCTIONS that non-VS Code clients must manage general codebase context themselves; our memory bank handles only investigation state

### 🛠️ New Tool

- **`opengrok_memory_status`** (19th tool): shows both memory files with status (`populated` / `empty` / `stub`), byte counts, and 3-line content preview; returns `MemoryStatusOutput` structured output; helps LLM decide whether memory is worth reading

### 🧠 Rewritten SERVER_INSTRUCTIONS

Complete rewrite to v6.2 §4.2 — 310 tokens:
- **Session startup protocol** (4 steps): health check → memory_status → read active-task.md → proceed
- **Decision tree**: Code Mode wins for >3-hop investigations; classic tools win for single lookups
- **Mandatory memory before answer**: LLM must write investigation summary before final response
- **Memory reminder**: injected every 5th `opengrok_execute` call
- **Memory write format**: explicit active-task.md front matter format with required fields

### 📦 Code Mode Optimizations

- **Compact tool descriptions** in Code Mode: all 14 legacy tools use condensed ~12-token descriptions when `OPENGROK_CODE_MODE=true`, reducing tool listing from ~500 tokens to ~171 tokens
- **`desc()` helper**: `desc(full, compact)` utility applied to all 14 legacy tool registrations for clean inline toggling

### 🖥️ VS Code Extension

- **Compile Commands UI field**: new "Compile Commands DB" advanced setting in Configuration Manager maps to `OPENGROK_LOCAL_COMPILE_DB_PATHS` (comma-separated paths to `compile_commands.json`)
- **currentConfig sync fix**: `currentConfig.codeMode` now correctly updated on every save, preventing stale Code Mode state across multiple saves

### 🔧 Configuration

- **`OPENGROK_ENABLE_CACHE_HINTS`** (`true`/`false`, default `false`): enables `cache-control: immutable` response hints for prompt caching; infrastructure-level flag for future Anthropic prompt cache integration
- **CLI memory bank path**: now uses `XDG_CONFIG_HOME` (or `~/.config/opengrok-mcp/memory-bank/`) for standalone CLI deployments, giving each project a stable cross-session path
- **`OPENGROK_LOCAL_COMPILE_DB_PATHS`**: comma-separated list of absolute paths to `compile_commands.json` files for C/C++ compiler flag extraction

### 📖 Skills

Three new/updated skill files:
- **`skills/opengrok/SKILL.md`**: rewritten with Code Mode decision tree, tool selection table, new 2-file memory architecture, VS Code Copilot memory integration note
- **`skills/opengrok-investigation/SKILL.md`** (new): investigation loop patterns — bug root cause, module exploration, cross-project impact analysis; when to use Code Mode vs classic
- **`skills/opengrok-session/SKILL.md`** (new): session startup (4-step protocol), multi-session handoff pattern, mandatory investigation-log writes

### 🐛 Bug Fixes

- `opengrok_memory_status`: skip blank lines in preview, remove dead `.catch()` on non-promise
- Fixed 11 pre-existing test failures from v5.3.1 related to old 6-file memory architecture

### 📈 Stats

- Tests: 599 (v5.3.2) → **613** (+14 tests, 27 new tests minus 11 fixed failures)
- New files: `skills/opengrok-investigation/SKILL.md`, `skills/opengrok-session/SKILL.md`

---

## [5.3.2] - 2026-03-27

### 🐛 Bug Fixes

- **`hasPromptedConfig` removed from VS Code settings** (Bug 1.1): the value is managed in `globalState`, not VS Code settings — removing it prevents it from appearing in the user's `settings.json`
- **Activation events tightened** (§2.4): replaced broad `onStartupFinished` with 6 specific command triggers (`onCommand:opengrok-mcp.configure`, `onCommand:opengrok-mcp.configureUI`, `onCommand:opengrok-mcp.test`, `onCommand:opengrok-mcp.statusMenu`, `onCommand:opengrok-mcp.checkUpdate`, `onExtension:github.copilot-chat`); extension no longer activates on every VS Code startup
- **SERVER_INSTRUCTIONS dead references fixed** (Bug 1.2): replaced `opengrok_list_memory_files` (non-existent) with `opengrok_memory_status`; replaced old 6-file memory paths (`AGENTS.md`, `active-context.md`) with correct 2-file paths
- **ObservationMasker injection layer fixed** (Bug 1.7): session history was incorrectly injected as code comments inside the sandboxed JS — now correctly prepended to the tool result text where the LLM can see it
- **`currentConfig.codeMode` stale state** (Bug 1.5): Code Mode toggle state now correctly synced on every save, not just the first
- **batchSearch parallelism documentation** (Bug 1.4): clarified in `API_SPEC` and `SKILL.md` that `Promise.all()` inside sandbox does not parallelize — use `env.opengrok.batchSearch()` which runs queries in parallel on the host event loop

### ✨ UI Improvements

- **Configuration panel opens beside**: `ViewColumn.Beside` used for Configuration Manager — opens next to current editor, preserving workspace layout
- **Silent connection test on save**: `testConnection()` runs silently after config save; no "Reload Window" popup unless a real change requires it
- **Deferred update check** (Bug 1.6): auto-update check deferred 30 s after activation to avoid blocking extension startup
- **Code Mode toggle progress feedback**: status bar shows brief "Refreshing tools..." message during Code Mode toggle, then reverts; prevents double-click race conditions

### 📈 Stats

- Tests: 599 (unchanged — pure bug fix release)

---

## [5.3.1] - 2026-03-21

### ✨ New Features & UX Improvements

- **ViewColumn.Beside Configuration UI**: The Configuration Manager now opens seamlessly next to your active editor, keeping your workspace fluid while avoiding activity bar clutter.
- **Advanced Settings section**: Collapsible "Advanced Settings" in the config UI groups power-user options (Default Project, HTTP Proxy, Context Budget, Response Format Override, Code Mode toggle, Memory Bank Dir).
- **Auto Tool Refresh**: Toggling Code Mode directly from the UI now instantly updates the available Copilot tools without requiring a manual window reload.
- **Unified Tool Availability**: Both Code Mode (`opengrok_api`, `opengrok_execute`) and classic tools (`opengrok_search_code`, etc.) are now always available simultaneously, allowing the LLM to choose the optimal strategy for simple vs. complex queries.
- **Zero-Prompt Testing**: Eliminated unnecessary "Reload Window" prompts when testing configurations or updating settings.
- **Default Project setting**: New `opengrok-mcp.defaultProject` VS Code setting and UI field. Maps to `OPENGROK_DEFAULT_PROJECT` env var — scopes all searches to this project when none is specified per-call.
- **Response Format setting**: New `opengrok-mcp.responseFormatOverride` VS Code setting (`""` / `"markdown"` / `"json"`).
- **Hidden `hasPromptedConfig`**: Internal setup tracker removed from the user-facing VS Code settings menu for cleaner Preferences.

### 🗂️ Workspace-Specific Memory Bank

- **Default location changed**: Memory bank files now default to `<workspace>/.opengrok/memory-bank/` (workspace-relative via `process.cwd()`) instead of the extension install directory. Each project gets its own memory bank automatically. Old path: `<extension>/memory-bank/`.
- **VS Code extension**: When a workspace is open, the extension explicitly passes `OPENGROK_MEMORY_BANK_DIR=<workspaceFolder>/.opengrok/memory-bank/` to the MCP subprocess, overriding the server's own default. Customize via the UI Advanced Settings or `opengrok-mcp.memoryBankDir`.

### 🧠 LLM Instruction Improvements

- **Unified Intelligence**: `SERVER_INSTRUCTIONS` now dynamically blends guidance for both classic and Code Mode tools, teaching the LLM *when* to use each pattern based on efficiency.
- **Step 0 — health check**: Added `opengrok_index_health` as step 0 in the optimal workflow (run once on first call to verify connectivity).
- **Broadened scope**: Swapped "large C++ codebases" to "large, multi-language codebases" globally.
- **Expanded SESSION MEMORY**: Living Document instructions now include full read/write lifecycle and the exact memory bank path.

### 📖 Skill Improvements (`skills/opengrok/SKILL.md`)

- Added **Code Mode Tools** section to the Tool Selection table (`opengrok_api` + `opengrok_execute`).
- Added full **Code Mode** section with workflow, JavaScript example, and sandbox notes.
- Updated default project note to reference the new VS Code Extension Setting.
- Marked `opengrok_index_health` as "Run this first in every session".

### 🐛 Bug Fixes

- **Sandbox worker WASM crash** (v5.0.x regression, fixed in prior commit): `esbuild.js` now shims `import.meta.url` in the CJS bundle, fixing the "Received undefined" crash on QuickJS WASM loading.

### Changed

- `memoryBankDir` extension setting description updated to reflect new workspace-relative default.
- `codeMode` extension setting description de-coupled from C++ framing.

---

## [5.0.0] - 2026-03-20


Reduces LLM token consumption 80–95% on large C++ codebases. Zero new background processes. Zero impact on shared build machines. Works standalone (Claude Code CLI, `npx`) with no native compilation or Node flags required.

### Changed (Behavioural Defaults)

- **`opengrok_search_and_read` `context_lines` default**: 10 → 5 lines. Pass `context_lines: 10` explicitly to restore previous behaviour.

### Added

#### Phase 1 — Cache-Safe Server Cleanup
- Rewrote `SERVER_INSTRUCTIONS`: numbered rules, no runtime interpolation, token-efficient.
- Full-file fetch guard in `opengrok_get_file_content`: warns + auto-applies line range when file exceeds 50 lines and no range given.

#### Phase 2 — Compact Response Formats
- **TSV format** for search results: `formatSearchResultsTSV()` — ~58% fewer tokens than markdown, tab-delimited (safe for C++ signatures with colons).
- **YAML format** for symbol context: `formatSymbolContextYAML()` — js-yaml block scalars handle C++ colons/hashes safely.
- **Text format** for file content: `formatFileContentText()` — no fenced code block overhead.
- **`selectFormat()`**: auto-selects best format by response type; override globally with `OPENGROK_RESPONSE_FORMAT_OVERRIDE`.

#### Phase 3 — Context Budget Modes
- **`OPENGROK_CONTEXT_BUDGET`** env var with three tiers:
  - `minimal` (default) — 4 KB responses, 5 results, 50 inline lines
  - `standard` — 8 KB, 10 results, 100 lines
  - `generous` — 16 KB, 25 results, 200 lines
- `capResponse()` now reads from `BUDGET_LIMITS`; `search_and_read` cap also budget-aware.

#### Phase 4 — Code Mode (2-Tool Interface)
- **`OPENGROK_CODE_MODE=true`**: activates 2-tool mode (`opengrok_api` + `opengrok_execute`) for large C++ codebases. Write JavaScript; all `env.opengrok.*` calls appear synchronous. Token savings vs. 14-tool standard mode are substantial for multi-step investigations.
- **`opengrok_api`**: returns full API spec (call once at session start).
- **`opengrok_execute`**: runs LLM-written JS in a sandboxed QuickJS VM.
- **`opengrok_read_memory` / `opengrok_update_memory`**: direct memory bank access from standard MCP clients.
- **Server-side intelligence**:
  - `env.opengrok.getFileOverview()` — parallel symbols + history + imports fetch; replaces 3–5 sequential tool calls.
  - `env.opengrok.traceCallChain()` — refs-based caller tracing up to depth 4 (callees require AST, intentionally unimplemented).

#### Phase 5 — Living Document / Memory Bank
- **Memory Bank**: 6 persistent markdown files (`AGENTS.md`, `codebase-map.md`, `symbol-index.md`, `known-patterns.md`, `investigation-log.md`, `active-context.md`). Stub sentinel detection, append mode, `investigation-log.md` trims at 32 KB on heading boundaries.
- **Observation Masker**: keeps last 10 full tool outputs in context; older turns compacted to key facts (file paths, line numbers, CamelCase symbols) to prevent context overflow during long sessions.
- **VS Code config**: three new settings (`codeMode`, `memoryBankDir`, `contextBudget`) wired to env vars via extension passthrough.

#### Phase 6 — QuickJS Sandbox Implementation
- **Sandbox**: `@sebastianwessel/quickjs` (pure JS + WASM) — no `node-gyp`, no native compilation, no `--node-snapshot` flags. Works on all platforms including `npx` and enterprise Linux with stripped symbols.
- **Architecture**: dedicated Worker thread + SharedArrayBuffer bridge. Worker calls `Atomics.wait()` (blocks worker thread); main thread event loop stays free for async OpenGrok HTTP calls, writes result, calls `Atomics.notify()`. Buffer layout: bytes 0–15 status (`Int32`), 16–19 length (`Uint32`), 20+ JSON payload (`Uint8`, 1 MB max).
- **Sandbox limits**: 9 s QuickJS interrupt timeout + 10 s hard `worker.terminate()`. Memory 128 MB, stack 4 MB.
- **`npm run test:sandbox`**: post-build sandbox integration tests (10 tests, requires `npm run compile` first, uses separate `vitest.sandbox.config.ts`).

### Testing

- **591 tests across 25 test files** (up from ~493 in v4.0), 92% line coverage, 93% branch coverage.
- New: `config-budget.test.ts`, `formatters-formats.test.ts`, `memory-bank.test.ts`, `observation-masker.test.ts`, `intelligence.test.ts`, `code-mode.test.ts`, `sandbox.test.ts`.

---

## [4.0.0] - 2026-03-15

### ⚠️ Breaking Changes

- **Tool rename**: All 14 tools now use `opengrok_` prefix for namespace clarity per MCP best practices. Update any client configurations or scripts that reference tool names.

#### Migration Guide

| Old Name (v3.x) | New Name (v4.0) |
| ---------------- | --------------- |
| `search_code` | `opengrok_search_code` |
| `find_file` | `opengrok_find_file` |
| `get_file_content` | `opengrok_get_file_content` |
| `get_file_history` | `opengrok_get_file_history` |
| `browse_directory` | `opengrok_browse_directory` |
| `list_projects` | `opengrok_list_projects` |
| `get_file_annotate` | `opengrok_get_file_annotate` |
| `search_suggest` | `opengrok_search_suggest` |
| `batch_search` | `opengrok_batch_search` |
| `search_and_read` | `opengrok_search_and_read` |
| `get_symbol_context` | `opengrok_get_symbol_context` |
| `index_health` | `opengrok_index_health` |
| `get_compile_info` | `opengrok_get_compile_info` |
| `get_file_symbols` | `opengrok_get_file_symbols` |

- **Removed `zod-to-json-schema` dependency**: `McpServer.registerTool()` handles Zod→JSON Schema natively. No action needed unless you imported from `tool-schemas.ts`.
- **Deleted `tool-schemas.ts`**: Tool definitions are now registered inline via `registerTool()` in `server.ts`.

### Added

- **McpServer high-level API** (Phase 2): Migrated from deprecated `Server` + `setRequestHandler()` to `McpServer` + `registerTool()`. Each tool is self-contained with its own error handling.
- **Tool annotations** on all 14 tools: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` per MCP spec. `opengrok_get_compile_info` uses `openWorldHint: false` (local filesystem only).
- **`title` field** on all tool registrations for human-readable display.
- **`isError: true`** on all error responses per MCP spec. All three error types (ZodError, Error, unknown) handled via shared `makeToolError()` helper.
- **Structured output schemas** (`structuredContent`) for priority tools: `opengrok_search_code`, `opengrok_get_file_content`, `opengrok_list_projects`, `opengrok_batch_search`, `opengrok_get_symbol_context`. Programmatic clients receive typed data alongside text.
- **`response_format` parameter** on all 14 tools: `"markdown"` (default, LLM-optimised) or `"json"` (programmatic). Shared `formatResponse()` helper eliminates per-handler duplication.
- **Expanded tool descriptions** for compound tools (`opengrok_batch_search`, `opengrok_search_and_read`, `opengrok_get_symbol_context`, `opengrok_get_compile_info`, `opengrok_get_file_symbols`) with "when to use / when not to use", Args, and Example sections.
- **Output Zod schemas** in `models.ts`: `SearchResultsOutput`, `FileContentOutput`, `ProjectsListOutput`, `BatchSearchOutput`, `SymbolContextOutput` with pagination fields (`hasMore`, `nextOffset`).

### Security

- **Logger credential redaction**: `sanitizeMeta()` in `logger.ts` strips Basic auth, Bearer tokens, URL-embedded credentials, and filesystem paths from all log output.
- **Complete HTML entity decoding**: `stripHtmlTags()` now handles decimal (`&#60;`) and hex (`&#x3C;`) numeric references, plus missing named entities (`nbsp`, `apos`).
- **Strengthened path traversal validation**: `assertSafePath()` rejects URL-encoded (`%2e%2e`, `%2f..`), double-encoded (`%252e`), and null-byte (`\0`, `%00`, `%2500`) traversal variants with decode-before-validate.
- **Deterministic cache keys**: `search()` cache uses `[...projects].sort().join(",")` instead of `JSON.stringify()`.
- **Plaintext HTTP warning**: `runServer()` logs warning when credentials are configured with `http://` base URL.

### Changed

- **ESLint strict preset**: `tseslint.configs.strict` with `no-explicit-any: "error"`, `no-floating-promises`, `await-thenable`, `no-misused-promises`.
- **TypeScript declarations**: `tsconfig.json` enables `declaration` and `declarationMap`. `package.json` exports `types` field.
- **Coverage thresholds**: `vitest.config.ts` enforces 90% lines/functions/statements, 85% branches.
- **Structured logging**: ISO timestamps, `[INFO]`/`[WARN]`/`[ERROR]`/`[DEBUG]` prefixes, debug level gated by `OPENGROK_LOG_LEVEL`.
- **Expanded language map**: Added `.tsx`, `.jsx`, `.vue`, `.scala`, `.gradle`, `.dart`, `.zig`, `.lua`, `.r`, `.m`, `.mm`, `.pl`, `.tf`, `.toml`, `.ini`, `.proto`.
- **npm scripts**: Added `typecheck`, `lint:fix`, `validate`.
- **Magic numbers extracted**: `MAX_REDIRECTS`, `MAX_FILTER_LENGTH`, `TIMEOUTS` as named constants.
- **Non-null assertions eliminated**: All `.pop()!` replaced with `?? ""` fallback.
- **Regex patterns extracted**: `LINE_ANCHOR_RE`, `DEF_SYMBOL_RE`, `SIG_RE` as module-level constants.

---

## [3.3.5] - 2026-03-15

### Changed

- **Rebrand**: Extension `displayName` renamed to **OpenGrok MCP Server**.
- **Description**: Updated to "MCP server bridging OpenGrok search engine with AI for deep, instant context across massive codebases" across `package.json`, `server.json`, and `README.md`.
- **License**: Added `LICENSE-COMMERCIAL.md` clearly describing commercial/enterprise licensing terms. Updated `LICENSE` Required Notice with author attribution. README license section now explicitly states commercial use restrictions with contact info.
- **Installation docs**: README now lists npm (`npx opengrok-mcp-server`) and MCP Registry (`io.github.IcyHot09/opengrok-mcp-server`) as first-class installation options alongside VS Code Marketplace.
- **MCP Registry badge**: Added to README header badges.
- **Release tooling**: Fixed wrong GitHub repo URL in `generate-release-notes.js`. Release script now syncs `server.json` version on each release.

---

## [3.3.4] - 2026-03-14

### Changed

- **MCP Registry Support**: Added `mcpName` property to `package.json` and created `server.json` to publish the extension to the official Model Context Protocol (MCP) Registry.
- Updated extension description to meet registry character limits and content guidelines.

---

## [3.3.3] - 2026-03-14

### Fixed

- **Security: bump `undici` to 7.24.2** — addressed multiple high/moderate severity CVEs including WebSocket 64-bit length overflow (GHSA-f269-vfmq-vjvj), HTTP request/response smuggling (GHSA-2mjp-6q6p-2qxm), unbounded memory consumption in WebSocket permessage-deflate decompression (GHSA-vrm6-8vpv-qv8q), unhandled exception in WebSocket client (GHSA-v9p9-hfj2-hcw8), and CRLF injection via `upgrade` option (GHSA-4992-7rv2-5pvq).
- **Fix `testConnection` test**: mock updated to return a JSON array (matching the real `/api/v1/projects` endpoint) instead of HTML, fixing a false-negative assertion..

---

## [3.3.2] - 2026-03-09

### Fixed

- **`get_file_content` shows wrong line numbers when `start_line` is used**: The formatter always displayed lines as `1, 2, 3...` regardless of the `start_line` parameter, making it hard to correlate output with the actual file. Root cause: `FileContent` had no `startLine` field, so `formatFileContent` had no offset to start from. Fixed by adding `startLine?: number` to the `FileContent` interface and populating it in all three code paths (`client.ts` API read, `server.ts` local abs-path read, `server.ts` local root read). The formatter now numbers lines from `startLine` (e.g., a `start_line=60` request shows `60 | ...`, `61 | ...`, etc.).

---

## [3.3.1] - 2026-03-09

### Fixed

- **`get_file_annotate` shows blame markers instead of source code on OpenGrok 1.7.x**: In the real 1.7.x annotate HTML format, source code lines appear as sibling nodes *after* `<span class="blame">`, not inside it. The performance refactor in v3.3.0 introduced a regression: `el.text` on the blame span returned the blame anchor text (`851c8156SJane Doe`) instead of the actual source line. Fixed with index-based parent `childNodes` iteration (since `TextNode.nextSibling` is unreliable in `node-html-parser`). Also added `content` assertions to the OpenGrok 1.7.x annotate parser test.

---

## [3.3.0] - 2026-03-09

### 🛡️ Security Hardening

- **Content Security Policy**: Added CSP `<meta>` tags to the Configuration Manager webview and inline fallback HTML, restricting script/style sources to nonces.
- **XSS prevention**: Replaced `innerHTML` with `textContent` for toast notification messages in the Configuration Manager.
- **Cross-origin redirect blocking**: `downloadToFile()` (used by auto-updater) now rejects cross-origin redirects and protocol downgrades (HTTPS → HTTP).
- **Removed global TLS bypass**: Removed `NODE_TLS_REJECT_UNAUTHORIZED=0` env var mutation; SSL verification is now controlled solely by the `verifySsl` setting.
- **ReDoS guard**: `listProjects` filter input is capped at 100 characters and rejects patterns with 3+ consecutive wildcards.
- **Error message sanitization**: Filesystem paths are stripped from error messages returned to the LLM to prevent path disclosure.
- **Wrapper script key derivation**: Added random salt to AES key derivation in bash and PowerShell credential wrappers, with automatic migration from unsalted keys. Added `.env` file TTL warnings.

### ⚡ Performance

- **Singleton HTTP agent**: Reuse a single `undici.Agent` instead of creating one per request (eliminates socket leaks under sustained load).
- **Async local layer I/O**: Converted all `fs.realpathSync` / `fs.readFileSync` calls in the local layer to async (`fsp.realpath`, `fsp.readFile`).
- **O(1) compile index lookups**: `resolveFileFromIndex()` now uses a pre-built suffix index instead of linear scan.
- **Single-pass parsers**: `parseFileSymbols()` and `parseAnnotate()` rewritten as single-pass (eliminated double HTML parses).
- **Fast string operations**: `extractLineRange()` replaced `split/slice/join` with `indexOf`-based extraction; `capResponse()` uses `Buffer.byteLength` fast path.
- **Probabilistic cache eviction**: TTL cache evicts expired entries every 10th write instead of every write.
- **Cached annotate style**: The annotation endpoint style (REST vs. xref fallback) is cached after the first successful call per session.

### 🏗️ Architecture & Code Quality

- **Tool definitions extracted** (`tool-schemas.ts`): Tool definitions are now generated from Zod schemas via `zod-to-json-schema` in a dedicated module, replacing the hand-maintained JSON schemas that were inline in `server.ts`.
- **Server refactored**: Three long `dispatchTool` handler cases (`search_and_read`, `get_symbol_context`, `get_compile_info`) extracted into standalone functions — the switch case shrank by ~260 lines.
- **ESLint flat config** (`eslint.config.mjs`): Added `typescript-eslint` + Prettier integration. `npm run lint` now runs both `tsc --noEmit` and ESLint.
- **Centralized logger** (`logger.ts`): All modules use a structured logger with `[INFO]`/`[WARN]`/`[ERROR]` prefixes; raw `console.error` calls eliminated.
- **Config hardening**: NaN-safe integer parsing via `zIntString` helper for all 9 numeric env vars. `Config` object frozen after construction.
- **Zod 4 upgrade**: Migrated from Zod 3 to Zod 4 with `zod-to-json-schema` for tool input schemas.
- **Node 24**: Runtime upgraded from Node 22 to Node 24. All dependencies updated to latest (undici 7.22, esbuild 0.25, vitest 4, typescript-eslint 8).

### 🎨 UI Improvements

- **Configuration Manager accessibility**: Improved HTML structure with proper semantic elements, ARIA attributes, and keyboard navigation in the webview panel.

### 🧪 Tests — 100% Code Coverage

- **476 tests passing** (up from 123 in v3.2.1) — **100% statement, branch, function, and line coverage** across all metrics.
- 10 new test files: `branch-coverage.test.ts`, `branch-targets.test.ts`, `client-extended.test.ts`, `client-internals.test.ts`, `coverage-gaps.test.ts`, `formatters-extended.test.ts`, `logger.test.ts`, `main.test.ts`, `parsers-extended.test.ts`, `server-coverage.test.ts`, `server-dispatch.test.ts`, `server-extended.test.ts`.
- Test fixtures updated to match real OpenGrok 1.7.x HTML output.
- CI pipeline now reports coverage metrics via Vitest's `v8` coverage provider.

---

## [3.2.1] - 2026-03-09

### Fixed
- **VSIX download fails with "not a zip file" error**: artifact URLs (`/-/jobs/artifacts/.../raw/...`) redirected unauthenticated requests to a sign-in page. The download URL was rewritten to the provider API equivalent (`/api/v4/projects/.../jobs/artifacts/.../raw/...`) that accepts auth headers correctly. Auth headers are also stripped on any cross-host redirects to avoid leaking them to CDN/S3 servers.

---

## [3.2.0] - 2026-03-09

### ✨ New Features

- **Standalone MCP server distribution**: The server binary is now packaged into platform archives (`-linux.tar.gz`, `-darwin.tar.gz`, `-win.zip`) and attached to every release, so developers can use it without VS Code from any MCP-compatible client (Claude Code, Cursor, Windsurf, Claude Desktop, OpenCode, etc.).

- **One-command installer** (`scripts/install.sh`): Detects OS, pulls the correct archive from the latest release, and installs to `~/.local/bin`. Respects `HTTPS_PROXY` and `OPENGROK_MCP_VERSION` for pinned versions.

- **Credential wrapper scripts**: Cross-platform wrapper scripts (`opengrok-mcp-wrapper.sh` / `.ps1` / `.cmd`) handle secure credential storage and injection. Credentials are never written as plaintext — stored in the OS keychain (macOS), Secret Service (Linux), or Windows Credential Manager, with an AES-256-CBC encrypted file fallback for headless environments. An interactive `--setup` mode guides first-time configuration.

- **`--version` flag**: `opengrok-mcp --version` (or `-v`) now prints the version and exits, enabling health checks and wrapper pre-flight validation.

- **Updated `MCP_CLIENTS.md`**: Comprehensive setup guide covering all supported clients with both wrapper-based quick start and manual (env var) fallback instructions.

---

## [3.1.0] - 2026-03-08

### ✨ New Features

- **Auto-update notifications**: The extension checks the releases API on activation (throttled to once per 24 hours) for newer stable versions. When an update is found, a notification offers to download the `.vsix` and install it automatically — no manual download required. Pre-release tags (`beta`, `alpha`, `rc`) are skipped. Authentication is handled through VS Code's authentication API.

- **"OpenGrok: Check for Updates" command**: New Command Palette entry and status bar menu item to manually trigger an update check at any time. Triggers a sign-in prompt if not already authenticated.

---

## [3.0.1] - 2026-03-08

### Fixed
- `get_file_annotate` now shows per-line blame instead of collapsing consecutive same-author lines
- `list_projects` filter works as substring match (e.g. `release` matches all `release-*` projects)
- Renamed `get_compile_info` parameter `file_path` → `path` for consistency with other tools
- Added AI hints to MCP instructions to prevent common parameter mistakes

---

## [3.0.0] - 2026-03-08

### 🚀 The Big One — OpenGrok Gets a Brain

v3.0 is the largest update since the original TypeScript rewrite. It transforms OpenGrok from a basic "fetch this file" tool into a full code intelligence engine for Copilot Chat.

**6 new tools** — The headline additions are `get_symbol_context`, `search_and_read`, `batch_search`, `get_file_symbols`, `get_compile_info`, and `index_health`. The star of the show is `get_symbol_context`: give it a symbol name and it returns the definition, the header declaration, and every call site — all in a single round-trip. That's a ~92% token reduction compared to the old manual workflow.

**Your compiler joins the conversation** — If your workspace has a `compile_commands.json`, the extension auto-discovers it and enables `get_compile_info`. Ask Copilot "what flags does this file compile with?" and get back exact include paths, defines, and the language standard. Zero configuration required.

**Every symbol in a file, at a glance** — `get_file_symbols` lists all functions, classes, macros, enums, structs, and typedefs in a file. Works even on OpenGrok instances that block the REST API — it falls back to parsing the web UI directly.

**Massively smarter formatting** — Responses are capped at 16 KB (no more blowing up Copilot's context window), search output is compact one-line-per-result, and all search tools now support a `file_type` filter and `hist` search type for commit messages.

**OpenGrok 1.7.x fully supported** — Fixed a slew of compatibility issues: annotate 404s, broken blame parsing, empty directory listings, and defs/refs searches returning errors. If it works in the browser, it works through this extension now.

> For the full technical details, see the beta changelogs below (beta.1 through beta.4).

---

## [3.0.0-beta.4] - 2026-03-08

### ✨ New Features

- **`get_file_symbols` tool** (`server.ts`, `client.ts`, `parsers.ts`, `formatters.ts`, `models.ts`): new tool that lists all top-level symbols (functions, classes, macros, enums, structs, typedefs) defined in a file. Tries the `/api/v1/file/defs` REST endpoint first; falls back to parsing the xref HTML page for `data-definition-place="def"` `intelliWindow-symbol` links when the REST endpoint returns 401 (as on some OpenGrok instances). CSS class mapping: `xf`→function, `xm`→macro, `xc`→class, `xe`→enum, `xs`→struct, `xt`→typedef. Extracts line numbers and scope signatures. Integrates with `get_symbol_context` as an optional Step 2.5.

### 🐛 Bug Fixes

- **Config Manager UI overflows small windows** (`configManager.html`): the webview panel was overflowing vertically on small screens and short windows, cutting off the Save button. Fixed with `min-height: 100vh` on body, `justify-content: safe center` on the flex container, `flex-shrink: 0` on the glass panel, and three responsive breakpoints (`@media (max-height: 700px)`, `(max-height: 520px)`, `(max-width: 500px)`) to scale down padding and font sizes.

- **Tool selection reset on every window open** (`extension.ts`): `workbench.action.chat.mcp.resetCachedTools` was being invoked inside `activate()` on every extension activation (i.e., every time a new VS Code window opened). This caused Copilot Chat to reset its enabled-tools list, forcing the user to re-tick every OpenGrok tool after opening a new folder. Fixed by removing the `resetCachedTools` call from `activate()` and `testConnection()`.

- **`command 'workbench.action.chat.mcp.resetCachedTools' not found`** (`extension.ts`): the internal VS Code command used to notify Copilot of MCP server changes does not exist in all VS Code versions, producing a logged error on every configuration save and version update. Replaced all uses with the official `onDidChangeMcpServerDefinitions` event API: added a `_onDidChange` `EventEmitter` to `OpenGrokMcpProvider`, a `fireChanged()` method, a module-level `mcpProvider` variable, and a `notifyMcpServerChanged()` helper. The event fires only on version update and configuration save.

### 🧪 Tests

- **123 tests passing** (up from 106)
- 9 new `parseFileSymbols` tests: type mapping, line numbers, scope signatures, HTML entity decoding, local/argument exclusion, empty input, no-def anchors
- 8 new `formatFileSymbols` tests: grouped output, unknown types, empty input

---

## [3.0.0-beta.3] - 2026-03-07

### ✨ New Features

- **Zero-config local layer**: The extension now auto-discovers `compile_commands.json` files from all VS Code workspace folders using `vscode.workspace.findFiles`. No manual configuration is needed — open a workspace that contains a build tree and the local layer enables itself automatically.

- **`inferBuildRoot()` function**: New helper in `compile-info.ts` that derives the build root as the longest common path prefix of all `directory` entries across the discovered `compile_commands.json` files. This correctly handles build trees where sources are compiled across multiple subdirectories.

- **`OPENGROK_LOCAL_COMPILE_DB_PATHS` env var**: Replaced `OPENGROK_LOCAL_BUILD_ROOT`. Accepts a comma-separated list of absolute paths to `compile_commands.json` files. Used by standalone (non-VS Code) deployments to explicitly provide compile databases.

- **`get_file_content` local bypass — compile index path resolution** (`server.ts`): fixed the transparent local read to actually work when the local source tree path differs from the OpenGrok-relative path. Previously `tryLocalRead` only did a path-join of the OpenGrok path against configured roots, which fails when the workspace is an rsync of a deep subtree (e.g. `/home/user/code/myproject`) rather than a mirror of the full build tree. Now the bypass uses a two-tier lookup:
  1. **Compile index hit** (`resolveFileFromIndex`): suffix-matches the OpenGrok path (e.g. `project/source/module/Foo.cpp`) against the absolute paths already stored in the compile index from `compile_commands.json` `file` fields (e.g. `/build/project/source/module/Foo.cpp`). Reads directly from the authoritative build-tree path. No root inference needed.
  2. **Path-join fallback** (`tryLocalRead`): unchanged, catches header files (`.h`/`.hpp`) that are not compiled units and therefore not present in the compile index.

### 🗑️ Removed

- **`opengrok-mcp.local.buildRoot` VS Code setting**: No longer needed. The build root is now inferred automatically from the `directory` fields in discovered compile databases.

- **"Local Source Layer" panel** in Configuration Manager: Removed the Build Root input and Save Local Settings button. The local layer is fully zero-config.

### 🐛 Bug Fixes

- **"What's new" notification loop** (`extension.ts`): the update notification was reappearing on every VS Code reload after a version upgrade. Root cause: `context.globalState.update('extensionVersion', currentVersion)` was called *after* `vscode.window.showInformationMessage`, which is an awaited call that can complete after the extension reloads. This meant the version was never persisted before the next activation, so the notification fired again. Fixed by moving the `globalState.update` call to before the version comparison.

- **`get_file_annotate` always 404 on OpenGrok 1.7.x** (`client.ts`): `getAnnotate()` was hardcoded to hit the `/annotate/<project>/<path>` endpoint which only exists in OpenGrok 1.12+. On 1.7.x this always returns HTTP 404. Fixed with a try/catch that attempts `/annotate/` first and falls back to `/xref/<project>/<path>?a=true` (the 1.7.x annotation URL).

- **`get_file_annotate` blame parser wrong on OpenGrok 1.7.x** (`parsers.ts`): three bugs in `parseAnnotate()` caused every blame line to produce empty revision/author/date even when the HTML contained full blame data. Root causes: (1) OpenGrok 1.7.x puts the `title` attribute on the child `<a class="r">` element, not on `<span class="blame">` itself — the parser was only checking the span. (2) The `title` format uses `changeset:` not `revision:` and `user:` not `author:`. (3) Field values are separated by `&nbsp;` (decoded to `\u00a0`) not plain spaces. All three are now handled; the parser accepts both old and new title formats.

- **`search_suggest` empty-index diagnostic** (`server.ts`): when the OpenGrok suggester index has not been built, the API returns `time: 0` in the response. The tool now surfaces a descriptive message in this case instead of the generic "No suggestions found."

### 🧪 Tests

- **106 tests passing** (up from 105)
- 1 new `parseAnnotate` test: real OpenGrok 1.7.x annotate HTML with `changeset:`/`user:`/`&nbsp;` title format (child `<a class="r">` element)

---

## [3.0.0-beta.2] - 2026-03-07

### 🐛 Bug Fixes

- **History parser** (`parseFileHistory`): fixed incorrect revision extraction. OpenGrok 1.7.x emits two `<a>` tags per revision cell — a `#` anchor link followed by the actual hash link. The parser was grabbing the first one, stripping `#`, and producing an empty string, which caused all history entries to be silently skipped. Now selects the last non-`#` link text, falling back to raw cell text.

- **Directory listing parser** (`parseDirectoryListing`): fixed empty results on real OpenGrok HTML. The actual table structure has an icon cell (`<p class="r"/>`) in `cells[0]` with no link; the entry name is in `cells[1]`. The parser was only looking in `cells[0]` and found nothing. Also fixed relative href handling — real OpenGrok emits relative hrefs (e.g. `DistributedIDA/`) instead of absolute `/xref/project/…` paths; these are now joined with the current browse path.

### ✨ New Features

- **`defs`/`refs` web search fallback**: OpenGrok 1.7.x REST API (`/api/v1/search?defs=…`) returns HTTP 400 for `defs` and `refs` search types. The client now automatically falls back to the web search endpoint (`/search?defs=…`) and parses the HTML response. This makes `search_code(search_type=defs)`, `get_symbol_context`, and all tools that use defs/refs fully functional against OpenGrok 1.7.x instances.

- **`file_type` filter** (`search_code`, `batch_search`, `search_and_read`, `get_symbol_context`): new optional parameter restricts results to a specific language. Common values: `cxx` (C++), `c`, `java`, `python`, `javascript`, `typescript`, `csharp`, `golang`, `ruby`, `perl`, `sql`, `xml`, `yaml`, `shell`, `makefile`. Passed as `?type=<value>` to the REST API or `?type=<value>` to the web search fallback.

- **`hist` search type** (`search_code`, `batch_search`, `search_and_read`): new enum value for `search_type`. Searches commit messages and change history via `/api/v1/search?hist=…`. Use this to find when a feature was introduced or who last touched a subsystem.

- **Default project** (`OPENGROK_DEFAULT_PROJECT`): new config variable. When a search tool is called without an explicit `projects` argument, this project is applied automatically. Overrideable per-call by passing `projects`. The MCP server instructions block also tells the LLM to use the configured default project.

### 🧪 Tests

- **99 tests passing** (up from 95)
- 4 new tests: real-world OpenGrok history HTML with two `<a>` per cell, real-world directory listing with icon cell and relative hrefs, web search HTML results parser for defs, web search HTML results parser for refs

---

## [3.0.0-beta.1] - 2026-03-07

This release is the result of a full token-optimization sprint. The headline number: **~92% fewer tokens** on typical codebase investigations compared to v2.x. That means Copilot Chat gets more done per context window, costs less, and produces better answers because it's no longer drowning in bloated tool responses.

> **Beta note:** All features are implemented and fully tested (95/95 tests passing). The beta label reflects that production telemetry is still being gathered. Breaking output format changes from v2.x are intentional.

### 🚀 New Tools — Compound Operations

Four new high-efficiency tools that collapse multi-step workflows into a single MCP call:

- **`batch_search`** — Execute up to 5 OpenGrok searches in parallel in a single call. Before this, Copilot would fire `search_code` 3–5 times sequentially for any multi-angle investigation (search by defs, then refs, then full text). Now it's one round trip. Each query has its own `search_type` and `max_results`. This alone turns `~4,500 tokens → ~1,200 tokens` for a 3-query investigation.

- **`search_and_read`** — Combined search + contextual file read in one call. Previously: `search_code` returns a hit, Copilot then calls `get_file_content` on the full file (often 1,500+ lines). Now: search + surrounding context lines come back together, capped at 8 KB total. Result: `search(500) + full_file(24,000) → search_and_read(~1,500)` — **~92% reduction**.

- **`get_symbol_context`** — The big one. Complete symbol investigation in a single call: (1) find the definition, (2) fetch context lines around it, (3) if it's a `.cpp` file, automatically locate and fetch the corresponding `.h`/`.hpp` header, (4) return reference samples. What used to take 4–5 sequential tool calls (~36,500 tokens) now costs one call (~2,800 tokens) — **~92% reduction**. This is the right first call for any unknown C++ symbol, class, or function.

- **`index_health`** — Lightweight diagnostic: tests the OpenGrok connection, measures latency, and reports back in one line. Use this if search results seem stale or incomplete before wasting tokens on failed queries.

### 🗜️ Formatter Rewrites — Compact Output Formats

Every response formatter was rewritten to strip decorative markdown and maximize information density:

- **Search results** (`search_code`, `find_file`): replaced multi-line markdown blocks (headings, `**Project:**` labels, `` ``` `` fences, `[View in OpenGrok]()` links) with one-liner-per-match: `path (project) Lline: content`. **~75% token reduction** per result set.

- **File content** (`get_file_content`): added smart truncation — full-file reads without `start_line`/`end_line` are capped at 200 lines (configurable via `OPENGROK_MAX_INLINE_LINES`). The truncation message tells Copilot exactly what to do: `*Showing first N of M lines. Use start_line/end_line to read specific sections.*` **~70% reduction** on blind file reads.

- **File history** (`get_file_history`): replaced markdown tables with dense one-liners: `[abc1234] user (2026-03-05): "Fix connection leak"`. Revision truncated to 8 chars, author email stripped. **~90% reduction**.

- **Directory listing** (`browse_directory`): removed 📁/📄 emojis and `### Directories`/`### Files` subheadings. Now: `DIR  src/` and `FILE config.ts (1,234 bytes)`, directories sorted first. **~50% reduction**.

- **Annotate/blame** (`get_file_annotate`): consecutive lines with the same revision + author are grouped into ranges (`abc1234 user L10-L25: <content>`). Default cap reduced from 100 lines to 50 for full-file views. **~70% reduction**.

### 🔧 Behavioral Improvements

- **`get_file_annotate` line ranges**: Added `start_line`/`end_line` parameters. Copilot can now request blame for a 20-line window instead of fetching the entire file's blame history.

- **Lowered `max_results` defaults**: `search_code` and `find_file` default from 25 → 10 results. Still 100 max if you need it. Reduces noise on typical queries.

- **Global 16 KB response cap**: Every tool response is gated through a byte-budget interceptor. Responses exceeding 16 KB (configurable via `OPENGROK_MAX_RESPONSE_BYTES`) are truncated at the last newline and a guidance message is appended. Prevents catastrophic 20 K+ token blowouts from unexpectedly large files.

- **Server-level LLM instructions**: The MCP server now advertises a `instructions` block that nudges Copilot toward correct behavior at the session level — use compound tools first, always pass line ranges, prefer `defs`/`refs` for known symbols. Zero backend cost.

- **Tightened tool descriptions**: All 8 original tool descriptions reduced to one concise sentence. The `get_file_content` description now says `ALWAYS pass start_line/end_line — never fetch full files` in caps. LLM behavior follows tool descriptions.

### 🗂️ Local Source Layer — Optional

An optional zero-dependency local layer that lets the server read source files directly from disk and resolve compiler flags from `compile_commands.json`:

- **`get_compile_info`** tool: given a source file path, returns compiler, include paths, preprocessor defines, language standard (`-std=`), and extra flags. Uses an in-memory index built from one or more `compile_commands.json` files at startup. Lookup supports absolute paths, OpenGrok-relative paths, and basename fallback.

- **Transparent `get_file_content` bypass**: when the local layer is enabled and a file resolves within a configured source root, `get_file_content` reads directly from disk instead of making an HTTP request to OpenGrok. Same response format — Copilot doesn't know the difference. Falls back to the API silently on any local read failure.

- **Security**: all paths validated with `fs.realpathSync()` and boundary-checked against configured allowed roots. Files and include paths that escape the roots are silently dropped. Path traversal sequences rejected. The `compile_commands.json` tokenizer handles both POSIX escape sequences and Windows backslash paths correctly.

- **Configuration**: enabled via `opengrok-mcp.local.enabled` (VS Code setting) or `OPENGROK_LOCAL_ENABLED=true` (env var). Source roots configured via `opengrok-mcp.local.compileDbRoots` (array of directory paths in VS Code settings) or `OPENGROK_LOCAL_COMPILE_DB_ROOTS` (comma-separated env var).

### 🧪 Tests

- **95 tests passing** (up from 45 in v2.x)
- 23 new tests for `compile-info.ts`: parser (arguments-array and command-string formats), security (out-of-root path rejection for both source files and include paths), resilience (missing files, malformed JSON, missing fields, empty-roots failsafe), and multi-DB merge
- Existing formatter tests updated for new compact output formats
- All tests run in-process with no network — fast and CI-safe

### Configuration Reference

New environment variables / VS Code settings in v3.0:

| Variable | Setting | Default | Description |
|---|---|---|---|
| `OPENGROK_MAX_INLINE_LINES` | — | `200` | Max lines returned for a full-file read |
| `OPENGROK_MAX_RESPONSE_BYTES` | — | `16384` | Hard cap (bytes) on any tool response |
| `OPENGROK_LOCAL_ENABLED` | `opengrok-mcp.local.enabled` | `false` | Enable local file read bypass + compile info |
| `OPENGROK_LOCAL_COMPILE_DB_ROOTS` | `opengrok-mcp.local.compileDbRoots` | `""` | Comma-separated directories containing `compile_commands.json` |
| `OPENGROK_DEFAULT_PROJECT` | — | `""` | Default project applied when `projects` argument is omitted |

## [2.1.2] - 2026-03-01

### Added

- **Modern Connection Manager**: Replaced traditional setup prompts with a sleek, centered webview interface featuring dark/light mode theming.
- **First-Time Setup Auto-Reload**: Introduced graceful `needsReloadForTools` tracking to correctly prompt a VS Code Window Reload only on completely fresh installations.

### Changed

- Auto-Test connection runs smoothly and silently immediately after clicking the new 'Save Settings' webview button.
- Updated README.md instructions with accurate automated setup flow logic and new visual screenshots.

## [2.0.7] - 2026-02-26

### Security

- **AES-256-CBC encrypted credential files**: Passwords are now encrypted before being written to temporary files, adding defense-in-depth protection
- **Secure file deletion**: Credential files are overwritten with random data before deletion, preventing forensic recovery
- Encryption key is passed via environment variable (not visible in process arguments)

### Changed

- Stale credential file cleanup now uses 60-second threshold (handles VS Code's lazy MCP server spawning)
- Removed timer-based cleanup in favor of on-demand cleanup during server definition requests

### Fixed

- Credential files no longer deleted before MCP server can read them (VS Code spawns servers lazily on first tool invocation)

## [2.0.6] - 2026-02-26

### Security

- **Credential file cleanup**: Extension now guarantees credential file deletion after 2 seconds, even if the MCP server is already running and doesn't read the file
- Old credential files are cleaned up when new server definitions are requested
- All credential files are cleaned up on extension deactivation

## [2.0.5] - 2026-02-26

### Security

- **Secure credential file handling**: Passwords are now passed to the MCP server via temporary files instead of environment variables, preventing exposure via process inspection (`ps`, `/proc`, Task Manager)
- Credential files are created with restricted permissions (`0o600` on Unix, ACL-hardened on Windows)
- Files are deleted immediately after reading, minimizing the exposure window

### Added

- Comprehensive test suite for credential file security (8 new tests)

### Fixed

- Credentials no longer visible in process environment listings

## [2.0.4] - 2026-02-21

### Added

- Created a quick-access `OpenGrok: Status Menu` available by clicking the bottom-right status bar icon, making connection testing and settings trivially accessible.

### Changed

- Revised README setup instructions to perfectly match the interactive wizard flow (Configure -> Test -> Reload).

## [2.0.3] - 2026-02-21

### Changed

- Improved Setup & Configuration documentation in README.md

### Fixed

- Fixed MCP tool caching issue by providing extension version in server definition (Copilot now correctly refreshes tools on update)

## [2.0.2] - 2026-02-21

### Added

- Automatic version tracking and update notifications
- Version management scripts (patch, minor, major releases)
- Automated CI/CD release pipeline
- Complete release workflow documentation (RELEASE_WORKFLOW.md, VERSIONING.md)

### Changed

- Extension now uses VS Code's bundled Node.js runtime (fixes Windows compatibility)
- README updated to use natural language for Copilot Chat interactions
- Releases now fully automated - no manual VSIX uploads needed

### Fixed

- Windows "spawn node ENOENT" error when Node.js not in PATH

## [2.0.0] - 2026-02-21

### Added

- Complete TypeScript rewrite
- Native MCP (Model Context Protocol) server integration
- Support for 8 OpenGrok operations:
  - Full-text code search
  - Symbol definitions and references
  - File path search
  - File content retrieval with line ranges
  - File history and git annotations
  - Directory browsing
  - Project listing
  - Search suggestions
- Secure credential storage using VS Code SecretStorage (OS keychain)
- Intelligent caching with TTL and size limits
- Rate limiting and retry logic
- SSRF and path traversal protections
- 45 comprehensive unit tests

### Changed

- Migrated from Python to TypeScript
- Bundled as single VSIX with no external dependencies
- Uses VS Code's built-in Node.js runtime

### Fixed

- SSL certificate handling for internal/self-signed CAs
- Windows compatibility issues

### Security

- Passwords stored in OS keychain (never in plain text)
- Error messages sanitized to prevent credential leakage
- Secure temporary file-based credential passing to server process (improved in 2.0.5)

## [1.0.0] - Previous

- Original Python implementation

---

## Version Numbering

We use [Semantic Versioning](https://semver.org/):

- **MAJOR** (X.0.0): Breaking changes or major feature overhauls
- **MINOR** (x.Y.0): New features, backwards compatible
- **PATCH** (x.y.Z): Bug fixes, minor improvements
