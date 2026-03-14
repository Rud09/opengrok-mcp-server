# Using OpenGrok MCP with Any Client

This guide covers how to connect the standalone OpenGrok MCP server to popular AI clients.
The **wrapper script** is the recommended approach — it handles credentials securely (OS keychain or encrypted file) so you never paste a password into a config file.

> **VS Code / Google Antigravity users:** install the VSIX extension instead.
> It handles everything automatically. See [README.md](README.md).

---

## Quick Start

### 1 — Install

**Linux / macOS (one command):**
```sh
curl -fsSL https://raw.githubusercontent.com/IcyHot09/opengrok-mcp-server/main/scripts/install.sh | bash
```

**Windows:** Download the latest `opengrok-mcp-*-win.zip` from the
[Releases page](https://github.com/IcyHot09/opengrok-mcp-server/releases),
extract it to a permanent location (e.g., `C:\tools\opengrok-mcp\`).

### 2 — Set up credentials (once, in your terminal)

```sh
# Linux / macOS
~/.local/bin/opengrok-mcp-wrapper.sh --setup

# Windows (PowerShell or cmd)
C:\tools\opengrok-mcp\opengrok-mcp-wrapper.cmd --setup
```

The `--setup` wizard tests the connection and stores your password in:

| Platform | Primary store | Fallback |
| :------- | :------------ | :------- |
| macOS | macOS Keychain | AES-256 encrypted file |
| Linux (desktop) | GNOME Keyring / KDE Wallet | AES-256 encrypted file |
| Linux (headless/SSH) | AES-256 encrypted file (machine-id key) | `.env` file |
| Windows | Windows Credential Manager | DPAPI encrypted file |

Your password is **never** stored in any MCP client config file.

### 3 — Configure your client

Point your client at the wrapper (the path printed by `--setup`).
Snippets for each client are below.

---

## Client Configurations

### Claude Code

Scope options:
- **Project** (team-shared, no secrets): `.mcp.json` in project root
- **User** (global): `~/.claude.json`

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "/home/YOU/.local/bin/opengrok-mcp-wrapper.sh"
    }
  }
}
```

> **Windows:** use `C:\\tools\\opengrok-mcp\\opengrok-mcp-wrapper.cmd` (double backslashes).

The Claude Code VS Code Extension reads the same `.mcp.json` — no extra config needed.

---

### Cursor

Edit `.cursor/mcp.json` in your project root, or open **Cursor Settings → Features → MCP**.

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "/home/YOU/.local/bin/opengrok-mcp-wrapper.sh"
    }
  }
}
```

> **Windows:** `"command": "C:\\tools\\opengrok-mcp\\opengrok-mcp-wrapper.cmd"`

---

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`.

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "/home/YOU/.local/bin/opengrok-mcp-wrapper.sh"
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
      "command": "/home/YOU/.local/bin/opengrok-mcp-wrapper.sh"
    }
  }
}
```

Restart Claude Desktop after saving.

---

### OpenCode (opencode.ai by Anomaly)

Config files: `opencode.json` / `opencode.jsonc` (project) or `~/.config/opencode/opencode.json` (global).

```json
{
  "mcp": {
    "opengrok": {
      "type": "local",
      "command": ["/home/YOU/.local/bin/opengrok-mcp-wrapper.sh"]
    }
  }
}
```

> **Windows:** `"command": ["C:\\tools\\opengrok-mcp\\opengrok-mcp-wrapper.cmd"]`

---

### Crush (formerly opencode-ai/opencode on GitHub)

Config: `~/.config/crush/config.yaml` or project-level `crush.yaml`.

```yaml
mcp:
  servers:
    opengrok:
      command: /home/YOU/.local/bin/opengrok-mcp-wrapper.sh
