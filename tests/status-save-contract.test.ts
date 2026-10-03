import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
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
async function fixture() {
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
    (next) => (view = next),
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
    useRef: () => ({ current: null }),
    useLayoutEffect: () => {},
    cx: (...names: unknown[]) => names.filter(Boolean).join(' '),
    PickerFeedback: () => null,
  };
  const status = run(`(${declaration(app, 'StatusEditor')})`, hooks);
  const cell = run(`(${declaration(app, 'FieldCell')})`, hooks);
  let flight: Promise<void> | undefined;
  const render = () => {
    const active = editor?.field === 'status';
    return cell({
      active,
      label: 'Edit status for CAN-111',
      onEdit: () => {},
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
