# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile          # build (dev, with sourcemaps)
npm run package          # build (production, minified)
npm run watch            # build in watch mode
npm test                 # run all tests (vitest)
npm run test:watch       # vitest interactive watch
npm run test:coverage    # coverage report (thresholds: 90% lines/functions, 85% branches)
npm run test:sandbox     # sandbox integration tests (requires npm run compile first)
npm run typecheck        # tsc --noEmit only
npm run lint             # tsc --noEmit + eslint src/
npm run lint:fix         # eslint --fix
npm run validate         # typecheck + lint + test (full pre-commit check)
npm run vsix             # build .vsix extension package
npm run release:patch    # bump patch version + compile + package-server + vsix
```

Run a single test file:
```bash
npx vitest run src/tests/client.test.ts
```

## Architecture

This repo produces **three separate outputs** from a single TypeScript codebase:

| Output | Entry point | External deps | Purpose |
|---|---|---|---|
| `out/extension.js` | `src/extension.ts` | `vscode` | VS Code extension host |
| `out/server/main.js` | `src/server/main.ts` | — | Standalone MCP server (also a CLI binary) |
| `out/server/sandbox-worker.js` | `src/server/sandbox-worker.ts` | — | QuickJS worker thread for Code Mode |

All three are bundled by esbuild (`esbuild.js`). The build also copies `emscripten-module.wasm` to `out/server/` and webview files to `out/webview/`. It injects `__VERSION__` as a compile-time constant and auto-syncs `server.json` version with `package.json`.

### MCP Server layer (`src/server/`)

- **`main.ts`** — Entry point. Loads config, constructs `OpenGrokClient` and `MemoryBank`, calls `runServer()`.
- **`server.ts`** — All 25 tool registrations via `McpServer.registerTool()` (MCP SDK high-level API). Contains `SERVER_INSTRUCTIONS`, `capResponse()`, `sanitizeErrorMessage()`, `registerLegacyTools()`, `registerCodeModeTools()`, and `dispatchTool()`. This is the largest file; tool handlers, MCP Resources, Prompts, Elicitation, and Sampling live here.
- **`config.ts`** — `loadConfig()` parses env vars through a Zod schema. Supports encrypted credential files (AES-256-CBC). `BUDGET_LIMITS` defines the three context budget tiers. Config is singleton and frozen.
- **`client.ts`** — `OpenGrokClient`: HTTP fetches via undici, TTL cache, token-bucket rate limiter, `p-retry` retry logic, SSRF protection (`buildSafeUrl`), path-traversal validation (`assertSafePath`).
- **`models.ts`** — Zod input schemas for all 25 tools + structured output schemas (`IndexHealthOutput`, `BlameOutput`, `WhatChangedOutput`, `DependencyMapOutput`, etc.). `RESPONSE_FORMAT` is a shared field added to every tool input schema.
- **`formatters.ts`** — Per-tool response formatters producing markdown/json/tsv/yaml/text. `selectFormat()` resolves the active format from args vs. env override.
- **`parsers.ts`** — HTML parsers for OpenGrok web responses (search results, directory listings, annotations, symbols, history).
- **`memory-bank.ts`** — `MemoryBank`: Living Document system. Two-file allow-list (`active-task.md` ≤ 4 KB + `investigation-log.md` ≤ 32 KB). Auto-migration from legacy 6-file layout. Delta encoding, richness-scored trimming, compressed initial read, `getFileReference()` for Files API. Stub detection via sentinel comment. Used by the LLM to persist investigation state across turns.
- **`sandbox.ts`** — Code Mode main-thread side. Spawns a Worker thread running `sandbox-worker.js`, bridges async HTTP calls via `Atomics.notify()` on a SharedArrayBuffer, applies a 10 s hard timeout.
- **`sandbox-worker.ts`** — Worker thread side. Runs LLM-supplied JavaScript inside a QuickJS WASM VM (`@sebastianwessel/quickjs`). Blocks on `Atomics.wait()` while the main thread performs HTTP calls. Separate esbuild entry point.
- **`intelligence.ts`** — `buildFileOverview()` and `buildCallChain()`: pre-computed summaries for Code Mode, built from parallel OpenGrok API calls.
- **`observation-masker.ts`** — `ObservationMasker`: session memory management for long Code Mode sessions. Keeps last 10 full results, summarizes older ones.
- **`api-types.ts`** — Shared TypeScript interfaces for OpenGrok REST API response shapes.
- **`logger.ts`** — Structured logger (stderr-only, JSON in production).
- **`local/compile-info.ts`** — Parses `compile_commands.json` for C/C++ compiler flags and include paths.
- **`worker-pool.ts`** — `SandboxWorkerPool`: keeps up to 2 idle QuickJS workers warm. `acquire()`/`release()`/`drain()` lifecycle with `isAlive` guard.
- **`audit.ts`** — `auditLog()`: structured audit logging to stderr + optional `OPENGROK_AUDIT_LOG_FILE` (CSV/JSON). All 25 tool invocations emit audit events.
- **`elicitation.ts`** — MCP Elicitation wrapper: `server.elicitInput()` for project-picker form with graceful fallback for unsupported clients.
- **`sampling.ts`** — `sampleOrNull()`: production MCP Sampling with retry/backoff/10 s timeout/model preference. Used for error explanation and graph summarization.
- **`task-registry.ts`** — In-memory async task store for `opengrok_execute`. `createTask()`/`completeTask()`/`failTask()`/`getTask()` with 30-min TTL for running tasks.
- **`http-transport.ts`** — Streamable HTTP transport (`OPENGROK_HTTP_PORT`). Per-session McpServer factory, session TTL sweep, CORS, OAuth 2.1 endpoints, RBAC enforcement.
- **`rbac.ts`** — RBAC engine: admin/developer/readonly roles, `hasPermission()`, `parseRbacConfig()`, `ROLE_PERMISSIONS` map, fail-safe readonly default.
- **`file-cache.ts`** — `FileReferenceCache`: SHA-256 content-addressed cache for `investigation-log.md` (`OPENGROK_ENABLE_FILES_API`).

### VS Code extension layer (`src/extension.ts`)

Manages credentials (VS Code SecretStorage + encrypted temp files), registers the `mcpServerDefinitionProviders` contribution, provides status bar, auto-update checks, and configuration UI. It spawns the MCP server process and passes credentials via encrypted temp files.

### Operational modes

- **Standard mode** (default): 25 tools, all prefixed `opengrok_`.
- **Code Mode** (`OPENGROK_CODE_MODE=true`): 2 tools only — `opengrok_api` (returns API spec) and `opengrok_execute` (runs JS in QuickJS WASM sandbox). Significant token savings for large multi-language codebases. Memory tools (`opengrok_read_memory`, `opengrok_update_memory`, `opengrok_memory_status`) available in both modes.

### Key env vars

| Variable | Purpose |
|---|---|
| `OPENGROK_BASE_URL` | OpenGrok server URL |
| `OPENGROK_USERNAME` / `OPENGROK_PASSWORD` | Auth credentials |
| `OPENGROK_VERIFY_SSL` | `true` (default) / `false` — disable for self-signed certs |
| `OPENGROK_PROXY` | HTTP proxy URL |
| `OPENGROK_CONTEXT_BUDGET` | `minimal` (4 KB) / `standard` (8 KB) / `generous` (16 KB) |
| `OPENGROK_CODE_MODE` | Enable 2-tool Code Mode |
| `OPENGROK_MEMORY_BANK_DIR` | Override memory-bank directory |
| `OPENGROK_DEFAULT_PROJECT` | Default project to scope searches to |
| `OPENGROK_RESPONSE_FORMAT_OVERRIDE` | Force `markdown` or `json` for all tool responses |
| `OPENGROK_LOCAL_COMPILE_DB_PATHS` | Comma-separated paths to `compile_commands.json` |
| `OPENGROK_ENABLE_CACHE_HINTS` | `true`/`false` — prompt caching infrastructure flag |
| `OPENGROK_API_VERSION` | `v1` (default) / `v2` — OpenGrok REST API version |
| `OPENGROK_HTTP_PORT` | Port for Streamable HTTP transport (alongside stdio) |
| `OPENGROK_HTTP_MAX_SESSIONS` | Max concurrent HTTP sessions (default: 100) |
| `OPENGROK_HTTP_AUTH_TOKEN` | Static Bearer token for HTTP endpoint |
| `OPENGROK_HTTP_CLIENT_ID` / `OPENGROK_HTTP_CLIENT_SECRET` | OAuth 2.1 client credentials |
| `OPENGROK_RBAC_TOKENS` | `token:role` pairs for RBAC (admin/developer/readonly) |
| `OPENGROK_SAMPLING_MODEL` / `OPENGROK_SAMPLING_MAX_TOKENS` | MCP Sampling model preference and budget |
| `OPENGROK_ENABLE_ELICITATION` | `true`/`false` — enable MCP Elicitation project picker |
| `OPENGROK_ENABLE_FILES_API` | `true`/`false` — enable FileReferenceCache for memory bank |
| `OPENGROK_AUDIT_LOG_FILE` | File path for structured audit log (CSV/JSON) |
| `OPENGROK_RATELIMIT_RPM` / `OPENGROK_PER_TOOL_RATELIMIT` | Global and per-tool rate limits |

### Testing notes

- Tests are in `src/tests/`, excluded from `tsconfig.json` type-checking (ESLint uses a separate tsconfig for test files).
- `vitest.config.ts` sets `fileParallelism: false` — tests share module-level mocks.
- Coverage only measures `src/server/**` (not `src/extension.ts`). `sandbox.ts` and `sandbox-worker.ts` are excluded from coverage (tested via `test:sandbox`).
- The `__VERSION__` constant is set to `'test'` in vitest via `define`.
- `npm run test:sandbox` requires a compiled build (`npm run compile`) and uses `vitest.sandbox.config.ts`.
