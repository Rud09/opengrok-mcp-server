import * as p from '@clack/prompts';
import { detectInstalledClients } from './detect.js';
import { configureClaudeCode, configureVSCode, configureCodex } from './configure.js';
import { storeCredentials } from '../keychain.js';

export async function runSetup(): Promise<void> {
  p.intro('OpenGrok MCP Server Setup');

  // --- CONNECTION ---
  const url = await p.text({
    message: 'OpenGrok server URL',
    placeholder: 'https://opengrok.company.com/source/',
    validate: (v) => {
      if (!v) return 'Enter a valid URL';
      try {
        const parsed = new URL(v);
        if (parsed.protocol === 'http:') return 'Warning: HTTP sends credentials unencrypted. Use HTTPS for production.';
      } catch { return 'Enter a valid URL'; }
    },
  });
  if (p.isCancel(url)) { p.cancel('Setup cancelled'); process.exit(0); }

  const username = await p.text({
    message: 'Username (leave blank for anonymous)',
    defaultValue: '',
  });
  if (p.isCancel(username)) { p.cancel('Setup cancelled'); process.exit(0); }

  let password = '';
  if (String(username)) {
    const pw = await p.password({ message: 'Password' });
    if (p.isCancel(pw)) { p.cancel('Setup cancelled'); process.exit(0); }
    password = String(pw);
  }

  const verifySsl = await p.confirm({
    message: 'Verify SSL certificate? (disable only for self-signed or internal CA servers)',
    initialValue: true,
  });
  if (p.isCancel(verifySsl)) { p.cancel('Setup cancelled.'); process.exit(0); }

  // --- PREFERENCES ---
  const budget = await p.select({
    message: 'Context budget',
    options: [
      { value: 'minimal', label: 'minimal (4 KB) — lowest token usage, compact tool descriptions' },
      { value: 'standard', label: 'standard (8 KB) — balanced' },
      { value: 'generous', label: 'generous (16 KB) — more context' },
    ],
    initialValue: 'standard',
  });
  if (p.isCancel(budget)) { p.cancel('Setup cancelled'); process.exit(0); }

  const codeMode = await p.confirm({
    message: 'Enable Code Mode? (2-tool API: 98% fewer tokens — recommended for large codebases)',
    initialValue: true,
  });
  if (p.isCancel(codeMode)) { p.cancel('Setup cancelled'); process.exit(0); }

  const defaultProject = await p.text({
    message: 'Default project (leave blank to search all projects)',
    defaultValue: '',
    placeholder: 'my-project',
  });
  if (p.isCancel(defaultProject)) { p.cancel('Setup cancelled'); process.exit(0); }

  const enableElicitation = await p.confirm({
    message: 'Enable AI project picker? When no default project is set, the AI will ask you which project to search (requires Claude Code v2.1.76+ or VS Code Copilot)',
    initialValue: false,
  });
  if (p.isCancel(enableElicitation)) { p.cancel('Setup cancelled'); process.exit(0); }

  // --- ADVANCED (optional, shown only if user wants) ---
  const wantsAdvanced = await p.confirm({
    message: 'Configure advanced settings? (proxy, API version, response format, memory bank)',
    initialValue: false,
  });
  if (p.isCancel(wantsAdvanced)) { p.cancel('Setup cancelled'); process.exit(0); }

  let proxy = '';
  let apiVersion = 'v1';
  let responseFormatOverride = '';
  let memoryBankDir = '';
  let compileDbPaths = '';

  if (wantsAdvanced) {
    const proxyVal = await p.text({
      message: 'HTTP proxy URL (leave blank if none)',
      defaultValue: '',
      placeholder: 'http://proxy.company.com:8080',
    });
    if (p.isCancel(proxyVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    proxy = String(proxyVal);

    const apiVersionVal = await p.select({
      message: 'OpenGrok REST API version',
      options: [
        { value: 'v1', label: 'v1 — Default (OpenGrok 1.x)' },
        { value: 'v2', label: 'v2 — OpenGrok 2.x servers (explicit opt-in only)' },
      ],
      initialValue: 'v1',
    });
    if (p.isCancel(apiVersionVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    apiVersion = String(apiVersionVal);

    const responseFormat = await p.select({
      message: 'Response format override',
      options: [
        { value: '', label: 'Auto (recommended — each tool picks the best format)' },
        { value: 'markdown', label: 'Force Markdown' },
        { value: 'json', label: 'Force JSON' },
        { value: 'tsv', label: 'Force TSV (compact table)' },
        { value: 'toon', label: 'Force TOON (token-optimized notation)' },
        { value: 'yaml', label: 'Force YAML (hierarchical data)' },
        { value: 'text', label: 'Force Text (raw code, no framing)' },
      ],
      initialValue: '',
    });
    if (p.isCancel(responseFormat)) { p.cancel('Setup cancelled'); process.exit(0); }
    responseFormatOverride = String(responseFormat);

    const memoryBankVal = await p.text({
      message: 'Memory bank directory (leave blank for default ~/.config/opengrok-mcp/memory-bank/)',
      defaultValue: '',
    });
    if (p.isCancel(memoryBankVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    memoryBankDir = String(memoryBankVal);

    const compileDbVal = await p.text({
      message: 'Compile commands paths (comma-separated paths to compile_commands.json, blank = auto)',
      defaultValue: '',
    });
    if (p.isCancel(compileDbVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    compileDbPaths = String(compileDbVal);
  }

  // --- STORE CREDENTIALS ---
  if (String(username) && password) {
    storeCredentials(String(url), String(username), password);
    p.log.success('Credentials stored in OS keychain');
  }

  // --- CONFIGURE MCP CLIENTS ---
  const clients = detectInstalledClients();
  const mcpConfig = {
    url: String(url),
    username: String(username),
    verifySsl: Boolean(verifySsl),
    contextBudget: String(budget),
    codeMode: Boolean(codeMode),
    defaultProject: String(defaultProject),
    enableElicitation: Boolean(enableElicitation),
    proxy,
    apiVersion,
    responseFormatOverride,
    memoryBankDir,
    compileDbPaths,
  };

  const spin = p.spinner();

  if (clients.claudeCode) {
    spin.start('Configuring Claude Code CLI...');
    try {
      configureClaudeCode(mcpConfig);
      spin.stop('Claude Code CLI configured \u2713');
    } catch (e) {
      spin.stop(`Claude Code CLI: ${(e as Error).message}`);
    }
  }

  if (clients.vscode) {
    spin.start('Configuring VS Code / Copilot CLI...');
    try {
      configureVSCode(mcpConfig);
      spin.stop('VS Code configured \u2713');
    } catch (e) {
      spin.stop(`VS Code: ${(e as Error).message}`);
    }
  }

  if (clients.codex) {
    spin.start('Configuring Codex CLI...');
    try {
      configureCodex(mcpConfig);
      spin.stop('Codex CLI configured \u2713');
    } catch (e) {
      spin.stop(`Codex CLI: ${(e as Error).message}`);
    }
  }

  if (!clients.claudeCode && !clients.vscode && !clients.codex) {
    p.log.warn('No supported MCP clients detected. Install Claude Code CLI, VS Code, or Codex CLI and re-run setup.');
  }

  p.outro('Setup complete! Run `opengrok-mcp status` to verify the connection.');
}
