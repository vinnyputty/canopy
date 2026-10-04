import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createRequire } from 'node:module';
import { Mutations, type MutationView } from '../src/renderer/mutations';
import { Pickers } from '../src/renderer/pickers';
import { ControlledDemoProvider } from './fixtures/controlled';
import type { CanopyAPI, IssuePatch, TabState } from '../src/shared/types';

// Execute the actual renderer callback, menu, preload method and main handler.
// Only hooks/IPC dispatch are substituted; picker, mutation queue, validation
// and the smoke provider retain their production implementations. No GUI loads.
const parse = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
const app = parse('src/renderer/App.tsx');
const main = parse('src/main/app.ts');
const preload = parse('src/main/preload.ts');
function find(ast: ts.SourceFile, predicate: (n: ts.Node) => boolean) {
  let found: ts.Node | undefined;
  function visit(n: ts.Node) {
    if (predicate(n)) found = n;
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.ok(found);
  return found;
}
const init = (ast: ts.SourceFile, name: string) =>
  (
    find(
      ast,
      (n) => ts.isVariableDeclaration(n) && n.name.getText(ast) === name,
    ) as ts.VariableDeclaration
  ).initializer!.getText(ast);
const declaration = (ast: ts.SourceFile, name: string) =>
  find(
    ast,
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
  ).getText(ast);
const run = (code: string, context: object) =>
  vm.runInNewContext(
    ts.transpileModule(code, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
      },
    }).outputText,
    context,
  );
const property = (ast: ts.SourceFile, name: string) =>
  (
    find(
      ast,
      (n) => ts.isPropertyAssignment(n) && n.name.getText(ast) === name,
    ) as ts.PropertyAssignment
  ).initializer.getText(ast);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Editor = { connectionId: string; key: string; field: string } | null;
async function fixture(dom?: Window, notify = () => {}) {
  const provider = new ControlledDemoProvider();
  const handlers = run(
    `${['text', 'key', 'issueKey', 'patch'].map((n) => declaration(main, n)).join('\n')}
    const provider=${init(main, 'provider')};
    const normalized=${init(main, 'normalized')};
    (${property(main, 'update')})`,
    {
      fixture: { connection: { id: 'demo' }, provider },
      connections: () => [{ id: 'demo', provider: 'demo' }],
    },
  );
  const update = run(`(${property(preload, 'update')})`, {
    ipcRenderer: {
      invoke: (channel: string, ...args: unknown[]) => {
        assert.equal(channel, 'canopy:update');
        return handlers(...args);
      },
    },
  }) as CanopyAPI['update'];
  const api = {
    update,
    tree: (_id: string, key: string) => provider.tree(key),
    rank: (_id: string, key: string, anchor: string) =>
      provider.rank(key, anchor),
    transitions: (_id: string, key: string) => provider.transitions(key),
    priorities: (_id: string, key: string) => provider.priorities(key),
    cachedUsers: () => provider.cachedUsers(),
    assignees: (_id: string, key: string) => provider.assignees(key),
    validateAssignee: (_id: string, key: string, id: string) =>
      provider.validateAssignee(key, id),
  };
  const pickers = new Pickers(api, () => {});
  let view!: MutationView;
  const errors: string[] = [];
  const mutations = new Mutations(
    api,
    (next) => {
      view = next;
      notify();
    },
    (e) => errors.push(e),
  );
  const tab: TabState = {
    id: 'tab',
    connectionId: 'demo',
    rootKey: 'CAN-100',
    expanded: [],
    hideDone: false,
    scrollTop: 0,
  };
  mutations.receive(tab, await provider.tree(tab.rootKey), mutations.revision);
  const issue = () =>
    view.snapshots[tab.id].issues.find((i) => i.key === 'CAN-111')!;
  await pickers.open('demo', 'CAN-111', 'status', tab.rootKey, false, issue());
  let editor: Editor = {
    connectionId: 'demo',
    key: 'CAN-111',
    field: 'status',
  };
  const activeIdRef = { current: tab.id },
    editSession = { current: 1 };
  const setEditor = (value: (current: Editor) => Editor) => {
    editor = value(editor);
    notify();
  };
  const save = run(`(${init(app, 'updateIssue')})`, {
    useCallback: (fn: unknown) => fn,
    activeTab: tab,
    activeIdRef,
    editSession,
    setEditor,
    mutations,
    pickers,
  }) as (key: string, patch: IssuePatch) => Promise<void>;
  const hooks = {
    React,
    useRef: dom ? React.useRef : () => ({ current: null }),
    useLayoutEffect: dom ? React.useLayoutEffect : () => {},
    window: dom,
    document: dom?.document,
    cx: (...names: unknown[]) => names.filter(Boolean).join(' '),
    PickerFeedback: () => null,
  };
  const status = run(
    `${declaration(app, 'navigateChoices')}\n(${declaration(app, 'StatusEditor')})`,
    hooks,
  );
  const cell = run(`(${declaration(app, 'FieldCell')})`, hooks);
  let flight: Promise<void> | undefined;
  const render = () => {
    const active = editor?.field === 'status';
    return cell({
      active,
      label: 'Edit status for CAN-111',
      onEdit: () => {
        editSession.current++;
        editor = { connectionId: 'demo', key: 'CAN-111', field: 'status' };
        notify();
      },
      children: status({
        active,
        issue: issue(),
        choices: pickers.values['demo:CAN-111']?.transitions,
        state: pickers.values['demo:CAN-111']?.status,
        paths: { routes: [] },
        retry: () => {},
        save: (id: string) => {
          flight = save('CAN-111', { transitionId: id });
        },
        savePath: () => {},
        openWorkflow: () => {},
      }),
    });
  };
  const click = () => {
    const buttons: React.ReactElement<any>[] = [];
    function walk(node: any) {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!React.isValidElement(node)) return;
      const element = node as React.ReactElement<any>;
      if (element.props.role === 'menuitem') buttons.push(element);
      walk(element.props.children);
    }
    walk(render());
    const button = buttons.find(
      (b) => b.props.children[0].props.children[0] === 'In Progress',
    );
    assert.ok(button, 'actual direct transition menu item');
    button.props.onClick();
    return flight!;
  };
  return {
    provider,
    mutations,
    pickers,
    errors,
    issue,
    render,
    click,
    activeIdRef,
    editSession,
    editor: () => editor,
    set: (next: Editor) => {
      editor = next;
    },
  };
}

