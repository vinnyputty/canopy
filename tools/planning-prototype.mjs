import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist/planning-prototype', { recursive: true });
await build({
  entryPoints: ['src/exploratory/planning/main.tsx'],
  bundle: true,
  platform: 'browser',
  outfile: 'dist/planning-prototype/app.js',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await writeFile(
  'dist/planning-prototype/index.html',
  '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; connect-src \'none\'; object-src \'none\'; base-uri \'none\'"><title>Canopy planning experiment</title><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script src="app.js"></script></body></html>',
);
console.log('Open dist/planning-prototype/index.html in a browser.');
