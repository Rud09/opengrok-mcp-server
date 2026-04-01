# UI Consistency & Feature Completeness — Design Spec

**Date:** 2026-04-01  
**Scope:** Enterprise-level (Option C) — canonical naming, all missing features surfaced, VS Code settings synced  
**Surfaces affected:** WebView config panel, CLI setup wizard, VS Code `contributes.configuration`, `server.json`, `extension.ts`, `configure.ts`

---

## 1. Problem Statement

The three UI surfaces (WebView panel, CLI setup wizard, VS Code Settings panel) use different labels, different descriptions, and different defaults for the same settings. Additionally, five env vars that are fully implemented in the server are not exposed in any UI. One env var (`OPENGROK_ENABLE_CACHE_HINTS`) is a no-op and should be removed from documentation. The `opengrok-mcp.configure` "Quick Configure" command is a dead UX path that duplicates the WebView with a worse experience.

---

## 2. Canonical Strings Table

This table is the single source of truth. Every UI surface must match it exactly.

### 2.1 Connection Settings

| Setting key | Canonical label | Sub-text / description |
|---|---|---|
| `baseUrl` | Server URL | *(placeholder only: `https://opengrok.example.com/source/`)* |
| `username` | Username | *(placeholder: `e.g. jdoe`)* |
| `password` | Password | "Stored securely in the OS keychain" |
| `verifySsl` | Verify SSL/TLS Certificates | "Disable only for self-signed or internal CA certificates" |

### 2.2 Behavior Settings

| Setting key | Canonical label | Sub-text / description |
|---|---|---|
| `codeMode` | Code Mode | "Uses a sandboxed JavaScript runtime for multi-step code investigations. Reduces AI token usage by ~90%." — badge: **Recommended** |
| `defaultProject` | Default Project | "Scope all searches to this project. Leave blank to search all projects." |
| `contextBudget` | Response Detail | Options: **Compact (4 KB) — fewer tokens, lower detail** / **Standard (8 KB) — balanced, recommended** / **Detailed (16 KB) — more context, more tokens** — **default: Standard** |
| `enableElicitation` | Interactive AI Prompts | "The AI can pause to ask you questions during investigations — e.g., choosing a project, disambiguating files. Requires Claude Code v2.1.76+ or VS Code Copilot." |

### 2.3 Advanced Settings

| Setting key | Canonical label | Sub-text / description |
|---|---|---|
| `proxy` | HTTP Proxy | "Route requests through a proxy. Credentials are forwarded — use only with trusted proxies." — placeholder: `http://proxy.company.com:8080` |
| `apiVersion` | OpenGrok API Version | Options: **v1 — Compatible with all OpenGrok versions (default)** / **v2 — Required for call graph features (OpenGrok 1.12+)** |
| `responseFormatOverride` | AI Response Format | Options: **Auto — each tool picks the best format** / **TSV — compact tabular** / **TOON — token-optimized notation** / **Markdown — verbose but readable** / **JSON — programmatic use** / **YAML — hierarchical data** / **Text — raw code, no framing** |
| `memoryBankDir` | Investigation Notes Location | "Where the AI stores investigation notes between sessions. Leave blank for the default location." — placeholder: `Default: <workspace>/.opengrok/memory-bank/` (WebView) / `Default: ~/.config/opengrok-mcp/memory-bank/` (CLI) |
| `compileDbPaths` | C/C++ Compile Commands Paths | "Comma-separated paths to `compile_commands.json`. Leave blank for automatic workspace discovery." |
| `enableFilesApi` | Files API Cache | "Avoids re-uploading unchanged investigation notes to the AI. Requires Files API support in your MCP client." |
| `samplingModel` | AI Sampling Model | "Preferred model for AI sampling (error explanations, query reformulation). Leave blank for the client default." |
| `samplingMaxTokens` | AI Sampling Token Budget | "Maximum tokens for AI sampling responses. Range: 64–4096." — default: 256 |
| `auditLogFile` | Audit Log File | "Write structured audit events (tool invocations, elicitation, errors) to a file. CSV/JSON format. Leave blank to disable." |
| `rateLimitRpm` | Request Rate Limit | "Maximum requests per minute sent to the OpenGrok server. Default: 60." |

