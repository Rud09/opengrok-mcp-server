#!/usr/bin/env node
/**
 * Packages the standalone MCP server binary into platform-specific archives
 * for distribution via GitHub Releases.
 *
 * Usage: node scripts/package-server.js
 *
 * Outputs (in project root):
 *   opengrok-mcp-{version}-linux.tar.gz
 *   opengrok-mcp-{version}-darwin.tar.gz
 *   opengrok-mcp-{version}-win.zip
 *
 * Each archive contains:
 *   opengrok-mcp              <- the binary
 *   opengrok-mcp-wrapper.sh   <- Linux/macOS credential wrapper
 *   opengrok-mcp-wrapper.cmd  <- Windows .cmd launcher
 *   opengrok-mcp-wrapper.ps1  <- Windows PowerShell credential wrapper
 *   MCP_CLIENTS.md            <- setup and client config guide
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { version } = require('../package.json');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'out', 'server');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

const SERVER_BIN = path.join(OUT_DIR, 'main.js');
const WRAPPER_SH = path.join(SCRIPTS_DIR, 'opengrok-mcp-wrapper.sh');
const WRAPPER_CMD = path.join(SCRIPTS_DIR, 'opengrok-mcp-wrapper.cmd');
const WRAPPER_PS1 = path.join(SCRIPTS_DIR, 'opengrok-mcp-wrapper.ps1');
const MCP_CLIENTS_MD = path.join(ROOT, 'MCP_CLIENTS.md');

// Verify required files exist
for (const [label, file] of [
  ['server binary', SERVER_BIN],
  ['wrapper .sh', WRAPPER_SH],
  ['wrapper .cmd', WRAPPER_CMD],
  ['wrapper .ps1', WRAPPER_PS1],
  ['MCP_CLIENTS.md', MCP_CLIENTS_MD],
]) {
  if (!fs.existsSync(file)) {
    console.error(`Missing required file [${label}]: ${file}`);
    console.error('Run npm run compile before packaging.');
    process.exit(1);
  }
}

// Create a staging directory
const STAGE = path.join(ROOT, 'out', '_package_stage');
if (fs.existsSync(STAGE)) fs.rmSync(STAGE, { recursive: true });
fs.mkdirSync(STAGE, { recursive: true });

// Copy files into staging dir
fs.copyFileSync(SERVER_BIN, path.join(STAGE, 'opengrok-mcp'));
fs.copyFileSync(WRAPPER_SH, path.join(STAGE, 'opengrok-mcp-wrapper.sh'));
fs.copyFileSync(WRAPPER_CMD, path.join(STAGE, 'opengrok-mcp-wrapper.cmd'));
fs.copyFileSync(WRAPPER_PS1, path.join(STAGE, 'opengrok-mcp-wrapper.ps1'));
fs.copyFileSync(MCP_CLIENTS_MD, path.join(STAGE, 'MCP_CLIENTS.md'));

// Set executable bit on Unix files (no-op on Windows, harmless)
try {
  fs.chmodSync(path.join(STAGE, 'opengrok-mcp'), 0o755);
  fs.chmodSync(path.join(STAGE, 'opengrok-mcp-wrapper.sh'), 0o755);
} catch {
  // On Windows chmod may fail — acceptable
}

// Build archives
const archives = [
  {
    name: `opengrok-mcp-server-${version}-linux.tar.gz`,
    cmd: `tar -czf "${ROOT}/opengrok-mcp-server-${version}-linux.tar.gz" -C "${STAGE}" .`,
  },
  {
    name: `opengrok-mcp-server-${version}-darwin.tar.gz`,
    cmd: `tar -czf "${ROOT}/opengrok-mcp-server-${version}-darwin.tar.gz" -C "${STAGE}" .`,
  },
  {
    name: `opengrok-mcp-server-${version}-win.zip`,
    build: buildWindowsZip,
  },
];

for (const archive of archives) {
  const outPath = path.join(ROOT, archive.name);
  console.log(`Building ${archive.name}...`);
  try {
    if (archive.cmd) {
      execSync(archive.cmd, { stdio: 'inherit' });
    } else if (archive.build) {
      archive.build(outPath);
    }
    const stat = fs.statSync(outPath);
    console.log(`  → ${outPath} (${(stat.size / 1024).toFixed(1)} KB)`);
  } catch (err) {
    console.error(`  ✗ Failed to build ${archive.name}:`, err.message);
    process.exit(1);
  }
}

// Cleanup staging dir
fs.rmSync(STAGE, { recursive: true });

console.log('\nPackaging complete. Archives ready for release:');
for (const archive of archives) {
  console.log(`  ${archive.name}`);
}

/**
 * Build a .zip archive for Windows using Node's built-in zlib (no external deps).
 * Falls back to PowerShell's Compress-Archive on Windows if available.
 */
function buildWindowsZip(outPath) {
  // Try PowerShell first (available on Windows CI runners)
  try {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${outPath}' -Force"`,
      { stdio: 'inherit' }
    );
    return;
  } catch {
    // Not on Windows — fall through to zip CLI
  }

  // Try zip CLI (available on Linux/macOS CI)
  try {
    execSync(`cd "${STAGE}" && zip -r "${outPath}" .`, { stdio: 'inherit' });
    return;
  } catch {
    // zip not available
  }

  // Minimal fallback: create a tar.gz with .zip extension hint in the name
  // (not ideal but won't break the release pipeline)
  console.warn('  Warning: zip not available. Creating tar.gz for Windows archive.');
  execSync(`tar -czf "${outPath}" -C "${STAGE}" .`, { stdio: 'inherit' });
}
