<div align="center">

<img src="images/icon.png" width="120" alt="OpenGrok MCP Server logo">

# OpenGrok MCP Server

**MCP server bridging OpenGrok search engine with AI for instant context across massive codebases**

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/IcyHot09.opengrok-mcp-server?label=VS%20Code%20Marketplace&logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=IcyHot09.opengrok-mcp-server) [![Installs](https://img.shields.io/visual-studio-marketplace/i/IcyHot09.opengrok-mcp-server)](https://marketplace.visualstudio.com/items?itemName=IcyHot09.opengrok-mcp-server) [![npm](https://img.shields.io/npm/v/opengrok-mcp-server?logo=npm)](https://www.npmjs.com/package/opengrok-mcp-server) [![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-blue)](https://registry.modelcontextprotocol.io) [![CI](https://github.com/IcyHot09/opengrok-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/IcyHot09/opengrok-mcp-server/actions/workflows/ci.yml) [![GitHub Release](https://img.shields.io/github/v/release/IcyHot09/opengrok-mcp-server)](https://github.com/IcyHot09/opengrok-mcp-server/releases)

⚡ **Instant Setup** • 🚀 **High-Performance Tools** • 🔒 **Local Security** • 🔄 **Self-Updating**

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

### 1. From the VS Code Marketplace (Easiest)

Inside VS Code, open the Extensions view (`Ctrl+Shift+X`), search for **"OpenGrok MCP Server"**, and hit Install.

### 2. Global NPM Package

```bash
# Run directly without installing permanently
npx opengrok-mcp-server

# Or install it globally on your system
npm install -g opengrok-mcp-server
```

### 3. Via the MCP Registry

We are officially listed in the [Model Context Protocol Registry](https://registry.modelcontextprotocol.io) under `io.github.IcyHot09/opengrok-mcp-server`. Clients with registry integration can locate and install it natively.

### Option 4 — Install pre-built VSIX

1. Download the latest VSIX file from [GitHub Releases](https://github.com/IcyHot09/opengrok-mcp-server/releases).
2. Install it in VS Code:
   - **Open the terminal** in VS Code and run: `code --install-extension opengrok-mcp-server-X.Y.Z.vsix`
   - **OR** go to the Extensions tab → click the `···` menu → **Install from VSIX…** and select the file.
3. **Updates are automatic** — the extension checks GitHub Releases once per day and offers one-click install.

<details>
<summary>🛠️ Option 5 — Build from source <em>(For developers)</em></summary>

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
| `opengrok_batch_search` | Combines 2-5 individual search queries | **~73% fewer tokens** |
| `opengrok_index_health` | Checks latency and backend connectivity | Diagnostic utility |

*(Note: The search functions support language filtering. Pass `file_type` as `java`, `cxx`, `python`, `golang`, etc.)*

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
npm run lint      # Strict TypeScript & ESLint validation
npm test          # Execute the Vitest test suite

# Packaging
npm run compile   # Generate the esbuild artifact
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

✅ **Permitted:** Personal use, hobby projects, academic research, education
❌ **Prohibited:** Any commercial, business, enterprise, or paid utilization

**Commercial Licensing:**
To use this extension in an enterprise context (internal tooling, CI pipelines, business infrastructure), a commercial license is strictly required. 
Reach out to [rudroy09@gmail.com](mailto:rudroy09@gmail.com) for enterprise tier pricing.

Read [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md) for full terms.
