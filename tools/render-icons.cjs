// Run only through //:icons, serialized with other desktop work.
const { app, BrowserWindow } = require('electron');
const { readFile, mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const userData = mkdtempSync(join(tmpdir(), 'canopy-icons-'));
app.setPath('userData', userData);
process.on('exit', () => rmSync(userData, { recursive: true, force: true }));
const output = process.argv[2];
app.disableHardwareAcceleration();
let window;
app
  .whenReady()
  .then(async () => {
    const { iconSizes, ico, icns } = await import(
      pathToFileURL(join(__dirname, 'icon-formats.mjs')).href
    );
    const source = await readFile(join(output, 'icon.svg'));
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await window.loadURL('data:text/html,<html><body></body></html>');
    const frames = new Map();
    const files = {};
    await mkdir(join(output, 'icons'), { recursive: true });
    const save = async (name, bytes) => {
      await writeFile(join(output, name), bytes);
      files[name] = createHash('sha256').update(bytes).digest('hex');
    };
    for (const size of iconSizes) {
      const data = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = ${JSON.stringify(`data:image/svg+xml;base64,${source.toString('base64')}`)};
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = ${size};
      canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size});
      return canvas.toDataURL('image/png').split(',')[1];
    })()`);
      const bytes = Buffer.from(data, 'base64');
      frames.set(size, bytes);
      await save(`icons/${size}x${size}.png`, bytes);
    }
    await save('icon.ico', ico(frames));
    await save('icon.icns', icns(frames));
    await writeFile(
      join(output, 'generated.json'),
      JSON.stringify(
        {
          source: createHash('sha256').update(source).digest('hex'),
          electron: process.versions.electron,
          files,
        },
        null,
        2,
      ) + '\n',
    );
    window.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