### 2.4 Deprecated / Removed

| Item | Action |
|---|---|
| `OPENGROK_ENABLE_CACHE_HINTS` | No-op — do not surface in any UI; add `markdownDeprecationMessage` in `package.json` |
| `opengrok-mcp.configure` command ("Quick Configure") | **Remove** — redundant with WebView panel, provides a worse UX |

---

## 3. Context Budget Default Fix

A bug exists in `extension.ts:645`:
```typescript
// CURRENT — wrong fallback
const contextBudget = config.get<string>('contextBudget') ?? 'minimal';

// FIXED
const contextBudget = config.get<string>('contextBudget') ?? 'standard';
```

The `package.json` declares `"default": "standard"`, `config.ts` server-side defaults to `"standard"`, and the CLI wizard shows `"standard"` as initial value. The MCP provider fallback must match. Also `server.json` currently has `"default": "minimal"` — fix to `"standard"`.

---

## 4. Changes by File

### 4.1 `package.json`

**Commands — remove:**
```json
{ "command": "opengrok-mcp.configure", "title": "OpenGrok: Configure Credentials" }
```

**ActivationEvents — remove:**
```
"onCommand:opengrok-mcp.configure"
```

**Settings — update existing:**

`opengrok-mcp.contextBudget`:
- `enumDescriptions`: `["Compact (4 KB) — fewer tokens, lower detail", "Standard (8 KB) — balanced, recommended", "Detailed (16 KB) — more context, more tokens"]`
- `markdownDescription`: "Controls how much context the AI receives per response. Compact uses fewer tokens; Detailed provides more context. Maps to `OPENGROK_CONTEXT_BUDGET`."

`opengrok-mcp.enableElicitation`:
- `markdownDescription`: "**Interactive AI Prompts** — The AI pauses to ask you questions during investigations (e.g., choosing a project, disambiguating files). Requires Claude Code v2.1.76+ or VS Code Copilot. Maps to `OPENGROK_ENABLE_ELICITATION` env var."

`opengrok-mcp.codeMode`:
- `markdownDescription`: "**Code Mode (Recommended)** — Uses a sandboxed JavaScript runtime for multi-step code investigations. Reduces AI token usage by ~90%. Maps to `OPENGROK_CODE_MODE` env var."

`opengrok-mcp.verifySsl`:
- `markdownDescription`: "Validates server SSL/TLS certificates. Disable only for self-signed or internal CA certificates. Maps to `OPENGROK_VERIFY_SSL`."

**Settings — add new (in order after `compileDbPaths`):**

```json
"opengrok-mcp.enableFilesApi": {
  "type": "boolean",
  "default": false,
  "markdownDescription": "**Files API Cache** — Avoids re-uploading unchanged investigation notes to the AI. Requires Files API support in your MCP client. Maps to `OPENGROK_ENABLE_FILES_API` env var.",
  "order": 13
},
"opengrok-mcp.samplingModel": {
  "type": "string",
  "default": "",
  "markdownDescription": "Preferred model for AI sampling (error explanations, query reformulation). Leave blank for the client default. Maps to `OPENGROK_SAMPLING_MODEL` env var.",
  "order": 14
},
"opengrok-mcp.samplingMaxTokens": {
  "type": "integer",
  "default": 256,
  "minimum": 64,
  "maximum": 4096,
  "markdownDescription": "Maximum tokens for AI sampling responses. Range: 64–4096. Maps to `OPENGROK_SAMPLING_MAX_TOKENS` env var.",
  "order": 15
},
"opengrok-mcp.auditLogFile": {
  "type": "string",
  "default": "",
  "markdownDescription": "Path to write structured audit events (tool invocations, elicitation, errors). Appends CSV/JSON. Leave blank to disable. Maps to `OPENGROK_AUDIT_LOG_FILE` env var.",
  "order": 16
},
"opengrok-mcp.rateLimitRpm": {
  "type": "integer",
  "default": 60,
  "minimum": 1,
  "markdownDescription": "Maximum requests per minute sent to the OpenGrok server. Default: 60. Maps to `OPENGROK_RATELIMIT_RPM` env var.",
  "order": 17
},
"opengrok-mcp.enableCacheHints": {
  "type": "boolean",
  "default": false,
  "markdownDeprecationMessage": "This setting is a no-op. The MCP SDK does not yet expose cache_control breakpoints. It will be removed in a future release.",
  "markdownDescription": "**Deprecated — no-op.** The SDK does not yet support explicit cache_control headers. This setting has no effect.",
  "order": 18
}
```

