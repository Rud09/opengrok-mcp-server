<div align="center">

<img src="images/icon.png" width="120" alt="OpenGrok MCP Server icon">

# OpenGrok MCP Server

**Search your OpenGrok code index directly from GitHub Copilot Chat**

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/IcyHot09.opengrok-mcp-server?label=VS%20Code%20Marketplace&logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=IcyHot09.opengrok-mcp-server) [![Installs](https://img.shields.io/visual-studio-marketplace/i/IcyHot09.opengrok-mcp-server)](https://marketplace.visualstudio.com/items?itemName=IcyHot09.opengrok-mcp-server) [![npm](https://img.shields.io/npm/v/opengrok-mcp-server?logo=npm)](https://www.npmjs.com/package/opengrok-mcp-server) [![CI](https://github.com/IcyHot09/opengrok-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/IcyHot09/opengrok-mcp-server/actions/workflows/ci.yml) [![GitHub Release](https://img.shields.io/github/v/release/IcyHot09/opengrok-mcp-server)](https://github.com/IcyHot09/opengrok-mcp-server/releases)

🔌 **Zero Install** &nbsp;·&nbsp; 🧠 **Compound Tools** &nbsp;·&nbsp; 🔄 **Auto-Updates** &nbsp;·&nbsp; 🔒 **Secure Credentials**

</div>

---

<details>
<summary>📋 Table of Contents</summary>

- [Do I need anything installed?](#do-i-need-anything-installed)
- [Installation](#installation)
- [Setup & Configuration](#setup--configuration)
- [Usage](#usage)
- [Available Tools](#available-tools)
- [Extension Commands](#extension-commands)
- [Extension Settings](#extension-settings)
- [Architecture](#architecture)
- [Development](#development)
- [License](#license)

</details>

---

## Do I need anything installed?

> 💡 **No.** Installing the VSIX is enough. The MCP server is bundled inside the extension — no Python, no Node.js, no separate installs required.

<a href="https://glama.ai/mcp/servers/IcyHot09/opengrok-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/IcyHot09/opengrok-mcp-server/badge" alt="OpenGrok Server MCP server" />
</a>

---

## Installation

### Option 1 — VS Code Marketplace _(Recommended)_

Search for **"OpenGrok Code Search for Copilot"** in the VS Code Extensions panel (`Ctrl+Shift+X`) and click Install.

### Option 2 — Install pre-built VSIX

1. Download the latest VSIX file from [GitHub Releases](https://github.com/IcyHot09/opengrok-mcp-server/releases).
2. Install it in VS Code:
   - **Open the terminal** in VS Code and run: `code --install-extension opengrok-mcp-server-X.Y.Z.vsix`
   - **OR** go to the Extensions tab → click the `···` menu → **Install from VSIX…** and select the file.
3. **Updates are automatic** — the extension checks GitHub Releases once per day and offers one-click install.

<details>
<summary>🛠️ Option 3 — Build from source <em>(For developers)</em></summary>

```bash
git clone https://github.com/IcyHot09/opengrok-mcp-server.git
cd opengrok-mcp-server
npm install
npm run vsix          # Creates opengrok-mcp-server-*.vsix
code --install-extension opengrok-mcp-server-*.vsix
```

</details>

---

## Setup & Configuration

1. **Configure Credentials:**
   - Upon installing, the **Configuration Manager** webview opens automatically.
   - Enter your OpenGrok server URL, username, and password, then click **Save Settings**. _(Password is saved securely in the OS keychain.)_
   - A connection test runs automatically. First-time setup requires a **Reload Window** to enable tools.
   - _(Manage configuration later via the gear icon in the Status Bar, or `OpenGrok: Manage Configuration` in the Command Palette.)_



2. **Enable the Tools in Copilot** _(First Time Only)_:
   - Open **GitHub Copilot Chat** in **Agent** mode.
   - Click the **`🔧` (Tools icon)** in the chat input box.
   - If you see **Update Tools**, click it first.
   - Check **OpenGrok** in the list and click **Done**.

> ⚠️ Tool selection is **per workspace** — re-enable in each new workspace as needed.

### 🔌 Using with Other MCP Clients

The **standalone MCP server** works with any MCP-compatible client:

**Claude Code** · **Cursor** · **Windsurf** · **Claude Desktop** · **OpenCode** · **Google Antigravity**

> **👉 See [MCP_CLIENTS.md](MCP_CLIENTS.md)** for the one-command installer, per-client config snippets, and security considerations.

---

## Usage

In GitHub Copilot Chat, describe what you're looking for in natural language:

```text
Use OpenGrok to search for RenderPipeline in the my-project project

Ask OpenGrok to show me the file at /path/to/file.cpp lines 100-200

Have OpenGrok find the definition of CacheManager and show me the header too

Search for all references to TaskScheduler across the codebase
```

---

## Available Tools

### Core Tools

| Tool | Description |
| ---- | ----------- |
| `search_code` | Full-text, symbol definition, reference, path, or commit message search. Optional `file_type` filter. |
| `find_file` | Find files by path or name pattern. |
| `get_file_content` | Retrieve file contents — pass `start_line`/`end_line` to limit output. |
| `get_file_history` | Commit history for a file. |
| `browse_directory` | List directory contents. |
| `list_projects` | List all accessible projects. |
| `get_file_annotate` | Git blame with optional line range. |
| `get_file_symbols` | List all top-level symbols in a file. |
| `search_suggest` | Autocomplete/suggestions for partial queries. |

### 🚀 Compound Tools — Use These First

> 💡 These collapse common multi-step patterns into a single call, saving **~75–92% of tokens**.

| Tool | What it replaces | Token savings |
| ---- | ---------------- | ------------- |
| `get_symbol_context` | `search_code(defs)` → `get_file_content` → `search_code(refs)` | **~92%** |
| `search_and_read` | `search_code` → `get_file_content` | **~92%** |
| `batch_search` | Multiple sequential `search_code` calls | **~73%** |
| `index_health` | Manual connection diagnostics | — |

**`file_type` filter** — `search_code`, `batch_search`, `search_and_read`, and `get_symbol_context` accept an optional `file_type` to restrict results by language: `cxx`, `c`, `java`, `python`, `javascript`, `typescript`, `csharp`, `golang`, `ruby`, `perl`, `sql`, `xml`, `yaml`, `shell`, `makefile`.

<details>
<summary>⚙️ Local Source Layer (Optional)</summary>

| Tool | Description |
| ---- | ----------- |
| `get_compile_info` | Compiler flags, include paths, defines, and language standard for a source file. Requires `compile_commands.json` in your workspace. |

</details>

---

## Extension Commands

| Command | Description |
| :------ | :---------- |
| `OpenGrok: Manage Configuration` | Open visual configuration panel |
| `OpenGrok: Configure Credentials` | Quick-configure via input prompts |
| `OpenGrok: Test Connection` | Verify connectivity to OpenGrok |
| `OpenGrok: Show Server Logs` | View MCP server diagnostic logs |
| `OpenGrok: Check for Updates` | Check GitHub Releases for new versions |
| `OpenGrok: Status Menu` | Quick-pick menu (also accessible from status bar) |

---

## Extension Settings

<details>
<summary>View settings reference</summary>

| Name | Type | Default | Description |
| :--- | :--- | :------ | :---------- |
| `opengrok-mcp.baseUrl` | `string` | | OpenGrok server URL |
| `opengrok-mcp.username` | `string` | | Your username |
| `opengrok-mcp.verifySsl` | `boolean` | `false` | Verify SSL certificates |
| `opengrok-mcp.proxy` | `string` | | HTTP proxy URL |

### Local Source Layer

The local layer is **zero-config** — if your workspace contains `compile_commands.json`, `get_compile_info` is enabled automatically.

</details>

---

## Architecture

<details>
<summary>View architecture diagram</summary>

```text
┌─────────────────┐     ┌──────────────────────────────┐     ┌──────────────┐
│  GitHub Copilot │────▶│  opengrok-mcp-server (MCP)   │────▶│  OpenGrok    │
│  Chat           │stdio│                              │HTTP │  Server      │
└─────────────────┘     │  Compound tools:             │     └──────────────┘
        ▲               │  · get_symbol_context        │
        │               │  · search_and_read           │     ┌──────────────┐
        │ configures    │  · batch_search              │────▶│  Local FS    │
        │ + bundles     │                              │     │  (optional)  │
┌───────┴─────────┐     │  Response cap: 16 KB         │     └──────────────┘
│  VS Code        │     │  MCP instructions block      │
│  Extension      │     └──────────────────────────────┘
└─────────────────┘
```

The MCP server is compiled and bundled inside the VSIX as `out/server/main.js`.
VS Code provides its own Node.js runtime — **no separate installation needed**.

</details>

---

## Development

```bash
npm install
npm test          # Run unit tests (Vitest)
npm run lint      # TypeScript type-check + ESLint
npm run compile   # esbuild bundle
npm run vsix      # Package as .vsix
```

Releases are automated via GitHub Actions — push a version tag (`vX.Y.Z`) and the workflow builds, tests, and publishes to [GitHub Releases](https://github.com/IcyHot09/opengrok-mcp-server/releases).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development guide.

---

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE).

**This project is free for personal and non-commercial use.** For enterprise or commercial licensing, please contact me at [rudroy09@gmail.com](mailto:rudroy09@gmail.com).