# Contributing & Development Guide

## Project Structure

```
opengrokmcp-standalone/
├── src/
│   ├── extension.ts             # VS Code extension entry point
│   ├── server/                  # MCP Server (TypeScript)
│   │   ├── main.ts              # Server entry point
│   │   ├── server.ts            # MCP protocol handler + tool dispatch
│   │   ├── tool-schemas.ts      # Zod → JSON Schema tool definitions
│   │   ├── client.ts            # OpenGrok HTTP client
│   │   ├── config.ts            # Env-var config (Zod-validated)
│   │   ├── models.ts            # Zod schemas + TypeScript interfaces
│   │   ├── parsers.ts           # HTML parsers (node-html-parser)
│   │   ├── formatters.ts        # Markdown output formatters
│   │   ├── logger.ts            # Structured logging
│   │   └── local/
│   │       └── compile-info.ts  # Local FS layer (compile_commands.json)
│   ├── tests/                   # Unit tests (Vitest, 476 tests)
│   │   ├── parsers.test.ts
│   │   ├── formatters.test.ts
│   │   ├── client.test.ts
│   │   ├── server.test.ts
│   │   ├── fixtures/html.ts     # HTML fixture strings
│   │   └── local/
│   │       └── compile-info.test.ts
│   └── webview/
│       └── configManager.html   # Configuration Manager UI
├── package.json
├── tsconfig.json
├── esbuild.js                   # Builds both extension and server
├── eslint.config.mjs            # ESLint flat config (typescript-eslint)
├── vitest.config.ts
└── scripts/
    ├── release.ps1              # Automated release script
    ├── build-vsix.js
    └── package-server.js        # Standalone server archives
```

---

## Development Setup

### Prerequisites

- Node.js 22+
- VS Code 1.85+
- Git

### Install & Build

```bash
npm install
npm run compile     # esbuild bundle
npm test            # Run Vitest unit tests
npm run lint        # TypeScript type-check
```

### Launch in Debug Mode

1. Open the project root in VS Code
2. Press `F5` to launch Extension Development Host
3. The bundled MCP server starts automatically

---

## Architecture

### Data Flow

