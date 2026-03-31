import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface DetectedClients {
  claudeCode: boolean;
  vscode: boolean;
  codex: boolean;
}

export function detectInstalledClients(): DetectedClients {
  const claudeCode = spawnSync('claude', ['--version'], {
    stdio: 'pipe',
    timeout: 5000,
    shell: false,
  }).status === 0;

  const vscode = spawnSync('code', ['--version'], {
    stdio: 'pipe',
    timeout: 5000,
    shell: false,
  }).status === 0;

  const codexConfigPath = process.platform === 'win32'
    ? join(process.env['APPDATA'] ?? homedir(), 'codex', 'config.toml')
    : join(homedir(), '.config', 'codex', 'config.toml');
  const codex = existsSync(codexConfigPath);

  return { claudeCode, vscode, codex };
}
