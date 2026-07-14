// @ts-check
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch  = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

function copySqlWasm() {
  const src = require.resolve('sql.js/dist/sql-wasm.wasm');
  const outDir = path.resolve(__dirname, 'dist');
  const dest = path.join(outDir, 'sql-wasm.wasm');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  fs.copyFileSync(src, dest);
}

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: ['src/extension.ts'],
  bundle:      true,
  outfile:     'dist/extension.js',
  external:    ['vscode'],
  format:      'cjs',
  platform:    'node',
  target:      'node20',
  sourcemap:   true,
  minify,
};

if (watch) {
  esbuild.context(config).then(ctx => {
    copySqlWasm();
    ctx.watch();
    console.log('[esbuild] watching…');
  });
} else {
  esbuild.build(config)
    .then(() => copySqlWasm())
    .catch(() => process.exit(1));
}