```
User (Copilot Chat)
        │
        ▼
┌─────────────────────┐
│  GitHub Copilot     │
│  (MCP Client)       │
└──────────┬──────────┘
           │ stdio (JSON-RPC)
           ▼
┌─────────────────────┐
│  MCP Server         │
│  server/main.ts     │──────────▶ OpenGrok (REST API + HTML)
│  server/server.ts   │
│                     │──────────▶ Local FS (compile_commands.json)
└─────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
| :------- | :-------- |
| TypeScript (not Python) | Bundles into extension — no separate runtime install |
| native `fetch` (not axios) | Node 18+ built-in, no extra dep |
| `node-html-parser` (not jsdom) | Pure JS, fast, no native deps |
| Zod 4 for config + validation | Type-safe parsing of env vars and tool args |
| `p-retry` for retries | Configurable exponential backoff |
| TTL cache with byte budget | Prevents OOM from large file caching |
| Compound tools (`get_symbol_context`, `search_and_read`, `batch_search`) | Collapse multi-step patterns into a single call — ~75–92% token savings |
| HTML fallback parsing | Gracefully handle OpenGrok instances where REST API is disabled |
| 16 KB response cap | Prevents blowing up Copilot's context window |

---

## Adding a New MCP Tool

1. **Add Zod schema** in `src/server/models.ts`:

```typescript
export const MyNewToolArgs = z.object({
  param1: z.string().min(1),
  param2: z.number().int().default(10),
});
```

2. **Add tool definition** to `TOOL_DEFINITIONS` in `src/server/tool-schemas.ts`

3. **Add dispatch case** in `dispatchTool()` in `src/server/server.ts`:

```typescript
case "my_new_tool": {
  const args = MyNewToolArgs.parse(rawArgs);
  const result = await client.myMethod(args.param1, args.param2);
  return formatMyResult(result);
}
```

4. **Add client method** in `src/server/client.ts`:

```typescript
async myMethod(param1: string, param2: number): Promise<MyType> {
  const url = buildSafeUrl(this.baseUrl, `api/v1/endpoint`);
  url.searchParams.set("param", param1);
  const response = await this.request(url, TIMEOUTS.default, "application/json");
  return (await response.json()) as MyType;
}
```

5. **Add formatter** in `src/server/formatters.ts` for the Markdown output

6. **Add unit tests** in `src/tests/`

---

## Security Practices

### Credential Storage

- **VS Code Extension**: Uses `SecretStorage` API (system keychain, per-user, encrypted)
- **MCP Server**: Receives password via `OPENGROK_PASSWORD` env var (set by extension at spawn)
- **Never** in `settings.json`, log files, or command-line args

### Input Validation

Every tool call goes through a Zod schema parse. Invalid inputs return a user-friendly error without server restart.

Path traversal is rejected in `assertSafePath()` before any HTTP request is made. SSRF is prevented via `buildSafeUrl()` which verifies the resolved URL hostname matches the configured base URL.

### Error Handling

Internal errors (stack traces, URLs) are logged to stderr only. The AI agent receives only a sanitized message via `sanitizeErrorMessage()`.

---

## Testing

```bash
npm test            # Run all unit tests
npm run test:watch  # Watch mode
```

Test files mirror the source: `src/tests/parsers.test.ts` tests `src/server/parsers.ts`, etc.

Fixture HTML strings are in `src/tests/fixtures/html.ts`.

---

## Building for Release

```bash
npm run vsix
# Creates opengrok-mcp-X.Y.Z.vsix
```

---

## Release Workflow

The extension uses [Semantic Versioning](https://semver.org/). Releases are automated via GitHub Actions.

### Version Bump Commands

```bash
npm run release:patch    # Bug fixes:        1.0.0 → 1.0.1
npm run release:minor    # New features:     1.0.0 → 1.1.0
npm run release:major    # Breaking changes: 1.0.0 → 2.0.0
```

### Automated Release Script (Recommended)

```powershell
# Dry-run (test without making changes)
.\scripts\release.ps1 -Version patch -Dry

# Actual release
.\scripts\release.ps1 -Version [patch|minor|major]
```

The script will:
1. Verify Git status is clean
2. Bump version in `package.json`
3. Run tests
4. Build and package VSIX locally
5. Create Git commit and tag

### Push to GitHub

```bash
git push origin <your-branch>
git push origin vX.Y.Z        # Tag push triggers CI/CD
```

GitHub Actions automatically runs tests, builds the VSIX, creates a [GitHub Release](https://github.com/IcyHot09/opengrok-mcp-server/releases), and attaches the VSIX as a download.

### Manual Release (Fallback)

If CI is unavailable:

```bash
npm run compile && npm run vsix
# Go to GitHub > Releases > Draft a new release
# Select tag, upload the VSIX, add release notes from CHANGELOG.md
```

### Version Tracking in Extension

On activation the extension reads its version from `package.json`, compares with the stored version in VS Code global state, and if updated, notifies the user to reload and enable new tools.

### CI/CD Pipeline (GitHub Actions)

| Trigger | What runs |
| :------ | :-------- |
| Every commit / PR | Lint + unit tests |
| Tag push (`vX.Y.Z`) | Full build + GitHub Release with artifacts |

---

## Enterprise Deployment

### Network Share

```text
\\server\tools\vscode-extensions\opengrok-mcp-X.Y.Z.vsix
```

```powershell
code --install-extension "\\server\tools\opengrok-mcp-X.Y.Z.vsix"
```

### Pre-configured Settings

```json
{
    "opengrok-mcp.baseUrl": "https://your-opengrok-server/source/",
    "opengrok-mcp.verifySsl": true
}
```

---

## Support Matrix

| Platform | VS Code | Node.js | Status |
| :------- | :------ | :------ | :----- |
| Windows 10/11 | 1.85+ | 18+ (bundled) | ✅ |
| macOS 12+ | 1.85+ | 18+ (bundled) | ✅ |
| Ubuntu 22.04+ | 1.85+ | 18+ (bundled) | ✅ |

> Node.js is bundled with VS Code so users don't need to install it separately.
