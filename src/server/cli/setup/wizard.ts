import * as p from '@clack/prompts';
import { detectInstalledClients } from './detect.js';
import { configureClaudeCode, configureVSCode, configureCodex } from './configure.js';
import { storeCredentials } from '../keychain.js';

export async function runSetup(): Promise<void> {
  p.intro('OpenGrok MCP Server Setup');

  const url = await p.text({
    message: 'OpenGrok server URL',
    placeholder: 'https://opengrok.company.com/source/',
    validate: (v) => {
      if (!v) return 'Enter a valid URL';
      try { new URL(v); } catch { return 'Enter a valid URL'; }
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

  const budget = await p.select({
    message: 'Context budget',
    options: [
      { value: 'minimal', label: 'minimal (4 KB) — lowest token usage' },
      { value: 'standard', label: 'standard (8 KB) — balanced' },
      { value: 'generous', label: 'generous (16 KB) — more context' },
    ],
    initialValue: 'standard',
  });
  if (p.isCancel(budget)) { p.cancel('Setup cancelled'); process.exit(0); }

  const verifySsl = await p.confirm({
    message: 'Verify SSL certificates?',
    initialValue: true,
  });
  if (p.isCancel(verifySsl)) { p.cancel('Setup cancelled'); process.exit(0); }

  // Store credentials in OS keychain
  if (String(username) && password) {
    storeCredentials(String(url), String(username), password);
    p.log.success('Credentials stored in OS keychain');
  }

  // Detect installed clients
  const clients = detectInstalledClients();
  const mcpConfig = { url: String(url), username: String(username) };

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