```

---

### Google Antigravity

**Recommended:** Install the VSIX extension — Gemini discovers tools automatically, no config needed.

**Manual MCP config** (if you prefer not to use the extension):
Use the MCP Store in Antigravity → *View raw config* and add the `mcpServers` snippet above (same format as Claude Code / Cursor).

> Since Antigravity runs in the cloud, the wrapper must be reachable from your workspace environment.
> Consult the [Antigravity docs](https://antigravity.google/docs/mcp) for workspace-specific details.

---

## Advanced: CI / Service Accounts

For CI pipelines, inject credentials via environment variables — the wrapper passes them straight through:

```sh
export OPENGROK_BASE_URL="https://opengrok.example.com/source/"
export OPENGROK_USERNAME="ci-bot"
export OPENGROK_PASSWORD="$SECRET_FROM_VAULT"   # set by your CI system
opengrok-mcp-wrapper.sh                          # or exec directly: opengrok-mcp
```

`OPENGROK_PASSWORD` in the environment always takes precedence over any stored credentials.

---

## Manual Setup (Advanced)

> Use this if you cannot or prefer not to use the installer and wrapper scripts.
> **The approach below stores credentials as environment variables, which may be visible in process listings.**
> A dedicated service account with read-only access is strongly recommended.

### Prerequisites

Build the server yourself:

```bash
git clone https://github.com/IcyHot09/opengrok-mcp-server.git
cd opengrokmcp-standalone
npm install
npm run compile
```

The server binary is then `./out/server/main.js` (requires Node.js ≥ 18).

### Environment Variables

| Variable | Required | Description |
| :------- | :------- | :---------- |
| `OPENGROK_BASE_URL` | Yes | Your OpenGrok server URL (e.g., `https://opengrok.example.com/source/`) |
| `OPENGROK_USERNAME` | Yes | Your OpenGrok username |
| `OPENGROK_PASSWORD` | Yes | Your OpenGrok password |
| `OPENGROK_VERIFY_SSL` | No | Set to `false` for self-signed certificates (default: `true`) |

### Claude Desktop (manual)

Config file: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "node",
      "args": ["/absolute/path/to/opengrokmcp-standalone/out/server/main.js"],
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

Restart Claude Desktop after saving.

### Claude Code (manual, env var expansion)

Claude Code supports `${VAR}` expansion in env blocks. Set `OPENGROK_PASSWORD` in your shell before launching.

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "node",
      "args": ["/absolute/path/to/opengrokmcp-standalone/out/server/main.js"],
      "env": {
        "OPENGROK_BASE_URL": "https://opengrok.example.com/source/",
        "OPENGROK_USERNAME": "your-username",
        "OPENGROK_PASSWORD": "${OPENGROK_PASSWORD}",
        "OPENGROK_VERIFY_SSL": "true"
      }
    }
  }
}
```

### Cursor (manual)

Edit `.cursor/mcp.json` in your project root or open **Cursor Settings → Features → MCP**.

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "node",
      "args": ["/absolute/path/to/opengrokmcp-standalone/out/server/main.js"],
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

### OpenCode (manual)

Config: `opencode.json` / `opencode.jsonc` in project root or `~/.config/opencode/opencode.json`.

```json
{
  "mcp": {
    "opengrok": {
      "type": "local",
      "command": ["node", "/absolute/path/to/opengrokmcp-standalone/out/server/main.js"],
      "environment": {
        "OPENGROK_BASE_URL": "https://opengrok.example.com/source/",
        "OPENGROK_USERNAME": "your-username",
        "OPENGROK_PASSWORD": "your-password"
      }
    }
  }
}
```

### Google Antigravity (manual)

Use the MCP Store → *Manage MCP Servers* → *View raw config* and add:

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "node",
      "args": ["/path/to/opengrokmcp-standalone/out/server/main.js"],
      "env": {
        "OPENGROK_BASE_URL": "https://opengrok.example.com/source/",
        "OPENGROK_USERNAME": "your-username",
        "OPENGROK_PASSWORD": "your-password"
      }
    }
  }
}
```

## Troubleshooting

### `No credentials found` on server start
You haven't run `--setup` in your terminal yet, or the keychain is unreachable.
```sh
~/.local/bin/opengrok-mcp-wrapper.sh --setup
```

### `binary not found` error
The `opengrok-mcp` binary is missing from the same directory as the wrapper.
Re-run the installer, or set `OPENGROK_BIN=/full/path/to/opengrok-mcp`.

### SSL certificate errors
During `--setup`, answer `n` to "Verify SSL certificates?" when prompted.
This writes `OPENGROK_VERIFY_SSL=false` to `~/.config/opengrok-mcp/config`.

### Connection test fails during --setup
1. Check VPN / network access to the OpenGrok server.
2. Verify the base URL ends with `/source/`.
3. Test manually: `curl -u username https://opengrok.example.com/source/api/v1/projects`

### Viewing server logs
Start the wrapper directly in a terminal; MCP JSON-RPC traffic goes to stdout, logs to stderr.
```sh
~/.local/bin/opengrok-mcp-wrapper.sh 2>&1 | less
```
