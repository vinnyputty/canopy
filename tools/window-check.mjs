import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

assert.ok(process.env.CANOPY_APP_PATH, 'Use the Bazel window_check launcher');
assert.ok(process.env.CANOPY_ELECTRON_PATH, 'The launcher supplies Electron');
const profile = await mkdtemp(join(tmpdir(), 'canopy-window-check-'));
const savedFile = join(profile, 'window.json');
const env = { ...process.env, CANOPY_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
let running;
let processOutput = '';
const results = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readSaved = async () => JSON.parse(await readFile(savedFile, 'utf8'));

async function closeFailedWindow() {
  const child = running.process();
  let timeout;
  try {
    await Promise.race([
      Promise.resolve().then(() => running.close()),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Failure cleanup close timed out')),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    // Only the owned fixture child may be terminated, and only after a failure.
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(timer);
          child.off('exit', onExit);
          if (error) reject(error);
          else resolve();
        };
        const onExit = () => finish();
        const timer = setTimeout(
          () => finish(new Error('Failure cleanup child exit timed out')),
          5000,
        );
        child.once('exit', onExit);
        try {
          child.kill('SIGKILL');
        } catch (error) {
          finish(error);
        }
      });
    }
  }
}

async function launch() {
  running = await electron.launch({
    executablePath: process.env.CANOPY_ELECTRON_PATH,
    args: [process.env.CANOPY_APP_PATH],
    env,
    timeout: 30_000,
  });
  processOutput = '';
  running.process().stderr.on('data', (data) => {
    processOutput = (processOutput + data.toString()).slice(-8192);
  });
  await (await running.firstWindow()).waitForLoadState('domcontentloaded');
  // Let startup native geometry events and their debounce finish before counting.
  await pause(350);
  await running.evaluate(() => {
    const controls = globalThis.canopyWindowTest;
    controls.writes.length = 0;
    controls.events = { move: 0, moved: 0, resize: 0 };
  });
}

async function snapshot() {
  return running.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
    };
  });
}

async function stop(action = 'quit', finalChange = false) {
  const child = running.process();
  let timeout;
  const exited = new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && !signal) resolve();
      else reject(new Error(`Electron exited with ${code}/${signal}`));
    });
    timeout = setTimeout(
      () => reject(new Error('Bounds flush blocked exit')),
      15_000,
    );
  });
  // Observe early exit failures while evaluate is pending; awaiting the original
  // promise below still verifies termination and propagates its failure.
  exited.catch(() => {});
  try {
    const final = await running.evaluate(
      ({ app, BrowserWindow }, { action, finalChange }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (finalChange) {
          const bounds = window.getNormalBounds();
          window.setBounds({
            ...bounds,
            x: bounds.x + 3,
            width: bounds.width + 3,
          });
        }
        const value = {
          bounds: window.getNormalBounds(),
          maximized: window.isMaximized(),
        };
        // Return the observation before process teardown; quit is still issued in
        // the same native turn, well before the 200 ms bounds debounce expires.
        setTimeout(() => {
          if (action === 'close') {
            app.once('window-all-closed', () => app.quit());
            window.close();
          } else app.quit();
        }, 0);
        return value;
      },
      { action, finalChange },
    );
    await exited;
    running = undefined;
    return final;
  } finally {
    clearTimeout(timeout);
  }
}

async function reopen(expected) {
  assert.deepEqual(await readSaved(), expected);
  await launch();
  assert.deepEqual(await snapshot(), expected);
}

