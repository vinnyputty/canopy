import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Execute the production callbacks under Node; no Electron process is started.
const source = ts.createSourceFile(
  'app.ts',
  readFileSync(new URL('../src/main/app.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
function find(match: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (match(node)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(found);
  return found;
}
const compile = (code: string) =>
  ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
const launch = find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'launch',
).getText(source);
const demo = find(
  (node) =>
    ts.isPropertyAssignment(node) && node.name.getText(source) === 'launchDemo',
) as ts.PropertyAssignment;

for (const winner of [false, true]) {
  for (const demoMode of [false, true]) {
    test(`inherited demo flag preserves profile after ${winner ? 'owner' : 'duplicate'} ${demoMode ? 'demo' : 'main'} exit`, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'canopy-inherited-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      await writeFile(join(directory, 'sentinel'), 'keep inherited profile');
      const script = `
        const assert = require('node:assert/strict');
        const { EventEmitter } = require('node:events');
        const { rmSync } = require('node:fs');
        let ready = 0, quits = 0;
        const app = Object.assign(new EventEmitter(), {
          requestSingleInstanceLock: () => ${winner},
          whenReady: () => { ready++; return new Promise(() => {}); },
          quit: () => { quits++; },
        });
        const start = () => { throw new Error('Unexpected profile access'); };
        const focusWindow = () => {};
        const focusRequested = false;
        const dialog = { showErrorBox() { throw new Error('Unexpected dialog'); } };
        ${compile(launch)}
        launch(undefined, ${demoMode});
        app.emit('window-all-closed');
        assert.equal(ready, ${winner ? 1 : 0});
        assert.equal(quits, ${winner ? '(process.platform === "darwin" && !' + demoMode + ' ? 0 : 1)' : '1'});
      `;
      const result = spawnSync(process.execPath, ['-e', script], {
        env: {
          ...process.env,
          CANOPY_USER_DATA: directory,
          CANOPY_DEMO_TEMP: '1',
        },
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(
        await readFile(join(directory, 'sentinel'), 'utf8'),
        'keep inherited profile',
      );
    });
  }
}

for (const outcome of ['exit', 'throw', 'error'] as const) {
  test(`demo parent removes only its mkdtemp directory on child ${outcome}`, async (t) => {
    const holder = await mkdtemp(join(tmpdir(), 'canopy-owned-'));
    t.after(() => rm(holder, { recursive: true, force: true }));
    const inherited = join(holder, 'user-profile');
    await mkdir(inherited);
    const sentinel = join(inherited, 'sentinel');
    await writeFile(sentinel, 'keep adjacent user data');
    let owned = '';
    const removed: Promise<void>[] = [];
    const child = Object.assign(new EventEmitter(), { unref() {} });
    const launchDemo = runInNewContext(
      compile(`(${demo.initializer.getText(source)})`),
      {
        demoMode: false,
        demoLaunch: null,
        window: null,
        process: {
          execPath: process.execPath,
          env: {
            CANOPY_USER_DATA: inherited,
            CANOPY_DEMO_TEMP: '1',
            ELECTRON_RUN_AS_NODE: '1',
          },
        },
        join,
        tmpdir: () => holder,
        mkdtemp: async (prefix: string) => (owned = await mkdtemp(prefix)),
        app: { isPackaged: false, getAppPath: () => 'staged-app' },
        spawn: (_exe: string, args: string[], options: any) => {
          assert.deepEqual(Array.from(args), ['staged-app', '--canopy-demo']);
          assert.equal(options.env.CANOPY_USER_DATA, owned);
          assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
          if (outcome === 'throw') throw new Error('Synthetic spawn failure');
          queueMicrotask(() =>
            outcome === 'error'
              ? child.emit('error', new Error('Synthetic spawn failure'))
              : child.emit('spawn'),
          );
          return child;
        },
        rm: (path: string, options: Parameters<typeof rm>[1]) => {
          assert.equal(
            path,
            owned,
            'Only the created child directory is owned',
          );
          const completion = rm(path, options);
          removed.push(completion);
          return completion;
        },
      },
    ) as () => Promise<void>;
    if (outcome === 'exit') {
      await launchDemo();
      await writeFile(join(owned, 'sentinel'), 'active child');
      assert.equal(removed.length, 0, 'Live child profile must remain');
      assert.equal(
        await readFile(join(owned, 'sentinel'), 'utf8'),
        'active child',
      );
      child.emit('exit', 0);
    } else {
      await assert.rejects(launchDemo(), /Synthetic spawn failure/);
    }
    assert.equal(removed.length, 1);
    await Promise.all(removed);
    await assert.rejects(stat(owned), { code: 'ENOENT' });
    assert.equal(await readFile(sentinel, 'utf8'), 'keep adjacent user data');
  });
}
