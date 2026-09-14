import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('dist/renderer', { recursive: true });
await Promise.all([
  build({
    entryPoints: ['src/main/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    outfile: 'dist/main.cjs',
  }),
  build({
    entryPoints: ['src/main/preload.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: 'dist/preload.cjs',
  }),
  build({
    entryPoints: ['src/renderer/main.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    outfile: 'dist/renderer/app.js',
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
  }),
  build({
    entryPoints: ['broker/server.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: 'dist/broker.cjs',
  }),
]);
await writeFile(
  'dist/renderer/index.html',
  `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>Canopy</title><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script src="app.js"></script></body></html>`,
);