### 4.2 `server.json`

- `OPENGROK_CONTEXT_BUDGET.default`: `"minimal"` → `"standard"`
- `OPENGROK_ENABLE_ELICITATION.description`: `"Enable interactive project picker at session start and env.opengrok.elicit() in Code Mode sandbox. Requires a supporting MCP client."` → `"Interactive AI Prompts — the AI pauses to ask questions during investigations (project selection, file disambiguation). Requires Claude Code v2.1.76+ or VS Code Copilot."`
- Add entries:

```json
{
  "name": "OPENGROK_ENABLE_FILES_API",
  "description": "Files API Cache — avoids re-uploading unchanged investigation notes. Requires Files API support in the MCP client.",
  "format": "boolean",
  "isRequired": false,
  "isSecret": false,
  "default": "false"
},
{
  "name": "OPENGROK_SAMPLING_MAX_TOKENS",
  "description": "Maximum tokens for AI sampling responses (error explanation, query reformulation). Range: 64–4096.",
  "format": "string",
  "isRequired": false,
  "isSecret": false,
  "default": "256"
},
{
  "name": "OPENGROK_AUDIT_LOG_FILE",
  "description": "Path to write structured audit events (CSV/JSON). Appends tool invocations, elicitation events, and errors. Leave unset to disable.",
  "format": "string",
  "isRequired": false,
  "isSecret": false
},
{
  "name": "OPENGROK_RATELIMIT_RPM",
  "description": "Maximum requests per minute to the OpenGrok server. Default: 60.",
  "format": "string",
  "isRequired": false,
  "isSecret": false,
  "default": "60"
}
```

### 4.3 `src/server/cli/setup/wizard.ts`

**All label changes:**

| Current prompt | New prompt |
|---|---|
| `message: 'Context budget'` | `message: 'Response detail level'` |
| Option: `'minimal (4 KB) — lowest token usage...'` | `'Compact (4 KB) — fewer tokens, lower detail'` |
| Option: `'standard (8 KB) — balanced'` | `'Standard (8 KB) — balanced, recommended'` |
| Option: `'generous (16 KB) — more context'` | `'Detailed (16 KB) — more context, more tokens'` |
| `message: 'Enable Code Mode? (2-tool API: 98% fewer tokens — recommended for large codebases)'` | `message: 'Enable Code Mode? (sandboxed JS runtime — ~90% fewer tokens, recommended for large codebases)'` |
| `message: 'Enable AI project picker? When no default project is set...'` | `message: 'Enable Interactive AI Prompts? The AI can pause to ask questions during investigations (e.g., project selection, file disambiguation). Requires Claude Code v2.1.76+ or VS Code Copilot'` |
| `message: 'Verify SSL certificate? (disable only for self-signed or internal CA servers)'` | `message: 'Verify SSL/TLS certificates? (disable only for self-signed or internal CA certificates)'` |
| Response format option: `'Force Markdown'` | `'Markdown — verbose but readable'` |
| Response format option: `'Force JSON'` | `'JSON — programmatic use'` |
| Response format option: `'Force TSV (compact table)'` | `'TSV — compact tabular'` |
| Response format option: `'Force TOON (token-optimized notation)'` | `'TOON — token-optimized notation'` |
| Response format option: `'Force YAML (hierarchical data)'` | `'YAML — hierarchical data'` |
| Response format option: `'Force Text (raw code, no framing)'` | `'Text — raw code, no framing'` |
| Memory bank dir: `'...leave blank for default ~/.config/opengrok-mcp/memory-bank/'` | `'...leave blank for default: ~/.config/opengrok-mcp/memory-bank/'` |
| Advanced gate: `'Configure advanced settings? (proxy, API version, response format, memory bank)'` | `'Configure advanced settings? (proxy, API version, response format, memory bank, audit log, rate limit)'` |

