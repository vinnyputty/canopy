import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React, { act } from 'react';
import ts from 'typescript';
import { reorderTab } from '../src/renderer/workspace';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const source = readFileSync(
  process.env.CANOPY_NAVIGATION_SOURCE ?? 'src/renderer/App.tsx',
  'utf8',
);
const ast = ts.createSourceFile(
  'App.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function find(predicate: (node: ts.Node) => boolean) {
  let result: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (predicate(node)) result = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(result, 'Production navigation not found');
  return result;
}
const hasClass = (node: ts.Node, name: string) =>
  ts.isJsxElement(node) &&
  node.openingElement.attributes.properties.some(
    (p) =>
      ts.isJsxAttribute(p) &&
      p.name.getText(ast) === 'className' &&
      p.initializer?.getText(ast) === JSON.stringify(name),
  );
const tabs = find((n) => hasClass(n, 'tabstrip'));
const filters = find((n) => hasClass(n, 'tree-filter-state'));
let filterScope: ts.Node = filters;
while (!ts.isJsxExpression(filterScope)) filterScope = filterScope.parent;
const filterExpression = filterScope;
let treeScope: ts.Node = filters;
while (
  treeScope.parent &&
  !(
    ts.isBinaryExpression(treeScope) &&
    treeScope.left.getText(ast) === 'activeTab && !activeSavedView'
  )
)
  treeScope = treeScope.parent;
assert.ok(ts.isBinaryExpression(treeScope));
const tabOrder = find(
  (n) => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'tabOrder',
);
const effect = find(
  (n) =>
    ts.isCallExpression(n) &&
    n.expression.getText(ast) === 'useEffect' &&
    n.arguments[0]?.getText(ast).includes("'.top-tab.active'") === true,
);

// Mount the production JSX and effect, retaining App's callbacks and display guards.
const fixtureCode = ts.transpileModule(
  `function Fixture() { const ${tabOrder.getText(ast)}; ${effect.getText(ast)}; return <>{${tabs.getText(ast)}}{${treeScope.left.getText(ast)} && (${filterExpression.expression!.getText(ast)})}</>; }`,
  {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  },
).outputText;

