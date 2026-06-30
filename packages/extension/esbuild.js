// @ts-check
const esbuild = require('esbuild');

const watch  = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: ['src/extension.ts'],
  bundle:      true,
  outfile:     'dist/extension.js',
  external:    ['vscode', 'sql.js'],
  format:      'cjs',
  platform:    'node',
  target:      'node20',
  sourcemap:   true,
  minify,
};

if (watch) {
  esbuild.context(config).then(ctx => {
    ctx.watch();
    console.log('[esbuild] watching…');
  });
} else {
  esbuild.build(config).catch(() => process.exit(1));
}