test('actual status menu save closes the editor and confirms through preload/main validation and provider', async () => {
  const f = await fixture();
  f.provider.hold('write', 'update', 'CAN-111');
  const flight = f.click();
  await tick();
  assert.equal(f.provider.started('write'), true);
  assert.equal(f.editor(), null);
  assert.equal(f.issue().status.name, 'In Progress'); // Optimistic while held.
  assert.equal(f.render().props.role, 'button');
  assert.equal(f.mutations.pending('demo'), true);
  f.provider.release('write');
  await flight;
  assert.equal(
    (await f.provider.tree('CAN-100')).issues.find((i) => i.key === 'CAN-111')!
      .status.name,
    'In Progress',
  );
  assert.equal(f.issue().status.name, 'In Progress');
  assert.equal(f.render().props['aria-label'], 'Edit status for CAN-111');
  assert.equal(f.pickers.values['demo:CAN-111'], undefined);
  assert.equal(f.mutations.pending('demo'), false);
  assert.deepEqual(f.errors, []);
});

for (const change of ['none', 'tab', 'session', 'new editor'] as const)
  test(`actual rejected status write rolls back and preserves editor ownership: ${change}`, async () => {
    const f = await fixture();
    f.provider.hold('reject', 'update', 'CAN-111');
    const before = f.issue().status;
    const flight = f.click();
    await tick();
    assert.equal(f.editor(), null);
    if (change === 'tab') f.activeIdRef.current = 'other';
    if (change === 'session') f.editSession.current++;
    if (change === 'new editor')
      f.set({ connectionId: 'demo', key: 'CAN-112', field: 'priority' });
    f.provider.release('reject', 'Status permission denied');
    await flight;
    assert.deepEqual(f.issue().status, before);
    assert.match(f.errors[0], /Status permission denied/);
    assert.match(
      f.pickers.values['demo:CAN-111'].status!.error!,
      /selection was rejected/,
    );
    assert.equal(f.mutations.pending('demo'), false);
    if (change === 'none') {
      assert.equal(f.editor()?.field, 'status');
      assert.equal(
        f.render().props.role,
        undefined,
        'failed write cannot satisfy completed semantic field',
      );
    } else if (change === 'new editor')
      assert.equal(f.editor()?.key, 'CAN-112');
    else assert.equal(f.editor(), null);
  });

// Real ReactDOM focus, keyboard propagation and the save callback are exercised;
// geometry is deliberately excluded from this portable source regression.
for (const activation of ['pointer', 'keyboard'] as const)
  test(`status menu ${activation} activation closes the real field through the save pipeline`, async () => {
    const { JSDOM } = createRequire(import.meta.url)('jsdom');
    const dom = new JSDOM('<!doctype html><div id="host"></div>', {
      pretendToBeVisual: true,
    });
    const prior = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    const host = dom.window.document.querySelector('#host')!;
    const root = createRoot(host);
    let redraw = () => {};
    const f = await fixture(dom.window, () => redraw());
    function Field() {
      const [, changed] = React.useReducer((value) => value + 1, 0);
      redraw = changed;
      return f.render();
    }
    try {
      await act(async () => root.render(React.createElement(Field)));
      const button = [...host.querySelectorAll('button')].find(
        (element) => element.textContent === 'In Progress',
      )!;
      assert.ok(button);
      if (activation === 'keyboard') {
        const first = host.querySelector('button')!;
        await act(async () => {
          first.focus();
          first.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', {
              key: 'ArrowDown',
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        assert.equal(dom.window.document.activeElement, button);
      } else {
        const focused = dom.window.document.activeElement;
        const down = new dom.window.MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
        });
        await act(async () => {
          button.dispatchEvent(down);
          // jsdom lacks the browser's mouse-focus default.
          if (!down.defaultPrevented) button.focus();
        });
        assert.equal(dom.window.document.activeElement === focused, true);
        assert.equal(down.defaultPrevented, true);
      }
      f.provider.hold('write', 'update', 'CAN-111');
      await act(async () => {
        if (activation === 'keyboard') {
          const enter = new dom.window.KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
          });
          button.dispatchEvent(enter);
          assert.equal(enter.defaultPrevented, false);
        }
        // jsdom lacks native keyboard button activation; deliver that default.
        button.click();
        await tick();
      });
      assert.equal(f.provider.started('write'), true);
      assert.equal(f.editor(), null);
      assert.equal(host.querySelector('[role="menu"]'), null);
      assert.equal(
        host.querySelector('[aria-label="Edit status for CAN-111"]')
          ?.textContent,
        'In Progress',
      );
      await act(async () => {
        f.provider.release('write');
        await tick();
      });
      assert.equal(f.issue().status.name, 'In Progress');
      assert.deepEqual(f.errors, []);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of prior)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
  });