test('tabs reveal the active connection without vertical scrolling; views and inbox suspend tree navigation and reset', async () => {
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true });
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const host = dom.window.document.querySelector('#host')! as HTMLElement;
  const root = createRoot(host);
  const icon = () => null;
  const scope: any = {
    useEffect: React.useEffect,
    workspace: {
      tabs: ['one', 'two', 'three'].map((id) => ({
        id,
        rootKey: 'A-1',
        connectionId: id,
        summary: `Issue ${id}`,
        hideDone: true,
        filters: { assignee: 'me' },
        expanded: ['A-1', 'A-2'],
        scrollTop: 220,
      })),
      activeTabId: 'one',
    },
    connections: ['one', 'two', 'three'].map((id) => ({
      id,
      name: `Team ${id}`,
    })),
    activeSavedView: null,
    refreshing: new Set(),
    draggedTab: { current: null },
    queries: { one: 'first', two: 'second', three: 'third' },
    filtering: true,
    activeConnection: { provider: 'jira' },
    searchRef: { current: null },
    cx: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
    Menu: icon,
    CircleDot: icon,
    Loader2: icon,
    X: icon,
    Plus: icon,
    reorderTab,
    setTabMenu() {},
    setDialog() {},
    closeTab() {},
    setWorkspace(update: any) {
      scope.workspace = update(scope.workspace);
      scope.activeTab = scope.workspace.tabs.find(
        (t: any) => t.id === scope.workspace.activeTabId,
      );
    },
    selectTab(id: string) {
      scope.setWorkspace((w: any) => ({ ...w, activeTabId: id }));
      scope.activeSavedView = null;
    },
    selectRelativeTab(direction: number) {
      const index = scope.workspace.tabs.findIndex(
        (t: any) => t.id === scope.workspace.activeTabId,
      );
      scope.selectTab(scope.workspace.tabs[(index + direction + 3) % 3].id);
    },
    setQueries(update: any) {
      scope.queries = update(scope.queries);
    },
    updateTab(id: string, patch: any) {
      scope.setWorkspace((w: any) => ({
        ...w,
        tabs: w.tabs.map((t: any) => (t.id === id ? { ...t, ...patch } : t)),
      }));
      scope.filtering = false;
    },
  };
  scope.activeTab = scope.workspace.tabs[0];
  const Fixture = new Function(
    'React',
    'scope',
    `with (scope) { ${fixtureCode}; return Fixture; }`,
  )(React, scope);
  const render = () =>
    act(async () => root.render(React.createElement(Fixture)));
  const click = async (element: HTMLElement) =>
    act(async () => {
      element.click();
    });
  try {
    await render();
    const strip = host.querySelector<HTMLElement>('.tabstrip-scroll')!;
    strip.scrollTop = 77;
    Object.defineProperty(strip, 'clientWidth', { value: 200 });
    Object.defineProperty(strip, 'offsetLeft', { value: 78 });
    for (const [index, tab] of [
      ...strip.querySelectorAll<HTMLElement>('[role="tab"]'),
    ].entries()) {
      Object.defineProperty(tab, 'offsetLeft', { value: index * 190 });
      Object.defineProperty(tab, 'offsetWidth', { value: 190 });
    }
    assert.deepEqual(
      [...host.querySelectorAll('.tab-label b')].map((n) => n.textContent),
      ['A-1', 'A-1', 'A-1'],
    );
    assert.deepEqual(
      [...host.querySelectorAll('.tab-connection')].map((n) => n.textContent),
      ['Team one', 'Team two', 'Team three'],
    );
    await click(host.querySelector<HTMLElement>('[data-tab-id="three"]')!);
    await render();
    assert.equal(scope.workspace.activeTabId, 'three');
    assert.equal(strip.scrollLeft, 370);
    assert.equal(strip.scrollTop, 77);
    strip.scrollLeft = 90;
    scope.workspace = {
      ...scope.workspace,
      tabs: scope.workspace.tabs.map((tab: any) => ({
        ...tab,
        summary: 'Refreshed title',
      })),
    };
    await render();
    assert.equal(
      strip.scrollLeft,
      90,
      'background content updates preserve manual tab scrolling',
    );
    await act(async () =>
      host.querySelector<HTMLElement>('[data-tab-id="three"]')!.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true,
        }),
      ),
    );
    await render();
    assert.equal(scope.workspace.activeTabId, 'one');
    assert.equal(strip.scrollLeft, 0);
    assert.equal(
      dom.window.document.activeElement?.getAttribute('data-tab-id'),
      'one',
    );
    scope.selectTab('two');
    strip.scrollLeft = 190;
    await render();
    assert.equal(
      strip.scrollLeft,
      190,
      'fully visible tab preserves horizontal position',
    );
    await act(async () =>
      host.querySelector<HTMLElement>('[data-tab-id="two"]')!.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', {
          key: 'ArrowLeft',
          altKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      ),
    );
    await render();
    assert.deepEqual(
      scope.workspace.tabs.map((tab: any) => tab.id),
      ['two', 'one', 'three'],
    );
    scope.selectTab('one');
    await render();
    const search = dom.window.document.createElement('input');
    host.append(search);
    scope.searchRef.current = search;
    const reset = [...host.querySelectorAll<HTMLElement>('button')].find(
      (n) => n.textContent?.trim() === 'Reset filters',
    )!;
    reset.focus();
    await click(reset);
    await render();
    assert.equal(scope.queries.one, '');
    assert.equal(scope.queries.two, 'second');
    assert.deepEqual(scope.activeTab.filters, {});
    assert.equal(scope.activeTab.hideDone, false);
    assert.deepEqual(scope.activeTab.expanded, ['A-1', 'A-2']);
    assert.equal(scope.activeTab.scrollTop, 220);
    assert.equal(
      scope.workspace.tabs.find((tab: any) => tab.id === 'two').hideDone,
      true,
    );
    assert.ok(
      dom.window.document.activeElement === search,
      'reset returns focus to search',
    );
    assert.ok(!host.querySelector('.tree-filter-state'), 'filter state hidden');
    scope.activeTab.hideDone = true;
    scope.activeConnection.provider = 'github';
    scope.searchRef.current = null;
    await render();
    assert.match(
      host.querySelector('.tree-filter-state')!.textContent!,
      /Closed issues hidden/,
    );
    await click(host.querySelector<HTMLElement>('.tree-filter-state button')!);
    await render();
    assert.equal(scope.activeTab.hideDone, false);
    for (const view of [{ id: 'saved' }, { id: 'triage-inbox' }]) {
      strip.scrollLeft = 123;
      scope.activeSavedView = view;
      scope.filtering = true;
      await render();
      assert.equal(
        host.querySelector('[role="tab"][aria-selected="true"]'),
        null,
      );
      assert.ok(
        !host.querySelector('.tree-filter-state'),
        'filter state hidden',
      );
      assert.equal(strip.scrollLeft, 123);
    }
    scope.activeSavedView = null;
    scope.activeTab = null;
    scope.workspace = { ...scope.workspace, tabs: [], activeTabId: null };
    await render();
    assert.equal(host.querySelector('[role="tab"]'), null);
    assert.ok(!host.querySelector('.tree-filter-state'), 'filter state hidden');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
