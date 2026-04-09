# Using OpenGrok MCP with Any Client

This guide covers how to connect the standalone OpenGrok MCP server to popular AI clients.
The interactive setup wizard (v7.0+) is the recommended approach — it handles credentials
securely via the OS keychain and writes the correct config for your client automatically.

> **VS Code / Google Antigravity users:** install the VSIX extension instead.
> It handles everything automatically. See [README.md](README.md).

---

## OpenGrok Memory Bank vs VS Code Memory

| Capability | VS Code Built-in Memory (`/memory`) | OpenGrok Memory Bank |
|-----------|-------------------------------------|---------------------|
| Scope | General codebase knowledge | Investigation-specific state |
| Files | Managed by VS Code | `active-task.md`, `investigation-log.md` |
| Auto-loaded | ✅ Every Copilot session | ❌ Requires `opengrok_memory_status` call |
| Token cost | Free (injected by VS Code) | Counts as tool calls |
| Best for | Architecture, conventions, directories | Bug investigations, multi-session research |

**Rule of thumb:** Use VS Code `/memory` for "what is this codebase". Use OpenGrok memory for "what am I currently investigating".

For non-VS Code clients:
- **Claude Code:** Put general context in `.claude.md` at project root
- **Cursor:** Put conventions in `.cursorrules`
- **Standalone CLI:** OpenGrok memory bank at `~/.config/opengrok-mcp/memory-bank/`

---

## Quick Start

### Interactive Setup Wizard (Recommended, v7.0+)

Run the guided wizard — it configures your MCP client and stores credentials securely:

```sh
npx opengrok-mcp-server setup
```

Supports **Claude Code CLI**, **GitHub Copilot CLI**, and **Codex CLI**. VS Code is configured automatically by the VS Code extension — no CLI step needed. The wizard:
- Prompts for your OpenGrok URL, username, and password
- Tests the connection
- Writes the correct MCP config file for the detected client
- Stores credentials in the OS keychain (`@napi-rs/keyring`) with an AES-256-GCM encrypted
  file fallback for headless/CI environments

Your password is **never** stored in any MCP client config file.

Check installation health at any time:

```sh
opengrok-mcp status
```

---

## Client Configurations

After running the wizard, your client config is written automatically. The examples below
show the canonical config format for each client if you need to set it up manually.

All configs use `npx opengrok-mcp-server` as the command — no global install required.
For a global install (`npm install -g opengrok-mcp-server`), replace `npx opengrok-mcp-server`
with just `opengrok-mcp`.

### Claude Code

> **Quickest setup:** `npx opengrok-mcp-server setup` — detects Claude Code and writes the config.

Scope options:
- **Project** (team-shared, no secrets): `.mcp.json` in project root
- **User** (global): `~/.claude.json`

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "npx",
      "args": ["opengrok-mcp-server"]
    }
  }
}
```

Credentials are read from the OS keychain automatically on startup — no env vars needed.

---

### VS Code (GitHub Copilot Chat)

> **Recommended:** Install the VSIX extension — it configures VS Code automatically.
> No CLI setup needed.

If you prefer manual config, create `~/.config/Code/User/mcp.json` (Linux/macOS) or
`%APPDATA%\Code\User\mcp.json` (Windows):

```json
{
  "servers": {
    "opengrok-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "opengrok-mcp-server"],
      "env": {
        "OPENGROK_BASE_URL": "https://opengrok.example.com/source/"
      }
    }
  }
}
```

---

### GitHub Copilot CLI

Run the wizard:

```sh
npx opengrok-mcp-server setup
```

The wizard detects `copilot` binary or `~/.copilot/` directory and writes the config to
`~/.copilot/mcp-config.json` automatically.

Manual config in `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "opengrok-mcp": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "opengrok-mcp-server"],
      "env": {
        "OPENGROK_BASE_URL": "https://opengrok.example.com/source/"
      }
    }
  }
}
```

---

### Cursor

Edit `.cursor/mcp.json` in your project root, or open **Cursor Settings → Features → MCP**.

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "npx",
      "args": ["opengrok-mcp-server"]
    }
  }
}
```

---

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`.

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "npx",
      "args": ["opengrok-mcp-server"]
    }
  }
}
```

---

### Claude Desktop

| OS | Config file |
| :-- | :---------- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "npx",
      "args": ["opengrok-mcp-server"]
    }
  }
}
```

Restart Claude Desktop after saving.

---

### OpenCode (opencode.ai)

Config files: `opencode.json` / `opencode.jsonc` (project) or `~/.config/opencode/opencode.json` (global).

```json
{
  "mcp": {
    "opengrok": {
      "type": "local",
      "command": ["npx", "opengrok-mcp-server"]
    }
  }
}
```

---

### Crush

Config: `~/.config/crush/config.yaml` or project-level `crush.yaml`.

```yaml
mcp:
  servers:
    opengrok:
      command: npx
      args:
        - opengrok-mcp-server