**New advanced prompts (appended after `compileDbVal` inside the `if (wantsAdvanced)` block):**

```typescript
const enableFilesApiVal = await p.confirm({
  message: 'Enable Files API cache? (avoids re-uploading unchanged investigation notes to the AI)',
  initialValue: false,
});
if (p.isCancel(enableFilesApiVal)) { p.cancel('Setup cancelled'); process.exit(0); }

const samplingModelVal = await p.text({
  message: 'AI sampling model (leave blank for client default)',
  defaultValue: '',
});
if (p.isCancel(samplingModelVal)) { p.cancel('Setup cancelled'); process.exit(0); }

const samplingMaxTokensVal = await p.text({
  message: 'AI sampling token budget (default: 256, range: 64–4096)',
  defaultValue: '256',
  validate: (v) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 64 || n > 4096) return 'Enter a number between 64 and 4096';
  },
});
if (p.isCancel(samplingMaxTokensVal)) { p.cancel('Setup cancelled'); process.exit(0); }

const auditLogFileVal = await p.text({
  message: 'Audit log file path (leave blank to disable)',
  defaultValue: '',
});
if (p.isCancel(auditLogFileVal)) { p.cancel('Setup cancelled'); process.exit(0); }

const rateLimitRpmVal = await p.text({
  message: 'Request rate limit in RPM (default: 60)',
  defaultValue: '60',
  validate: (v) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1) return 'Enter a positive integer';
  },
});
if (p.isCancel(rateLimitRpmVal)) { p.cancel('Setup cancelled'); process.exit(0); }
```

**Collected variables (declare before `if (wantsAdvanced)`):**
```typescript
let enableFilesApi = false;
let samplingModel = '';
let samplingMaxTokens = '256';
let auditLogFile = '';
let rateLimitRpm = '60';
```

**Set inside `if (wantsAdvanced)`:**
```typescript
enableFilesApi = Boolean(enableFilesApiVal);
samplingModel = String(samplingModelVal);
samplingMaxTokens = String(samplingMaxTokensVal);
auditLogFile = String(auditLogFileVal);
rateLimitRpm = String(rateLimitRpmVal);
```

**Extend `mcpConfig` object:**
```typescript
enableFilesApi,
samplingModel,
samplingMaxTokens,
auditLogFile,
rateLimitRpm,
```

### 4.4 `src/server/cli/setup/configure.ts`

**Extend `McpConfig` interface:**
```typescript
enableFilesApi?: boolean;
samplingModel?: string;
samplingMaxTokens?: string;   // string because env vars are strings
auditLogFile?: string;
rateLimitRpm?: string;
```

**Extend `buildEnv()`:**
```typescript
if (config.enableFilesApi)    env['OPENGROK_ENABLE_FILES_API'] = 'true';
if (config.samplingModel)     env['OPENGROK_SAMPLING_MODEL'] = config.samplingModel;
if (config.samplingMaxTokens && config.samplingMaxTokens !== '256')
                               env['OPENGROK_SAMPLING_MAX_TOKENS'] = config.samplingMaxTokens;
if (config.auditLogFile)      env['OPENGROK_AUDIT_LOG_FILE'] = config.auditLogFile;
if (config.rateLimitRpm && config.rateLimitRpm !== '60')
                               env['OPENGROK_RATELIMIT_RPM'] = config.rateLimitRpm;
```

### 4.5 `src/extension.ts`

**Bug fix — context budget default (line ~645):**
```typescript
// BEFORE
const contextBudget = config.get<string>('contextBudget') ?? 'minimal';
// AFTER
const contextBudget = config.get<string>('contextBudget') ?? 'standard';
```

**Remove `configureCredentials()` function** (lines ~331–395) and its command registration.

**Remove from `activate()`:**
```typescript
vscode.commands.registerCommand('opengrok-mcp.configure', configureCredentials),
```

**Remove from `showStatusMenu()`:**
```typescript
{ label: '$(gear) Quick Configure', detail: 'Update credentials via input prompts', command: 'opengrok-mcp.configure' },
```

