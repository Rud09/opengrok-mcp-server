import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface DetectedClients {
  claudeCode: boolean;
  vscode: boolean;
  codex: boolean;
  copilotCli: boolean;
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

  // GitHub Copilot CLI: detect via `copilot` binary or existing config dir
  const copilotBinary = spawnSync('copilot', ['--version'], {
    stdio: 'pipe',
    timeout: 5000,
    shell: false,
  }).status === 0;
  const copilotConfigDir = join(homedir(), '.copilot');
  const copilotCli = copilotBinary || existsSync(copilotConfigDir);

  return { claudeCode, vscode, codex, copilotCli };
}
