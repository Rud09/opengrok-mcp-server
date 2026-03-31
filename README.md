<div align="center">

<img src="images/icon.png" width="120" alt="OpenGrok MCP Server logo">

# OpenGrok MCP Server

**MCP server bridging OpenGrok search engine with AI for instant context across massive codebases**

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/IcyHot09.opengrok-mcp-server?label=VS%20Code%20Marketplace&logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=IcyHot09.opengrok-mcp-server) [![Installs](https://img.shields.io/visual-studio-marketplace/i/IcyHot09.opengrok-mcp-server)](https://marketplace.visualstudio.com/items?itemName=IcyHot09.opengrok-mcp-server) [![npm](https://img.shields.io/npm/v/opengrok-mcp-server?logo=npm)](https://www.npmjs.com/package/opengrok-mcp-server) [![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-blue)](https://registry.modelcontextprotocol.io) [![CI](https://github.com/IcyHot09/opengrok-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/IcyHot09/opengrok-mcp-server/actions/workflows/ci.yml) [![GitHub Release](https://img.shields.io/github/v/release/IcyHot09/opengrok-mcp-server)](https://github.com/IcyHot09/opengrok-mcp-server/releases)

</div>

---

<details>
<summary>📚 Table of Contents</summary>

- [Overview](#overview)
- [How to Install](#how-to-install)
- [Configuration Guide](#configuration-guide)
- [Prompting Examples](#prompting-examples)
- [Tool Reference](#tool-reference)
- [VS Code Integration](#vs-code-integration)
- [System Architecture](#system-architecture)
- [Building & Testing](#building--testing)
- [Troubleshooting & Support](#troubleshooting--support)
- [License Information](#license-information)

</details>

---

## Overview

> 💡 **Self-Contained Architecture:** The VS Code extension includes the MCP server pre-packaged. You don't need Python, external Node.js installations, or complex environment setups. Just install and go.

---

## How to Install

### 1. Interactive Setup Wizard (Recommended for CLI clients)

Run the guided setup wizard — it configures your MCP client and stores credentials securely:

```bash
npx opengrok-mcp setup
```

Supports **Claude Code CLI**, **VS Code/Copilot CLI**, and **Codex CLI**. Credentials are stored in the OS keychain (`@napi-rs/keyring`) with an AES-256-GCM encrypted file fallback for headless environments.

### 2. From the VS Code Marketplace (Easiest for VS Code)

Inside VS Code, open the Extensions view (`Ctrl+Shift+X`), search for **"OpenGrok MCP Server"**, and hit Install.

### 3. Global NPM Package

```bash
# Run directly without installing permanently
npx opengrok-mcp-server

# Or install it globally on your system
npm install -g opengrok-mcp-server
```

### 4. Via the MCP Registry

We are officially listed in the [Model Context Protocol Registry](https://registry.modelcontextprotocol.io) under `io.github.IcyHot09/opengrok-mcp-server`. Clients with registry integration can locate and install it natively.

### Option 5 — Install pre-built VSIX

1. Download the latest VSIX file from [GitHub Releases](https://github.com/IcyHot09/opengrok-mcp-server/releases).
2. Install it in VS Code:
   - **Open the terminal** in VS Code and run: `code --install-extension opengrok-mcp-server-X.Y.Z.vsix`
   - **OR** go to the Extensions tab → click the `···` menu → **Install from VSIX…** and select the file.
3. **Updates are automatic** — the extension checks GitHub Releases once per day and offers one-click install.

<details>
<summary>🛠️ Option 6 — Build from source <em>(For developers)</em></summary>

```bash
git clone https://github.com/IcyHot09/opengrok-mcp-server.git
cd opengrok-mcp-server
npm install
npm run vsix          # Creates opengrok-mcp-server-*.vsix
code --install-extension opengrok-mcp-server-*.vsix
```

</details>

---

## Configuration Guide

1. **Provide Connection Details:**
   - After installation, the **Settings panel** will launch.
   - Input your OpenGrok endpoint, username, and password. Hit **Save Settings**. *(Credentials are locked in your native OS keychain).*
   - The plugin verifies the connection instantly. On your first run, VS Code will ask you to **Reload the Window** to register the MCP tools.
   - *(Need to change this later? Use the `OpenGrok: Manage Configuration` command or click the gear icon in the status bar).*

2. **Activate the MCP Source in Copilot:**
   - Launch the **GitHub Copilot Chat** window. Ensure you're using **Agent** mode.
   - Click the paperclip/tools icon (`🔧`) in the prompt box.
   - (If an **Update Tools** button appears, click it).
   - Locate **OpenGrok** in the list, check the box, and confirm.

> ⚠️ Note that VS Code manages tool authorizations **per workspace**. If you open a different repository, you may need to re-check the OpenGrok box in Copilot.

### CLI Commands (v7.0+)

| Command | Description |
| :------ | :---------- |
| `npx opengrok-mcp setup` | Interactive wizard: configures your MCP client and stores credentials securely |
| `opengrok-mcp status` | Health check: validates connectivity and detects installed MCP clients |
| `opengrok-mcp --version` | Print version and exit |

`setup` supports Claude Code CLI, VS Code/Copilot CLI, and Codex CLI. Credentials are stored in the OS keychain with an AES-256-GCM encrypted file fallback for headless/CI environments.

### 🔌 Third-Party Client Support

While tailored for VS Code, the integrated server logic runs perfectly with other agents natively supporting the MCP protocol, including:

**Claude Desktop** | **Cursor IDE** | **Windsurf** | **Claude Code** | **Google Antigravity**

> **👉 Refer to [MCP_CLIENTS.md](MCP_CLIENTS.md)** for configuration snippets, terminal wrapper scripts, and advanced daemon setups.

---

## Prompting Examples

Talk to GitHub Copilot Chat naturally about your codebase:

```text
Find the implementation of the render_pipeline function within the graphics engine project.

Retrieve the contents of /src/utils/math.cpp from line 450 to 520.

What is the definition of TextureManager? Please show me the header file declaration too.

Look for all places in the code where ThreadPool is instantiated or referenced.
```

---

## Tool Reference

### Primary Operations

| Tool Name | Purpose |
| ---- | ----------- |
| `opengrok_search_code` | General search utility (full-text, defs, refs, path, history). Supports `file_type` filtering. |
| `opengrok_find_file` | Locate files by name or directory pattern. |
| `opengrok_get_file_content` | Read source code (requires `start_line` and `end_line` for large files). |
| `opengrok_get_file_history` | Retrieve commit history logs. |
| `opengrok_browse_directory` | View folder structure and contained files. |
| `opengrok_list_projects` | See all indexed repositories/projects. |
| `opengrok_get_file_annotate` | See line-by-line git blame information. |
| `opengrok_get_file_symbols` | Extract classes, functions, macros, and structs rapidly from a single file. |
| `opengrok_search_suggest` | Get query autocomplete recommendations. |

### 🚀 Optimized Workflows (Compound Tools)

> 💡 These specialized tools merge multiple network requests into a single operation, reducing API chatter and cutting token usage by **up to 90%**.

| Compound Tool | Functionality Replaced | Efficiency Gain |
| ---- | ---------------- | ------------- |
| `opengrok_get_symbol_context` | 1) searches definition, 2) reads source, 3) fetches headers, 4) gets references | **~92% fewer tokens** |
| `opengrok_search_and_read` | 1) executes search, 2) immediately fetches surrounding code context | **~92% fewer tokens** |
| `opengrok_batch_search` | Combines 2-5 individual search queries; deduplicates `file:line` hits across queries | **~73% fewer tokens** |
| `opengrok_index_health` | Checks latency, backend connectivity, staleness score, and latency trend | Diagnostic utility |

*(Note: The search functions support language filtering. Pass `file_type` as `java`, `cxx`, `python`, `golang`, etc.)*

### 🔍 Investigation & Analysis Tools (v5.5+)

| Tool | Purpose |
| ---- | ------- |
| `opengrok_what_changed` | Recent line changes grouped by commit — author, date, SHA, changed lines with context |
| `opengrok_dependency_map` | BFS traversal of `#include`/`import` chains up to configurable depth (1–3); directed graph with `uses`/`used_by` |
| `opengrok_search_pattern` | Regex code search via `regexp=true`; returns `file:line:content` matches |
| `opengrok_blame` | Git blame with line range (`start_line`/`end_line`); returns author, date, commit per line |
| `opengrok_call_graph` | Call chain tracing via OpenGrok API v2 `/symbol/{name}/callgraph` (requires `OPENGROK_API_VERSION=v2`) |
| `opengrok_get_file_diff` | Unified diff between two revisions with full context lines — shows surrounding code so AI understands *why* a change was made; use `opengrok_get_file_history` to discover revision hashes |

### 🧠 Memory & Session Tools (v5.4+)

| Tool | Purpose |
| ---- | ------- |
| `opengrok_memory_status` | Shows both memory files (status, bytes, 3-line preview) — helps LLM decide whether to read |
| `opengrok_read_memory` | Read `active-task.md` or `investigation-log.md` from the Living Document memory bank |
| `opengrok_update_memory` | Write or append to memory files; auto-timestamps `investigation-log.md` entries |
| `opengrok_get_task_result` | Poll async task status by task ID for long-running `opengrok_execute` sandbox jobs |

### 🧬 Code Mode (v5+) — For Large Multi-Language Codebases

Set `OPENGROK_CODE_MODE=true` to switch to a 2-tool interface optimised for multi-step investigations:

| Tool | Purpose |
| ---- | ------- |
| `opengrok_api` | Get the full API spec (call once at session start) |
| `opengrok_execute` | Run JavaScript in a sandboxed QuickJS VM with access to all OpenGrok operations via `env.opengrok.*` |

All `env.opengrok.*` calls appear **synchronous** inside your code — the sandbox bridges async HTTP calls transparently using a SharedArrayBuffer + Atomics channel. Token savings of 80–95% are typical for complex investigations.

```javascript
// Example opengrok_execute code
const refs = env.opengrok.search("handleCrash", { searchType: "refs", maxResults: 5 });
const first = refs.results[0];
const content = env.opengrok.getFileContent(first.project, first.path, {
  startLine: first.matches[0].lineNumber - 5,
  endLine: first.matches[0].lineNumber + 10,
});
return { callerFile: first.path, code: content.content };
```

The sandbox exposes a **Living Document Memory Bank** — two persistent markdown files that survive across turns:

| File | Size Limit | Purpose |
| ---- | ---------- | ------- |
| `active-task.md` | ≤ 4 KB | Current task state: `task:`, `last_symbol:`, `next_step:`, `open_questions:`, `status:` |
| `investigation-log.md` | ≤ 32 KB | Append-only log of findings, grouped by `## YYYY-MM-DD HH:MM:` headings |

Access via `env.opengrok.readMemory(filename)` / `env.opengrok.writeMemory(filename, content)` inside the sandbox, or via the `opengrok_read_memory` / `opengrok_update_memory` / `opengrok_memory_status` tools in classic mode. Delta encoding returns `[unchanged]` on repeated reads; richness-scored trimming keeps the most valuable log entries when space is tight.

<details>
<summary>⚙️ Automated Compilation Data (Optional)</summary>

| Tool Name | Capability |
| ---- | ----------- |
| `opengrok_get_compile_info` | Reads your local `compile_commands.json` to extract compiler flags, defines, and include directories for exact C/C++ accuracy. |

</details>

---

## VS Code Integration

### Palette Commands

| Command Prompt | Action Performed |
| :------ | :---------- |
| `OpenGrok: Manage Configuration` | Launches the interactive settings GUI |
| `OpenGrok: Configure Credentials` | Fast CLI-style input for authentication |
| `OpenGrok: Test Connection` | Validates API access and token validity |
| `OpenGrok: Show Server Logs` | Exposes background process stdout/stderr |
| `OpenGrok: Check for Updates` | Polls GitHub for new releases |
| `OpenGrok: Status Menu` | Opens the context menu directly |

### Core Settings Profile

<details>
<summary>Expand for JSON Settings Reference</summary>

| Key | Format | Primary Usage |
| :--- | :--- | :---------- |
| `opengrok-mcp.baseUrl` | `string` | The URI of your OpenGrok deployment |
| `opengrok-mcp.username` | `string` | Authentication identity |
| `opengrok-mcp.verifySsl` | `boolean` | Disable when using corporate self-signed certs (default: false) |
| `opengrok-mcp.proxy` | `string` | Optional HTTP traffic router |

</details>

### Advanced Configuration (v7 — env vars)

For the standalone server (`npx opengrok-mcp-server` or Claude Code), set these environment variables:

#### Core Settings

| Variable | Values | Description |
| :--- | :--- | :--- |
| `OPENGROK_BASE_URL` | URL | OpenGrok server base URL (required) |
| `OPENGROK_USERNAME` | string | Authentication username |
| `OPENGROK_PASSWORD` | string | Authentication password (or use `OPENGROK_PASSWORD_FILE`) |
| `OPENGROK_PASSWORD_FILE` | path | Path to AES-256-GCM encrypted credential file (auto-upgrades legacy CBC) |
| `OPENGROK_PASSWORD_KEY` | string | Decryption key for `OPENGROK_PASSWORD_FILE` |
| `OPENGROK_VERIFY_SSL` | `true` (default) / `false` | Disable TLS verification for self-signed certs |
| `OPENGROK_TIMEOUT` | integer (seconds, default: `30`) | HTTP request timeout |

#### Code Mode & Performance

| Variable | Values | Description |
| :--- | :--- | :--- |
| `OPENGROK_CODE_MODE` | `true` / `false` | Switch to 2-tool Code Mode (opengrok_api + opengrok_execute) |
| `OPENGROK_CONTEXT_BUDGET` | `minimal` (default) / `standard` / `generous` | Response size tier: 4 KB / 8 KB / 16 KB |
| `OPENGROK_RESPONSE_FORMAT_OVERRIDE` | `tsv` / `toon` / `yaml` / `text` / `markdown` | Force a response format globally for all tools |
| `OPENGROK_DEFAULT_PROJECT` | string | Default project name to scope all searches |
| `OPENGROK_DEFAULT_MAX_RESULTS` | integer (default: `25`) | Default search result limit |
| `OPENGROK_LOCAL_COMPILE_DB_PATHS` | comma-separated paths | Paths to `compile_commands.json` for C/C++ compiler flag extraction |
| `OPENGROK_ENABLE_CACHE_HINTS` | `true` / `false` (default: `false`) | Enable `cache-control: immutable` hints for prompt caching infrastructure |

#### Memory Bank

| Variable | Values | Description |
| :--- | :--- | :--- |
| `OPENGROK_MEMORY_BANK_DIR` | path | Override directory for `active-task.md` + `investigation-log.md` files |

#### Rate Limiting

| Variable | Values | Description |
| :--- | :--- | :--- |
| `OPENGROK_RATELIMIT_ENABLED` | `true` (default) / `false` | Enable token-bucket rate limiting |
| `OPENGROK_RATELIMIT_RPM` | integer (default: `60`) | Global requests-per-minute limit |
| `OPENGROK_PER_TOOL_RATELIMIT` | `tool:rpm,tool:rpm` | Per-tool RPM overrides (e.g., `opengrok_execute:10,opengrok_batch_search:20`) |

#### Response Cache

| Variable | Values | Description |
| :--- | :--- | :--- |
| `OPENGROK_CACHE_ENABLED` | `true` (default) / `false` | Enable TTL response cache |
| `OPENGROK_CACHE_MAX_SIZE` | integer (default: `500`) | Max cache entries |
| `OPENGROK_CACHE_SEARCH_TTL` | seconds (default: `300`) | Search result cache TTL |
| `OPENGROK_CACHE_FILE_TTL` | seconds (default: `600`) | File content cache TTL |
| `OPENGROK_CACHE_HISTORY_TTL` | seconds (default: `1800`) | File history cache TTL |
| `OPENGROK_CACHE_PROJECTS_TTL` | seconds (default: `3600`) | Project list cache TTL |

#### Security & Audit

| Variable | Values | Description |
| :--- | :--- | :--- |
| `OPENGROK_AUDIT_LOG_FILE` | path | File path for structured audit log (CSV or JSON) |
| `OPENGROK_ALLOWED_CLIENT_IDS` | comma-separated | Allowlisted MCP client IDs (enforcement pending SDK support) |

#### MCP Protocol Features

| Variable | Values | Description |
| :--- | :--- | :--- |
| `OPENGROK_ENABLE_ELICITATION` | `true` / `false` (default: `false`) | Enable project picker form when no project specified and >1 project exists |
| `OPENGROK_ENABLE_FILES_API` | `true` / `false` (default: `false`) | Enable FileReferenceCache for `investigation-log.md` (SHA-256 content-addressed) |
| `OPENGROK_SAMPLING_MODEL` | string | Model preference for MCP Sampling (error explanation, graph summarization) |
| `OPENGROK_SAMPLING_MAX_TOKENS` | integer (default: `256`, max: `4096`) | Token budget for MCP Sampling responses |

#### OpenGrok API

| Variable | Values | Description |
| :--- | :--- | :--- |
| `OPENGROK_API_VERSION` | `v1` (default) / `v2` | OpenGrok REST API version (`v2` required for `opengrok_call_graph`) |

#### HTTP Transport (v7.0+)

| Variable | Values | Description |
| :--- | :--- | :--- |
| `OPENGROK_HTTP_PORT` | integer | Expose Streamable HTTP transport on this port (in addition to stdio) |
| `OPENGROK_HTTP_MAX_SESSIONS` | integer (default: `100`) | Max concurrent HTTP sessions before new connections are rejected |
| `OPENGROK_HTTP_AUTH_TOKEN` | string | Static Bearer token for HTTP endpoint authentication |
| `OPENGROK_JWKS_URI` | URL | JWKS endpoint for JWT validation (OAuth 2.1 resource server mode) |
| `OPENGROK_RESOURCE_URI` | URL | This server's resource URI, advertised in RFC 9728 metadata |
| `OPENGROK_AUTH_SERVERS` | comma-separated URLs | Trusted authorization server URIs |
| `OPENGROK_SCOPE_MAP` | `scope:role,...` | Map JWT scopes to RBAC roles (e.g., `read:readonly,admin:admin`) |
| `OPENGROK_STRICT_OAUTH` | `true` / `false` | Reject requests without a valid JWT when `OPENGROK_JWKS_URI` is set |
| `OPENGROK_ALLOWED_ORIGINS` | comma-separated origins | CORS allowlist (replaces wildcard CORS) |
| `OPENGROK_RBAC_TOKENS` | `tok1:role,tok2:role` | Role-based access tokens: `admin` / `developer` / `readonly` |

#### Logging

| Variable | Values | Description |
| :--- | :--- | :--- |
| `OPENGROK_LOG_LEVEL` | `debug` / `info` (default) | Verbose structured logging to stderr |

VS Code users can set `opengrok-mcp.codeMode`, `opengrok-mcp.contextBudget`, `opengrok-mcp.memoryBankDir`, `opengrok-mcp.defaultProject`, `opengrok-mcp.responseFormatOverride`, and `opengrok-mcp.compileDbPaths` in VS Code settings instead.

> **MCP SDK Note:** This version uses `@modelcontextprotocol/sdk` v1.28.0.
> MCP SDK v2 is in pre-alpha; we will migrate when stable (expected Q3-Q4 2026).
> v2 will enable enhanced completions for tool parameters and resource templates.

---

## HTTP Transport (v7.0+)

By default the server communicates over **stdio** (standard MCP). For team deployments, you can also expose a **Streamable HTTP endpoint**:

```bash
OPENGROK_HTTP_PORT=3666 npm run serve
# or add to your MCP client config:
# "OPENGROK_HTTP_PORT": "3666"
```

### Session Management

- Each HTTP client receives an isolated `McpServer` instance (per-session factory pattern)
- Sessions expire after 30 minutes of inactivity; `OPENGROK_HTTP_MAX_SESSIONS` caps concurrent sessions (default: 100)
- `GET /mcp/sessions` returns JSON with active session count and oldest session age

### Authentication

Configure one of the following:

| Method | Config |
| ------ | ------ |
| **Static Bearer token** | `OPENGROK_HTTP_AUTH_TOKEN=mysecret` |
| **OAuth 2.1 resource server** | `OPENGROK_JWKS_URI=https://idp.example.com/.well-known/jwks.json` + `OPENGROK_RESOURCE_URI=https://opengrok-mcp.example.com` |
| **RBAC with named roles** | `OPENGROK_RBAC_TOKENS='alice-token:admin,bot-token:readonly'` |

In resource server mode, this server validates JWTs issued by your own IdP — there is no built-in `/token` endpoint. RFC 9728 protected resource metadata is served at `/.well-known/oauth-protected-resource`.

### RBAC Roles

| Role | Permissions |
| ---- | ----------- |
| `admin` | Full access to all tools and configuration |
| `developer` | All search, read, memory, and code tools |
| `readonly` | Search and read tools only; no memory writes, no code execution |

> **Fail-safe**: unknown or missing tokens default to `readonly`, not `admin`.

---

## Security (v7.0+)

v7.0 includes a comprehensive security audit with the following hardening:

| Area | Protection |
| ---- | ---------- |
| **SSRF** | DNS rebinding detection + IPv6-mapped address blocking in `buildSafeUrl` |
| **Path traversal** | NFC normalization + bidirectional Unicode character blocking |
| **HTML injection** | `he.decode` on all parser text nodes before display |
| **Prompt injection** | `escapeMarkdownField` + `fenceCode` in all formatters |
| **Token comparison** | `crypto.timingSafeEqual` for all Bearer token comparisons |
| **CORS** | Allowlist via `OPENGROK_ALLOWED_ORIGINS` (no wildcard in production) |
| **Security headers** | `X-Content-Type-Options`, `X-Frame-Options`, CSP on HTTP responses |
| **Credential encryption** | AES-256-GCM (migrated from CBC; auto-upgrades existing files) |
| **Rate limiting** | Integer-based token bucket (eliminates float drift) |
| **ReDoS** | `minimatch` for glob patterns |
| **Audit logs** | Injection-escaped structured audit entries |

> **⚠️ v7.0.0 Breaking Changes**
> - `OPENGROK_HTTP_CLIENT_ID` and `OPENGROK_HTTP_CLIENT_SECRET` removed. Migrate to `OPENGROK_JWKS_URI` + `OPENGROK_RESOURCE_URI` for OAuth 2.1 (resource server model — bring your own IdP).
> - Memory bank `migrate()` removed — the legacy 6-file layout is no longer supported. The 2-file layout (`active-task.md` + `investigation-log.md`) has been the default since v5.4.
> - CORS is now allowlist-only when `OPENGROK_ALLOWED_ORIGINS` is set; unauthenticated wildcard CORS is disabled.

---

## System Architecture

<details>
<summary>Show topological diagram</summary>

```text
 [ AI Client ]                       [ Integration Layer ]                    [ Data Source ]
                              │                                 │
 +---------------+            │       +-------------------+     │      +----------------------+
 │ GitHub        │<──(stdio)──┼──────>│ OpenGrok MCP      │<────┼─────>│ OpenGrok REST API &  │
 │ Copilot Chat  │            │       │ Server (Node.js)  │HTTP │      │ Web Interface        │
 +---------------+            │       +-------------------+     │      +----------------------+
      │    ▲                           │          │
      │    │ (Configures & Hosts)      │    (Context Optimization)
      ▼    │                           │          │
 +---------------+                     │   o Context Fetch      │      +----------------------+
 │ VS Code       │                     │   o Multi-Search       │      │ Local File System    │
 │ Extension     │                     │   o Auto-Truncate      │<─────┤ (compile_commands) │
 +---------------+                     │                        │      +----------------------+
```

The underlying code is completely packaged in the marketplace extension via `esbuild`. The server uses standard VS Code Node APIs without external VM requirements.

</details>

---

## Building & Testing

```bash
# Initializing
npm install

# Code Quality & Tests
npm run lint           # Strict TypeScript & ESLint validation
npm test               # Execute the Vitest test suite (1079 tests)
npm run test:sandbox   # Sandbox integration tests (requires compile first)
npm run test:coverage  # Coverage report (≥89% threshold)

# Packaging
npm run compile   # Generate the esbuild artifact (includes sandbox-worker.js)
npm run vsix      # Create the downloadable extension file
```

We leverage GitHub Actions for automated CD. Tagging a commit (e.g., `v1.2.3`) automatically triggers the build matrix and attaches artifacts to a new [GitHub Release](https://github.com/IcyHot09/opengrok-mcp-server/releases).

For deep-dives into the architecture or PR guidelines, please read [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Troubleshooting & Support

**The MCP tools are missing in Copilot Chat**
* Click the paperclip (`🔧`) icon to "Update Tools"
* Run `Developer: Reload Window`

**"Connection failed" errors**
* Double-check your `OPENGROK_BASE_URL`
* Make sure you aren't blocked by corporate VPNs/proxies

**401 Unauthorized / Authentication failing**
* Run the `OpenGrok: Configure Credentials` command to save your username/password again

**Self-Signed SSL Certificates**
* Turn off strict validation by setting `opengrok-mcp.verifySsl` to `false`

**Slow queries or timeouts**
* Limit the scope using the `file_type` argument or targeting a specific project
* OpenGrok might be indexing; run `opengrok_index_health`

**Need verbose logs?**
* Set the environment variable `OPENGROK_LOG_LEVEL=debug` to get extensive stdout trace data

### OpenGrok Version Compatibility

| OpenGrok Engine | Status | known limitations |
| ---------------- | ------------- | ----- |
| **v1.13.x and above** | Native Support | None (Full REST API functionality) |
| **v1.7.0 — v1.12.x** | Legacy Mode | Uses HTML scraping for symbol lookups and blame |
| **Below v1.7.0** | Unsupported | Unpredictable behaviour |

---

## License Information

This system is distributed under the [PolyForm Noncommercial License 1.0.0](LICENSE).

* ✅ **Permitted:** Personal use, hobby projects, academic research, education
* ❌ **Prohibited:** Any commercial, business, enterprise, or paid utilization

**Commercial Licensing:**
To use this extension in an enterprise context (internal tooling, CI pipelines, business infrastructure), a commercial license is strictly required. 
Reach out to [rudroy09@gmail.com](mailto:rudroy09@gmail.com) for enterprise tier pricing.

Read [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md) for full terms.