**Extend `_sendCurrentConfig()`** to read and pass the 5 new settings:
```typescript
const enableFilesApi = config.get<boolean>('enableFilesApi') ?? false;
const samplingModel = config.get<string>('samplingModel') ?? '';
const samplingMaxTokens = config.get<number>('samplingMaxTokens') ?? 256;
const auditLogFile = config.get<string>('auditLogFile') ?? '';
const rateLimitRpm = config.get<number>('rateLimitRpm') ?? 60;
// ... include in webview.postMessage config object
```

**Extend `handleSaveConfiguration()`** data type to include new fields, and add corresponding `config.update()` calls:
```typescript
if (enableFilesApi !== undefined) await config.update('enableFilesApi', enableFilesApi, vscode.ConfigurationTarget.Global);
if (samplingModel !== undefined) await config.update('samplingModel', samplingModel || undefined, vscode.ConfigurationTarget.Global);
if (samplingMaxTokens !== undefined) await config.update('samplingMaxTokens', samplingMaxTokens, vscode.ConfigurationTarget.Global);
if (auditLogFile !== undefined) await config.update('auditLogFile', auditLogFile || undefined, vscode.ConfigurationTarget.Global);
if (rateLimitRpm !== undefined) await config.update('rateLimitRpm', rateLimitRpm, vscode.ConfigurationTarget.Global);
```

**Extend `provideMcpServerDefinitions()`** to read and pass 5 new settings to `env`:
```typescript
const enableFilesApi = config.get<boolean>('enableFilesApi') ?? false;
const samplingModel = config.get<string>('samplingModel') ?? '';
const samplingMaxTokens = config.get<number>('samplingMaxTokens') ?? 256;
const auditLogFile = config.get<string>('auditLogFile') ?? '';
const rateLimitRpm = config.get<number>('rateLimitRpm') ?? 60;

if (enableFilesApi) env.OPENGROK_ENABLE_FILES_API = 'true';
if (samplingModel) env.OPENGROK_SAMPLING_MODEL = samplingModel;
if (samplingMaxTokens !== 256) env.OPENGROK_SAMPLING_MAX_TOKENS = String(samplingMaxTokens);
if (auditLogFile) env.OPENGROK_AUDIT_LOG_FILE = auditLogFile;
if (rateLimitRpm !== 60) env.OPENGROK_RATELIMIT_RPM = String(rateLimitRpm);
```

### 4.6 `src/webview/configManager.html`

**Label/description changes in HTML:**

| Element | Current | New |
|---|---|---|
| `<label for="contextBudget">` | Response Detail Level | Response Detail |
| Compact option | `Compact (4 KB) &mdash; faster, fewer AI credits` | `Compact (4 KB) &mdash; fewer tokens, lower detail` |
| Standard option | `Balanced (8 KB) &mdash; recommended for most users` | `Standard (8 KB) &mdash; balanced, recommended` |
| Detailed option | `Detailed (16 KB) &mdash; more context, more AI credits` | `Detailed (16 KB) &mdash; more context, more tokens` |
| `<label for="enableElicitation">` | AI Project Picker | Interactive AI Prompts |
| Elicitation subtext | "When no default project is set, the AI will ask which project to search. Requires Claude Code v2.1.76+ or VS Code Copilot." | "The AI can pause to ask you questions during investigations — e.g., choosing a project, disambiguating files. Requires Claude Code v2.1.76+ or VS Code Copilot." |
| Code Mode subtext | "Intelligent multi-step code investigation via a sandboxed JavaScript runtime. Dramatically reduces AI token usage." | "Uses a sandboxed JavaScript runtime for multi-step code investigations. Reduces AI token usage by ~90%." |
| verifySsl subtext | "Turn off only for self-signed or internal CA certificates" | "Disable only for self-signed or internal CA certificates" |

**New fields in Advanced section** (add after `compileDbPaths` field, before closing `</div>`):

