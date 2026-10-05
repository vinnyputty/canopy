import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

let seedSource: string, preloadReload: string, mainReload: string;
before(async () => {
  async function expression(path: string, name: string, variable = false) {
    const source = await readFile(path, 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    let result: string | undefined;
    function visit(node: ts.Node) {
      if (
        ((variable && ts.isVariableDeclaration(node)) ||
          (!variable && ts.isPropertyAssignment(node))) &&
        node.name.getText(ast) === name
      )
        result = node.initializer!.getText(ast);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(result, `Actual ${name} expression missing from ${path}`);
    return result;
  }
  seedSource = await expression('tools/smoke-backup-cases.mjs', 'seed', true);
  preloadReload = await expression('src/main/preload.ts', 'reloadWorkspace');
  mainReload = await expression('src/main/app.ts', 'reloadWorkspace');
});

function model(
  options: {
    saveFailure?: unknown;
    navigationFailure?: unknown;
    missingSettings?: boolean;
  } = {},
) {
  const workspace = { theme: 'system' };
  const events: string[] = [];
  const destroyed = new Error('Execution context was destroyed');
  let saved = false,
    visible = true,
    documentAlive = true;
  let releaseSave!: () => void, releaseLoad!: () => void;
  const saving = new Promise<void>((resolve) => (releaseSave = resolve));
  const loading = new Promise<void>((resolve) => (releaseLoad = resolve));
  const reload = runInNewContext(`(${mainReload})`, {
    window: {
      webContents: {
        reload() {
          assert(saved, 'Reload must follow completed save');
          events.push('reload');
          visible = false;
          documentAlive = false;
        },
      },
    },
  }) as () => void;
  const rendererReload = runInNewContext(`(${preloadReload})`, {
    ipcRenderer: {
      invoke: async (channel: string) => {
        assert.equal(channel, 'canopy:reloadWorkspace');
        reload();
        // Main's actual handler reloads synchronously before the IPC response.
        if (!documentAlive) throw destroyed;
      },
    },
  });
  const context = {
    window: {
      canopy: {
        saveWorkspace: async (value: unknown) => {
          assert.equal(value, workspace);
          events.push('save');
          await saving;
          if ('saveFailure' in options) throw options.saveFailure;
          saved = true;
          events.push('saved');
        },
        reloadWorkspace: rendererReload,
      },
    },
    page: {
      evaluate: async (callback: (value: unknown) => unknown, value: unknown) =>
        callback(value),
      reload: async () => {
        reload();
        await loading;
        if ('navigationFailure' in options) throw options.navigationFailure;
        documentAlive = true;
        visible = !options.missingSettings;
        events.push('loaded');
      },
      getByRole: (role: string, value: unknown) => {
        assert.equal(role, 'button');
        assert.deepEqual(JSON.parse(JSON.stringify(value)), {
          name: 'Settings',
          exact: true,
        });
        return { visible: () => visible };
      },
    },
    expect: Object.assign(
      (locator: { visible: () => boolean }) => ({
        toBeVisible: async () => {
          assert(locator.visible(), 'New document must be ready');
          events.push('settings');
        },
      }),
      {
        poll: (read: () => Promise<unknown>) => ({
          toBe: async (theme: string) => {
            assert.equal(await read(), theme);
            events.push('verified');
          },
        }),
      },
    ),
    saved: async () => {
      assert(saved);
      return workspace;
    },
  };
  const run = (source = seedSource) =>
    (
      runInNewContext(`(${source})`, context) as (
        workspace: unknown,
      ) => Promise<void>
    )(workspace);
  return { run, events, releaseSave, releaseLoad, destroyed };
}

test('actual seed waits for save and host reload before checking the new document', async () => {
  const m = model();
  let completed = false;
  const operation = m.run().then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.deepEqual(m.events, ['save']);
  m.releaseSave();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(m.events, ['save', 'saved', 'reload']);
  assert.equal(completed, false);
  m.releaseLoad();
  await operation;
  assert.deepEqual(m.events, [
    'save',
    'saved',
    'reload',
    'loaded',
    'settings',
    'verified',
  ]);
});

test('prior actual seed loses its renderer context on synchronous main reload', async () => {
  // Pre-fix seed callback retained from 0b9ea50; same actual preload/main handlers.
  const previous = `async (workspace) => {
    await page.evaluate(async (value) => {
      await window.canopy.saveWorkspace(value);
      await window.canopy.reloadWorkspace();
    }, workspace);
    await expect(page.getByRole('button', {name: 'Settings', exact: true})).toBeVisible();
    await expect.poll(async () => (await saved()).theme).toBe(workspace.theme);
  }`;
  const m = model();
  const rejected = assert.rejects(
    m.run(previous),
    (error) => error === m.destroyed,
  );
  m.releaseSave();
  await rejected;
  assert.deepEqual(m.events, ['save', 'saved', 'reload']);
});

test('actual seed rejects a loaded document with incomplete application readiness', async () => {
  const m = model({ missingSettings: true });
  const rejected = assert.rejects(m.run(), /New document must be ready/);
  m.releaseSave();
  m.releaseLoad();
  await rejected;
  assert.deepEqual(m.events, ['save', 'saved', 'reload', 'loaded']);
});

for (const failure of [new Error('save failed'), undefined, 0])
  test(`actual seed preserves save failure ${String(failure)} without reload`, async () => {
    const m = model({ saveFailure: failure });
    const rejected = assert.rejects(m.run(), (error) => error === failure);
    m.releaseSave();
    await rejected;
    assert.deepEqual(m.events, ['save']);
  });

for (const failure of [new Error('navigation failed'), undefined, 0])
  test(`actual seed preserves navigation failure ${String(failure)} without accepting old Settings`, async () => {
    const m = model({ navigationFailure: failure });
    const rejected = assert.rejects(m.run(), (error) => error === failure);
    m.releaseSave();
    m.releaseLoad();
    await rejected;
    assert.deepEqual(m.events, ['save', 'saved', 'reload']);
  });
