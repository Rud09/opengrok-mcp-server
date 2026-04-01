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

// Copy QuickJS WASM file to out/server/ so the emscripten module can find it
// at runtime via __dirname (which resolves to out/server/ in the bundled worker).
function copyQuickJsWasm() {
  const src = path.join(
    __dirname,
    'node_modules/@jitl/quickjs-ng-wasmfile-release-sync/dist/emscripten-module.wasm'
  );
  const destDir = path.join(__dirname, 'out', 'server');
  const dest = path.join(destDir, 'emscripten-module.wasm');
  if (!fs.existsSync(src)) {
    console.error('Warning: QuickJS WASM not found at', src);
    return;
  }
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  fs.copyFileSync(src, dest);
  console.log('Copied emscripten-module.wasm to out/server/');
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
    // JSON.stringify wraps the version in quotes, producing a string literal
    // that esbuild substitutes at compile time: "9.0.2" → const v = "9.0.2"
    '__VERSION__': JSON.stringify(require('./package.json').version),
  },
};

async function main() {
  // ---- VS Code Extension ----
  const extCtx = await esbuild.context({
    ...sharedOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    // vscode: provided at runtime by VS Code
    // @napi-rs/keyring: prebuilt native .node binaries, must stay external
    external: [
      'vscode',
      '@napi-rs/keyring', '@napi-rs/keyring-linux-x64-gnu', '@napi-rs/keyring-linux-x64-musl',
      '@napi-rs/keyring-darwin-x64', '@napi-rs/keyring-darwin-arm64', '@napi-rs/keyring-win32-x64-msvc',
    ],
  });

  // ---- MCP Server (standalone Node.js bundle) ----
  const srvCtx = await esbuild.context({
    ...sharedOptions,
    entryPoints: ['src/server/main.ts'],
    outfile: 'out/server/main.js',
    loader: { '.wasm': 'copy' }, // in case WASM imports leak through bundling
    // CLI-only packages that must stay external:
    // - @napi-rs/keyring: ships prebuilt native .node binaries
    // - @clack/prompts: interactive terminal UI (ESM-only, CJS bundling unsupported)
    // - @iarna/toml: used only by CLI setup wizard at runtime
    external: [
      '@napi-rs/keyring', '@napi-rs/keyring-linux-x64-gnu', '@napi-rs/keyring-linux-x64-musl',
      '@napi-rs/keyring-darwin-x64', '@napi-rs/keyring-darwin-arm64', '@napi-rs/keyring-win32-x64-msvc',
      '@clack/prompts', '@iarna/toml',
    ],
    banner: {
      js: '#!/usr/bin/env node',
    },
  });

  // ---- Sandbox Worker (separate entry point for worker_threads) ----
  const workerCtx = await esbuild.context({
    ...sharedOptions,
    entryPoints: ['src/server/sandbox-worker.ts'],
    outfile: 'out/server/sandbox-worker.js',
    // @sebastianwessel/quickjs and @jitl/quickjs-ng-wasmfile-release-sync are
    // bundled (not external) so they work inside a VSIX where node_modules is absent.
    // The emscripten module resolves the WASM via __dirname at runtime, so we
    // explicitly copy emscripten-module.wasm to out/server/ after the build.
    //
    // FIX: The @jitl ESM emscripten loader uses `import.meta.url` to call
    // createRequire(import.meta.url) and resolve the WASM path. esbuild bundles
    // to CJS, making import.meta.url === undefined and crashing the worker.
    // We shim it with a CJS-compatible file URL derived from __filename.
    define: {
      ...sharedOptions.define,
      'import.meta.url': 'importMetaUrl',
    },
    banner: {
      js: 'var importMetaUrl = require("url").pathToFileURL(__filename).href;',
    },
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
  
  // Copy QuickJS WASM so sandbox-worker.js can load it at runtime
  copyQuickJsWasm();

  // Copy webview files after build
  copyWebviewFiles();

  // Sync server.json version on every build
  syncServerJsonVersion();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
