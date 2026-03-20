const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Sync server.json version with package.json (Phase 8.5)
function syncServerJsonVersion() {
  const pkgVersion = require('./package.json').version;
  const serverJsonPath = path.join(__dirname, 'server.json');
  if (!fs.existsSync(serverJsonPath)) return;
  const serverJson = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
  let changed = false;
  if (serverJson.version !== pkgVersion) {
    serverJson.version = pkgVersion;
    changed = true;
  }
  if (serverJson.packages) {
    for (const pkg of serverJson.packages) {
      if (pkg.version !== pkgVersion) {
        pkg.version = pkgVersion;
        changed = true;
      }
    }
  }
  if (changed) {
    fs.writeFileSync(serverJsonPath, JSON.stringify(serverJson, null, 2) + '\n', 'utf8');
    console.log(`Synced server.json version to ${pkgVersion}`);
  }
}

// Copy webview files to out directory
function copyWebviewFiles() {
  const srcDir = path.join(__dirname, 'src', 'webview');
  const destDir = path.join(__dirname, 'out', 'webview');
  
  if (!fs.existsSync(srcDir)) {
    console.log('No webview directory found, skipping copy.');
    return;
  }
  
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  
  const files = fs.readdirSync(srcDir);
  for (const file of files) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
  console.log(`Copied ${files.length} webview file(s) to out/webview/`);
}

const sharedOptions = {
  bundle: true,
  format: /** @type {'cjs'} */ ('cjs'),
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: /** @type {'node'} */ ('node'),
  logLevel: 'info',
  define: {
    '__VERSION__': JSON.stringify(require('./package.json').version),
  },
};

async function main() {
  // ---- VS Code Extension ----
  const extCtx = await esbuild.context({
    ...sharedOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    external: ['vscode'],  // provided at runtime by VS Code
  });

  // ---- MCP Server (standalone Node.js bundle) ----
  const srvCtx = await esbuild.context({
    ...sharedOptions,
    entryPoints: ['src/server/main.ts'],
    outfile: 'out/server/main.js',
    loader: { '.wasm': 'copy' }, // in case WASM imports leak through bundling
    banner: {
      js: '#!/usr/bin/env node',
    },
  });

  // ---- Sandbox Worker (separate entry point for worker_threads) ----
  const workerCtx = await esbuild.context({
    ...sharedOptions,
    entryPoints: ['src/server/sandbox-worker.ts'],
    outfile: 'out/server/sandbox-worker.js',
    loader: { '.wasm': 'copy' }, // copies .wasm to out/server/
    // QuickJS packages are external: loaded from node_modules at runtime
    // (emscripten module resolves WASM file via __dirname in node_modules)
    external: ['@sebastianwessel/quickjs', '@jitl/quickjs-ng-wasmfile-release-sync'],
  });

  if (watch) {
    await extCtx.watch();
    await srvCtx.watch();
    await workerCtx.watch();
  } else {
    await extCtx.rebuild();
    await extCtx.dispose();
    await srvCtx.rebuild();
    await srvCtx.dispose();
    await workerCtx.rebuild();
    await workerCtx.dispose();
  }
  
  // Copy webview files after build
  copyWebviewFiles();
  
  // Sync server.json version on every build
  syncServerJsonVersion();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
