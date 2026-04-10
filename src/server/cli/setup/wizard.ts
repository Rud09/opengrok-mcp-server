import * as p from '@clack/prompts';
import { detectInstalledClients } from './detect.js';
import { configureClaudeCode, configureCodex, configureCopilotCli } from './configure.js';
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
        if (!['http:', 'https:'].includes(parsed.protocol)) return 'URL must use http:// or https://';
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
    message: 'Verify SSL/TLS certificates? (disable only for self-signed or internal CA certificates)',
    initialValue: true,
  });
  if (p.isCancel(verifySsl)) { p.cancel('Setup cancelled.'); process.exit(0); }

  // --- PREFERENCES ---
  const budget = await p.select({
    message: 'Response detail level',
    options: [
      { value: 'minimal',  label: 'Compact (4 KB) — fewer tokens, lower detail' },
      { value: 'standard', label: 'Standard (8 KB) — balanced, recommended' },
      { value: 'generous', label: 'Detailed (16 KB) — more context, more tokens' },
    ],
    initialValue: 'standard',
  });
  if (p.isCancel(budget)) { p.cancel('Setup cancelled'); process.exit(0); }

  const codeMode = await p.confirm({
    message: 'Enable Code Mode? (sandboxed JS runtime — ~90% fewer tokens, recommended for large codebases)',
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
    message: 'Enable Interactive AI Prompts? The AI can pause to ask questions during investigations (e.g., project selection, file disambiguation). Requires Claude Code v2.1.76+ or a client that supports MCP Elicitation',
    initialValue: false,
  });
  if (p.isCancel(enableElicitation)) { p.cancel('Setup cancelled'); process.exit(0); }

  // --- ADVANCED (optional) ---
  const wantsAdvanced = await p.confirm({
    message: 'Configure advanced settings? (proxy, API version, response format, memory bank, audit log, rate limit)',
    initialValue: false,
  });
  if (p.isCancel(wantsAdvanced)) { p.cancel('Setup cancelled'); process.exit(0); }

  let proxy = '';
  let apiVersion = 'v1';
  let responseFormatOverride = '';
  let memoryBankDir = '';
  let compileDbPaths = '';
  let enableFilesApi = false;
  let samplingModel = '';
  let samplingMaxTokens = '256';
  let auditLogFile = '';
  let rateLimitRpm = '60';

  if (wantsAdvanced) {
    const proxyVal = await p.text({
      message: 'HTTP proxy URL (leave blank if none)',
      defaultValue: '',
      placeholder: 'http://proxy.company.com:8080',
    });
    if (p.isCancel(proxyVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    proxy = String(proxyVal);

    const apiVersionVal = await p.select({
      message: 'OpenGrok API version',
      options: [
        { value: 'v1', label: 'v1 — Compatible with all OpenGrok versions (default)' },
        { value: 'v2', label: 'v2 — Required for call graph features (OpenGrok 1.12+)' },
      ],
      initialValue: 'v1',
    });
    if (p.isCancel(apiVersionVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    apiVersion = String(apiVersionVal);

    const responseFormat = await p.select({
      message: 'AI response format override',
      options: [
        { value: '',         label: 'Auto — each tool picks the best format (recommended)' },
        { value: 'markdown', label: 'Markdown — verbose but readable' },
        { value: 'json',     label: 'JSON — programmatic use' },
        { value: 'tsv',      label: 'TSV — compact tabular' },
        { value: 'toon',     label: 'TOON — token-optimized notation' },
        { value: 'yaml',     label: 'YAML — hierarchical data' },
        { value: 'text',     label: 'Text — raw code, no framing' },
      ],
      initialValue: '',
    });
    if (p.isCancel(responseFormat)) { p.cancel('Setup cancelled'); process.exit(0); }
    responseFormatOverride = String(responseFormat);

    const memoryBankVal = await p.text({
      message: 'Investigation notes directory (leave blank for default: ~/.config/opengrok-mcp/memory-bank/)',
      defaultValue: '',
    });
    if (p.isCancel(memoryBankVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    memoryBankDir = String(memoryBankVal);

    const compileDbVal = await p.text({
      message: 'C/C++ compile commands paths (comma-separated paths to compile_commands.json, blank = auto)',
      defaultValue: '',
    });
    if (p.isCancel(compileDbVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    compileDbPaths = String(compileDbVal);

    const enableFilesApiVal = await p.confirm({
      message: 'Enable Files API cache? (avoids re-uploading unchanged investigation notes to the AI)',
      initialValue: false,
    });
    if (p.isCancel(enableFilesApiVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    enableFilesApi = Boolean(enableFilesApiVal);

    const samplingModelVal = await p.text({
      message: 'AI sampling model (leave blank for client default)',
      defaultValue: '',
    });
    if (p.isCancel(samplingModelVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    samplingModel = String(samplingModelVal);

    const samplingMaxTokensVal = await p.text({
      message: 'AI sampling token budget (default: 256, range: 64–4096)',
      defaultValue: '256',
      validate: (v) => {
        const n = parseInt(v ?? '', 10);
        if (isNaN(n) || n < 64 || n > 4096) return 'Enter a number between 64 and 4096';
      },
    });
    if (p.isCancel(samplingMaxTokensVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    samplingMaxTokens = String(samplingMaxTokensVal);

    const auditLogFileVal = await p.text({
      message: 'Audit log file path (leave blank to disable)',
      defaultValue: '',
    });
    if (p.isCancel(auditLogFileVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    auditLogFile = String(auditLogFileVal);

    const rateLimitRpmVal = await p.text({
      message: 'Request rate limit in RPM (default: 60)',
      defaultValue: '60',
      validate: (v) => {
        const n = parseInt(v ?? '', 10);
        if (isNaN(n) || n < 1) return 'Enter a positive integer';
      },
    });
    if (p.isCancel(rateLimitRpmVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    rateLimitRpm = String(rateLimitRpmVal);
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
    enableFilesApi,
    samplingModel,
    samplingMaxTokens,
    auditLogFile,
    rateLimitRpm,
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

  if (clients.codex) {
    spin.start('Configuring Codex CLI...');
    try {
      configureCodex(mcpConfig);
      spin.stop('Codex CLI configured \u2713');
    } catch (e) {
      spin.stop(`Codex CLI: ${(e as Error).message}`);
    }
  }

  if (clients.copilotCli) {
    spin.start('Configuring GitHub Copilot CLI...');
    try {
      configureCopilotCli(mcpConfig);
      spin.stop('GitHub Copilot CLI configured \u2713');
    } catch (e) {
      spin.stop(`GitHub Copilot CLI: ${(e as Error).message}`);
    }
  }

  if (!clients.claudeCode && !clients.codex && !clients.copilotCli) {
    p.log.warn('No supported MCP clients detected. Install Claude Code CLI, GitHub Copilot CLI, or Codex CLI and re-run setup.');
  }

  p.outro('Setup complete! Run `opengrok-mcp status` to verify the connection.');
}
