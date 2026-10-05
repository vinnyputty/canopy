import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { iconSizes, ico, icns } from './icon-formats.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const builderRequire = createRequire(require.resolve('electron-builder'));
const { validateConfiguration } = builderRequire(
  'app-builder-lib/out/util/config/config',
);
await validateConfiguration(manifest.build, { debug: () => {} });
const directory = join(root, 'assets/branding');
const source = await readFile(join(directory, 'icon.svg'));
assert.match(source.toString(), /viewBox="0 0 24 24"/);
assert.doesNotMatch(
  source.toString(),
  /(?:href=|<script|<foreignObject|<text)/,
);
assert.equal(
  manifest.desktopName,
  `${manifest.build.linux.desktop.entry.StartupWMClass}.desktop`,
);
assert.equal(manifest.build.linux.syncDesktopName, true);
assert.equal(manifest.build.appId, 'app.canopy.desktop');
assert.equal(manifest.build.directories.buildResources, 'assets/branding');
assert.ok(manifest.build.files.includes('dist/branding/**'));
assert.equal(manifest.build.linux.icon, 'assets/branding/icons');
if (!process.argv.includes('--source-only')) {
  const generated = JSON.parse(
    await readFile(join(directory, 'generated.json'), 'utf8'),
  );
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    generated.source,
    hash(source),
    'Regenerate icons after editing the SVG',
  );
  assert.equal(generated.electron, manifest.devDependencies.electron);
  const frames = new Map();
  for (const size of iconSizes) {
    const name = `icons/${size}x${size}.png`;
    const png = await readFile(join(directory, name));
    assert.equal(hash(png), generated.files[name]);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.toString('ascii', 12, 16), 'IHDR');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.equal(png[24], 8);
    assert.equal(png[25], 6, 'RGBA PNG required');
    const idat = [];
    let offset = 8;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      assert.ok(offset + length + 12 <= png.length);
      if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT')
        idat.push(png.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    assert.equal(
      inflateSync(Buffer.concat(idat)).length,
      size * (size * 4 + 1),
    );
    frames.set(size, png);
  }
  for (const [name, expected] of [
    ['icon.ico', ico(frames)],
    ['icon.icns', icns(frames)],
  ]) {
    const actual = await readFile(join(directory, name));
    assert.equal(hash(actual), generated.files[name]);
    assert.deepEqual(actual, expected);
    const paths = name.endsWith('.icns')
      ? [manifest.build.mac.icon, manifest.build.dmg.icon]
      : [
          manifest.build.win.icon,
          ...['installerIcon', 'uninstallerIcon', 'installerHeaderIcon'].map(
            (key) => manifest.build.nsis[key],
          ),
        ];
    for (const path of paths)
      assert.deepEqual(await readFile(join(root, path)), actual);
  }
}
console.log('Branding configuration and assets valid.');