```html
<div class="checkbox-field">
    <input type="checkbox" id="enableFilesApi">
    <div class="checkbox-content">
        <label for="enableFilesApi">Files API Cache</label>
        <div class="checkbox-subtext">Avoids re-uploading unchanged investigation notes to the AI. Requires Files API support in your MCP client.</div>
    </div>
</div>
<div class="field">
    <label for="samplingModel">AI Sampling Model</label>
    <input type="text" id="samplingModel" placeholder="Leave blank for client default">
    <div class="hint">Preferred model for AI sampling (error explanations, query reformulation).</div>
</div>
<div class="field">
    <label for="samplingMaxTokens">AI Sampling Token Budget</label>
    <input type="number" id="samplingMaxTokens" placeholder="256" min="64" max="4096">
    <div class="hint">Maximum tokens for AI sampling responses. Range: 64–4096.</div>
</div>
<div class="field">
    <label for="auditLogFile">Audit Log File</label>
    <input type="text" id="auditLogFile" placeholder="Leave blank to disable">
    <div class="hint">Write structured audit events (tool calls, prompts, errors) to a file. CSV/JSON format.</div>
</div>
<div class="field">
    <label for="rateLimitRpm">Request Rate Limit (RPM)</label>
    <input type="number" id="rateLimitRpm" placeholder="60" min="1">
    <div class="hint">Maximum requests per minute sent to the OpenGrok server.</div>
</div>
```

**JS — `saveConfiguration()`:** Add collection of 5 new fields and include in `postMessage` data.

**JS — `loadConfig` handler:** Populate 5 new fields. For `enableFilesApi`: default false. For `samplingMaxTokens` and `rateLimitRpm`: default to placeholder value if not set.

**JS — Advanced auto-open condition:** Extend to also open if any of the 5 new fields are non-default.

### 4.7 `CLAUDE.md` env var table

Update the `OPENGROK_ENABLE_ELICITATION` row:
- `true`/`false` — enable MCP Elicitation project picker` → `true`/`false` — enable Interactive AI Prompts (project selection, file disambiguation, sandbox `elicit()`)

Update `OPENGROK_CONTEXT_BUDGET` default note in the Key env vars table to show `standard` as default.

---

## 5. What Is NOT Changed

These env vars remain intentionally env-only (no UI surface):

| Env var | Reason |
|---|---|
| `OPENGROK_HTTP_PORT` | Enterprise HTTP transport — requires server restart, admin-only |
| `OPENGROK_HTTP_AUTH_TOKEN` | Security credential — must not be in VS Code settings JSON |
| `OPENGROK_HTTP_MAX_SESSIONS` | Server capacity tuning — admin-only |
| `OPENGROK_RBAC_TOKENS` | Security tokens — must not be in VS Code settings JSON |
| `OPENGROK_JWKS_URI` / `OPENGROK_RESOURCE_URI` / `OPENGROK_STRICT_OAUTH` / `OPENGROK_SCOPE_MAP` / `OPENGROK_AUTH_SERVERS` / `OPENGROK_ALLOWED_ORIGINS` | OAuth 2.1 enterprise config — admin-only, deployment-time |
| `OPENGROK_TIMEOUT` | Internal timeout (30s is always appropriate) |
| `OPENGROK_DEFAULT_MAX_RESULTS` | Internal cap (25 is always appropriate) |
| `OPENGROK_CACHE_*` | Internal cache tuning — no user-visible behavior |
| `OPENGROK_RATELIMIT_ENABLED` | Kill switch — emergency env-only |
| `OPENGROK_PER_TOOL_RATELIMIT` | Expert-only fine-tuning (global RPM is sufficient for UI) |
| `OPENGROK_ENABLE_CACHE_HINTS` | **No-op** — deprecated, SDK support not available yet |

---

## 6. Self-Review

- No placeholders or TBDs remain in this spec.
- All 5 new features map to existing server-side env vars that are fully implemented.
- Removing `opengrok-mcp.configure` does not break any other command — the webview covers its functionality completely.
- The context budget default fix (`'minimal'` → `'standard'`) is consistent with `package.json`, `config.ts`, CLI wizard, and user request.
- Memory bank default paths are intentionally different (WebView = workspace-relative, CLI = XDG home) because they serve different deployment contexts.
- `OPENGROK_ENABLE_CACHE_HINTS` gets a `markdownDeprecationMessage` in VS Code settings rather than being silently removed, so users who already have it set see a clear explanation.
- `samplingMaxTokens` and `rateLimitRpm` are stored as integers in VS Code settings (`type: "integer"`) but written to env as strings (correct — env vars are always strings).
