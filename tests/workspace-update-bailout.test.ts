import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import type { Workspace } from '../src/shared/types';
import { withScrollPositions } from '../src/renderer/scroll-position';
import { callback, execute, findNode, sourceFile } from './source-probe';

const renderer = sourceFile(
  new URL('../src/renderer/App.tsx', import.meta.url),
);
const setter = callback(renderer, 'setWorkspace');
const saving = callback(renderer, 'saveWorkspace');
const effect = findNode(
  renderer,
  (node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    node.expression.getText() === 'useEffect' &&
    node.getText().includes('Couldn’t save workspace:'),
).arguments[0].getText();
const ref = findNode(
  renderer,
  (node): node is ts.BinaryExpression =>
    ts.isBinaryExpression(node) &&
    node.left.getText() === 'workspaceRef.current' &&
    node.right.getText().startsWith('withScrollPositions('),
).getText();
// Retained bb7 updater runs under the same real React and production save effect.
const previous = `useCallback(update => {
  storeWorkspace(current => typeof update === 'function'
    ? update(withScrollPositions(current, scrollPositions.current)) : update);
}, [])`;

async function fixture(source = setter) {
  const { JSDOM } = createRequire(import.meta.url)('jsdom');
  const dom = new JSDOM('<!doctype html><div id="host"></div>');
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const tab = {
    id: 'open',
    connectionId: 'fixture',
    rootKey: 'CAN-1',
    summary: 'Sample',
    expanded: [],
    hideDone: false,
    scrollTop: 0,
  };
  const initial: Workspace = {
    tabs: [tab],
    closedTabs: [{ ...tab, id: 'closed' }],
    activeTabId: 'open',
    theme: 'system',
    shortcuts: {},
    sidebarCollapsed: false,
  };
  const scrollPositions = { current: new Map<string, number>() };
  const workspaceRef = { current: initial };
  const workspaceSaveTimer = { current: null as number | null };
  const pendingWorkspaceSave = { current: Promise.resolve() };
  const timers = new Map<number, () => void>();
  let serial = 0,
    effects = 0,
    state = initial;
  const writes: Workspace[] = [];
  let update!: React.Dispatch<React.SetStateAction<Workspace>>;
  let save!: (value: Workspace) => Promise<void>;
  const context = {
    useCallback: React.useCallback,
    withScrollPositions,
    scrollPositions,
    workspaceRef,
    workspaceSaveTimer,
    pendingWorkspaceSave,
    demoResetting: { current: false },
    setErrors: () => {},
    window: {
      setTimeout: (run: () => void) => {
        const id = ++serial;
        timers.set(id, run);
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
      canopy: {
        saveWorkspace: async (value: Workspace) => {
          writes.push(value);
        },
      },
    },
  };
  function Component() {
    const [workspace, storeWorkspace] = React.useState(initial);
    state = workspace;
    execute(`() => {${ref};}`, { ...context, workspace })();
    update = execute(source, { ...context, storeWorkspace });
    save = execute(saving, context);
    React.useEffect(() => {
      effects++;
      return execute(effect, {
        ...context,
        workspace,
        saveWorkspace: save,
        ready: true,
      })();
    }, [workspace, save]);
    return React.createElement('span', null, workspace.theme);
  }
  const root = createRoot(dom.window.document.querySelector('#host')!);
  await act(async () => root.render(React.createElement(Component)));
  const flush = async () => {
    for (const [id, run] of timers) {
      timers.delete(id);
      run();
    }
    await pendingWorkspaceSave.current;
  };
  await flush();
  return {
    initial,
    scrollPositions,
    workspaceRef,
    timers,
    writes,
    flush,
    effects: () => effects,
    state: () => state,
    update: (value: React.SetStateAction<Workspace>) =>
      act(async () => update(value)),
    save: (value: Workspace) => save(value),
    close: async () => {
      await act(async () => root.unmount());
      for (const [name, descriptor] of prior)
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      dom.window.close();
    },
  };
}

for (const source of [setter, previous])
  test(`actual React ${source === setter ? 'current' : 'prior'} setter handles no-op identity`, async () => {
    const f = await fixture(source);
    try {
      for (const positions of [
        [],
        [
          ['open', 90],
          ['closed', 60],
        ],
      ] as [string, number][][]) {
        f.scrollPositions.current = new Map(positions);
        const stored = f.state(),
          effects = f.effects(),
          writes = f.writes.length;
        await f.update((value) => value);
        if (source === setter) {
          assert.equal(f.state(), stored);
          assert.equal(f.effects(), effects);
          assert.equal(f.timers.size, 0);
          await f.flush();
          assert.equal(f.writes.length, writes);
        } else {
          assert.notEqual(f.state(), stored);
          assert.equal(f.effects(), effects + 1);
          assert.equal(f.timers.size, 1);
          await f.flush();
          assert.equal(f.writes.length, writes + 1);
        }
      }
    } finally {
      await f.close();
    }
  });

test('actual setter preserves changes, direct identity and latest ref/save scroll offsets', async () => {
  const f = await fixture();
  try {
    f.scrollPositions.current.set('open', 90);
    f.scrollPositions.current.set('closed', 60);
    await f.update((value) => ({ ...value, theme: 'dark' }));
    assert.equal(f.state().theme, 'dark');
    assert.equal(f.state().tabs[0].scrollTop, 90);
    assert.equal(f.workspaceRef.current.closedTabs![0].scrollTop, 60);
    await f.flush();
    assert.equal(f.writes.at(-1)!.tabs[0].scrollTop, 90);
    const direct = { ...f.initial, theme: 'light' as const };
    await f.update(direct);
    assert.equal(f.state(), direct);
    assert.equal(f.workspaceRef.current.tabs[0].scrollTop, 90);
    f.scrollPositions.current.set('open', 120);
    await f.flush();
    assert.equal(f.writes.at(-1)!.tabs[0].scrollTop, 120);
    f.scrollPositions.current.set('open', 150);
    await f.update((value) => value);
    await f.save(f.workspaceRef.current);
    assert.equal(f.writes.at(-1)!.tabs[0].scrollTop, 150);
  } finally {
    await f.close();
  }
});
