const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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
    external: [],  // fully bundle — no runtime install needed
    banner: {
      js: '#!/usr/bin/env node',
    },
  });

  if (watch) {
    await extCtx.watch();
    await srvCtx.watch();
  } else {
    await extCtx.rebuild();
    await extCtx.dispose();
    await srvCtx.rebuild();
    await srvCtx.dispose();
  }
  
  // Copy webview files after build
  copyWebviewFiles();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