async function burst(action) {
  const counts = await running.evaluate(async ({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const area = screen.getPrimaryDisplay().workArea;
    const positions = [];
    for (let i = 0; i < 24; i++) {
      window.setBounds({
        x: area.x + 20 + i,
        y: area.y + 20 + i,
        width: Math.min(1100, area.width - 80) + i,
        height: Math.min(700, area.height - 80) + i,
      });
      positions.push(window.getNormalBounds());
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    const controls = globalThis.canopyWindowTest;
    return {
      ...controls.events,
      first: positions[0],
      last: positions.at(-1),
      writes: controls.writes.filter((write) => write.name === 'window').length,
    };
  });
  assert.ok(
    counts.resize > 1,
    `Native events missing: ${JSON.stringify(counts)}`,
  );
  assert.notEqual(
    counts.first.x,
    counts.last.x,
    'Native position did not change',
  );
  assert.notEqual(
    counts.first.width,
    counts.last.width,
    'Native size did not change',
  );
  assert.equal(counts.writes, 0, 'Intermediate bounds escaped the debounce');
  const latest = await stop(action, true);
  await reopen(latest);
  results.push({
    check: `native move/resize burst + immediate ${action}/reopen`,
    ...counts,
    latest,
  });
}

let failed = false;
try {
  await launch();
  await burst('close');
  await burst('quit');

  await running.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].maximize(),
  );
  await expect
    .poll(() =>
      running.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isMaximized(),
      ),
    )
    .toBe(true);
  let latest = await stop();
  await reopen(latest);
  assert.equal(latest.maximized, true);
  results.push({ check: 'maximize + quit/reopen', latest });
  await running.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].unmaximize(),
  );
  await expect
    .poll(() =>
      running.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isMaximized(),
      ),
    )
    .toBe(false);
  latest = await stop();
  await reopen(latest);
  results.push({ check: 'unmaximize + quit/reopen', latest });

  for (const mode of ['minimized', 'fullscreen']) {
    const before = await snapshot();
    const entered = await running.evaluate(({ BrowserWindow }, mode) => {
      const window = BrowserWindow.getAllWindows()[0];
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000);
        window.once(
          mode === 'minimized' ? 'minimize' : 'enter-full-screen',
          () => {
            clearTimeout(timer);
            resolve(true);
          },
        );
        if (mode === 'minimized') window.minimize();
        else window.setFullScreen(true);
      });
    }, mode);
    if (!entered) {
      assert.equal(
        mode,
        'fullscreen',
        'Native minimize transition did not complete',
      );
      results.push({
        check: 'fullscreen native changes ignored + close/reopen',
        status: 'pending',
        reason:
          'Native enter-full-screen event not delivered in this desktop session',
      });
      await running.close();
      running = undefined;
      await reopen(before);
      continue;
    }
    await expect
      .poll(() =>
        running.evaluate(({ BrowserWindow }, mode) => {
          const window = BrowserWindow.getAllWindows()[0];
          return mode === 'minimized'
            ? window.isMinimized()
            : window.isFullScreen();
        }, mode),
      )
      .toBe(true);
    // Entering native fullscreen may finish a valid pre-fullscreen debounce.
    // Separate those transition events from the changes made while excluded.
    await pause(350);
    assert.deepEqual(await readSaved(), before);
    await running.evaluate(() => {
      globalThis.canopyWindowTest.writes.length = 0;
    });
    // Exercise a real API change while excluded, not synthetic emitted events.
    await running.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const bounds = window.getNormalBounds();
      window.setBounds({ ...bounds, x: bounds.x + 9, width: bounds.width + 9 });
    });
    await pause(350);
    assert.equal(
      await running.evaluate(
        () =>
          globalThis.canopyWindowTest.writes.filter(
            (write) => write.name === 'window',
          ).length,
      ),
      0,
    );
    assert.equal(
      await running.evaluate(({ BrowserWindow }, mode) => {
        const window = BrowserWindow.getAllWindows()[0];
        return mode === 'minimized'
          ? window.isMinimized()
          : window.isFullScreen();
      }, mode),
      true,
      'Native bounds API exited the excluded state',
    );
    await stop('close');
    await reopen(before);
    assert.equal(
      await running.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isFullScreen(),
      ),
      false,
    );
    results.push({
      check: `${mode} native changes ignored + close/reopen`,
      latest: before,
    });
  }

  // Force the real atomic replacement to fail only in this disposable profile.
  await rm(savedFile, { force: true });
  await mkdir(savedFile);
  await running.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const bounds = window.getNormalBounds();
    window.setBounds({ ...bounds, x: bounds.x + 5, width: bounds.width + 5 });
  });
  await expect
    .poll(() =>
      running.evaluate(() =>
        globalThis.canopyWindowTest.writes.some(
          (write) => write.name === 'window' && write.failed,
        ),
      ),
    )
    .toBe(true);
  const markers = await running.evaluate(async () => {
    const storage = globalThis.canopyWindowTest.storage;
    // Fake fixture credential records use the real queue, never safeStorage.
    const workspace = { fixture: 'window-failure-workspace' };
    const credentials = { fixture: 'window-failure-fake-credentials' };
    await Promise.all([
      storage.write('workspace', workspace),
      storage.write('credentials', credentials),
    ]);
    return { workspace, credentials };
  });
  for (const name of ['workspace', 'credentials']) {
    assert.deepEqual(
      JSON.parse(await readFile(join(profile, `${name}.json`), 'utf8')),
      markers[name],
    );
  }
  await stop('close'); // Final bounds replacement also fails; close must still exit.
  assert.match(processOutput, /Could not save window state/);
  for (const name of ['workspace', 'credentials']) {
    assert.deepEqual(
      JSON.parse(await readFile(join(profile, `${name}.json`), 'utf8')),
      markers[name],
    );
  }
  results.push({
    check:
      'actual bounds I/O failure + later sample workspace/fake credential writes + close',
  });
  await rm(savedFile, { recursive: true });
  // Do not load the intentionally minimal marker records into the renderer.
  await rm(join(profile, 'workspace.json'));
  await rm(join(profile, 'credentials.json'));

  const removed = {
    bounds: { x: 100000, y: 100000, width: 1200, height: 800 },
    maximized: false,
  };
  await writeFile(savedFile, JSON.stringify(removed));
  await launch();
  const restored = await snapshot();
  const reachable = await running.evaluate(({ BrowserWindow, screen }) => {
    const bounds = BrowserWindow.getAllWindows()[0].getNormalBounds();
    return screen
      .getAllDisplays()
      .some(
        ({ workArea: area }) =>
          bounds.x >= area.x &&
          bounds.y >= area.y &&
          bounds.x + bounds.width <= area.x + area.width &&
          bounds.y + bounds.height <= area.y + area.height,
      );
  });
  assert.equal(reachable, true);
  assert.notDeepEqual(restored.bounds, removed.bounds);
  await stop();
  await reopen(restored);
  await stop();
  results.push({
    check: 'removed-monitor coordinate fixture + reachable relaunch',
    latest: restored,
  });
  console.log(
    JSON.stringify(
      { platform: process.platform, arch: process.arch, results },
      null,
      2,
    ),
  );
} catch (error) {
  failed = true;
  console.error(JSON.stringify({ completed: results }, null, 2));
  throw error;
} finally {
  try {
    if (running) {
      if (failed) await closeFailedWindow();
      else await running.close();
    }
  } catch (error) {
    if (!failed) throw error;
    console.error('Window fixture cleanup also failed:', error);
  } finally {
    try {
      await rm(profile, { recursive: true, force: true });
    } catch (error) {
      if (!failed) throw error;
      console.error('Window fixture profile removal also failed:', error);
    }
  }
}