```

---

### Google Antigravity

**Recommended:** Install the VSIX extension — Gemini discovers tools automatically.

**Manual MCP config** (if you prefer not to use the extension):
Use the MCP Store in Antigravity → *View raw config* and add:

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "npx",
      "args": ["opengrok-mcp-server"]
    }
  }
}
```

> Since Antigravity runs in the cloud, `npx` must be available in your workspace environment.
> Consult the [Antigravity docs](https://antigravity.google/docs/mcp) for workspace-specific details.

---

## Advanced: CI / Service Accounts

For CI pipelines, pass credentials via environment variables — the server reads them directly:

```sh
export OPENGROK_BASE_URL="https://opengrok.example.com/source/"
export OPENGROK_USERNAME="ci-bot"
export OPENGROK_PASSWORD="$SECRET_FROM_VAULT"   # injected by your CI secrets manager
npx opengrok-mcp-server
```

`OPENGROK_PASSWORD` in the environment takes precedence over any keychain entry.

Or in a client config (e.g., Claude Code `.mcp.json`):

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "npx",
      "args": ["opengrok-mcp-server"],
      "env": {
        "OPENGROK_BASE_URL": "https://opengrok.example.com/source/",
        "OPENGROK_USERNAME": "ci-bot",
        "OPENGROK_PASSWORD": "${OPENGROK_PASSWORD}"
      }
    }
  }
}
```

Claude Code supports `${VAR}` expansion in `env` blocks — set the variable in your shell before launching.

---

## Manual Setup (Advanced)

> Use this if you need full control over the server binary and environment.
> **Credentials in env vars may be visible in process listings** — use a service account
> with read-only access and prefer the keychain approach for interactive use.

### Prerequisites

```bash
npm install -g opengrok-mcp-server   # global install
# OR: use npx for one-off runs without installing
```

### Key Environment Variables

| Variable | Required | Description |
| :------- | :------- | :---------- |
| `OPENGROK_BASE_URL` | Yes | OpenGrok server URL (e.g., `https://opengrok.example.com/source/`) |
| `OPENGROK_USERNAME` | Yes | OpenGrok username |
| `OPENGROK_PASSWORD` | Yes | OpenGrok password (overrides keychain) |
| `OPENGROK_VERIFY_SSL` | No | `false` for self-signed certificates (default: `true`) |
| `OPENGROK_CODE_MODE` | No | `true` to enable Code Mode (5-tool sandbox interface) |
| `OPENGROK_DEFAULT_PROJECT` | No | Default project to scope all searches |
| `OPENGROK_ENABLE_ELICITATION` | No | `true` to enable interactive project picker and `env.opengrok.elicit()` |

Full env var reference: see [README.md — Configuration Guide](README.md#configuration-guide).

### Example: Claude Desktop with explicit env vars

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "npx",
      "args": ["opengrok-mcp-server"],
      "env": {
        "OPENGROK_BASE_URL": "https://opengrok.example.com/source/",
        "OPENGROK_USERNAME": "your-username",
        "OPENGROK_PASSWORD": "your-password",
        "OPENGROK_VERIFY_SSL": "true"
      }
    }
  }
}
```

---

## Troubleshooting

### `No credentials found` on server start

Run the setup wizard to store credentials in the OS keychain:

```sh
npx opengrok-mcp-server setup
```

Or pass `OPENGROK_PASSWORD` as an environment variable in your client config.

### `command not found: opengrok-mcp`

Use `npx opengrok-mcp-server` instead, or install globally:

```sh
npm install -g opengrok-mcp-server
```

### SSL certificate errors

During `npx opengrok-mcp-server setup`, answer **No** when asked "Verify SSL certificates?".
This configures `OPENGROK_VERIFY_SSL=false`. Or set it in your client config env block.

### Connection test fails during setup

1. Check VPN / network access to the OpenGrok server.
2. Verify the base URL ends with `/source/`.
3. Test manually: `curl -u username https://opengrok.example.com/source/api/v1/projects`

### Checking server logs

Add `"--verbose"` to the args or run the server directly in a terminal:

```sh
OPENGROK_BASE_URL=https://... OPENGROK_USERNAME=... OPENGROK_PASSWORD=... npx opengrok-mcp-server 2>&1 | less
```

MCP JSON-RPC traffic goes to stdout; server logs go to stderr.

---

## Prompt Caching

Claude Code and Claude.ai automatically cache the MCP server's system prompt
(SERVER_INSTRUCTIONS, ~310 tokens). This means:
- The first call in a session pays the full token cost for SERVER_INSTRUCTIONS
- Subsequent calls in the same session reuse the cached version at ~10% of the cost
- No configuration needed — automatic for supported clients

`OPENGROK_ENABLE_CACHE_HINTS=true` is reserved for future explicit cache-control headers
(not yet implemented by any client).
