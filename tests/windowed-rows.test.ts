import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React, { act } from 'react';
import { TreeRows } from '../src/renderer/App';
import { SavedViewsPanel } from '../src/renderer/SavedViewsPanel';
import {
  WindowedRows,
  type RowWindow,
  type RowModelElement,
} from '../src/renderer/WindowedRows';
import {
  buildIssueTree,
  ancestorPath,
  treeCounts,
  filterTree,
  visibleRows,
  flattenVisible,
} from '../src/renderer/tree';
import { readingStyle } from '../src/renderer/table-view';
import { viewResults } from '../src/renderer/saved-views';
import type { Issue, SavedIssueView } from '../src/shared/types';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const noop = () => {};
const issue = (i: number, parentKey = 'R-0'): Issue => ({
  id: String(i),
  key: `R-${i}`,
  parentKey: i ? parentKey : undefined,
  summary: `Region ${i}`,
  type: 'Task',
  status: { id: 'open', name: 'Open', category: 'new' },
  assignee: null,
  priority: null,
  links: [],
});

// ReactDOM/events/focus are real; only geometry and ResizeObserver delivery are
// synthetic. This is a portable source control, never native paint/AT evidence.
async function dom() {
  const value = new JSDOM(
    '<!doctype html><html><body><div class="tree-scroll" id="host"></div></body></html>',
    { pretendToBeVisual: true },
  );
  const window = value.window;
  const host = window.document.querySelector('#host') as HTMLElement;
  let height = 30,
    width = 800,
    viewport = 300;
  const custom = new Map<string, number>();
  const observers = new Set<() => void>();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, input] of Object.entries({
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
        observers.add(callback);
      }
      observe() {}
      disconnect() {
        observers.delete(this.callback);
      }
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  })) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value: input,
      configurable: true,
      writable: true,
    });
  }
  Object.defineProperties(host, {
    clientHeight: { get: () => viewport },
    clientWidth: { get: () => width },
  });
  const rowHeight = (element: HTMLElement): number => {
    if (element.hasAttribute('data-window-spacer'))
      return parseFloat(element.style.height) || 0;
    if (element.hasAttribute('data-window-row'))
      return custom.get(element.dataset.windowRow!) ?? height;
    return 0;
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    let top = 0;
    if (
      this.hasAttribute('data-window-row') ||
      this.hasAttribute('data-window-spacer')
    ) {
      for (
        let sibling = this.previousElementSibling;
        sibling;
        sibling = sibling.previousElementSibling
      )
        top += rowHeight(sibling as HTMLElement);
    }
    const size = this === host ? viewport : rowHeight(this);
    const origin = this === host ? 0 : -host.scrollTop;
    return {
      top: top + origin,
      bottom: top + origin + size,
      left: 0,
      right: width,
      width,
      height: size,
      x: 0,
      y: top + origin,
      toJSON() {
        return this;
      },
    };
  };
  window.HTMLElement.prototype.scrollIntoView = function () {
    const row = this.closest('[data-window-row]') as HTMLElement | null;
    if (row) host.scrollTop += row.getBoundingClientRect().top;
  };
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  const flush = async () => {
    await act(async () => {
      for (let i = 0; frames.size && i < 20; i++) {
        const current = [...frames.values()];
        frames.clear();
        current.forEach((callback) => callback(performance.now()));
        await Promise.resolve();
      }
    });
    assert.equal(frames.size, 0, 'finite observer/frame work');
  };
  const render = async (element: React.ReactNode) => {
    await act(async () => root.render(element));
    await flush();
  };
  return {
    host,
    window,
    custom,
    render,
    flush,
    scroll: async (top: number) => {
      host.scrollTop = top;
      await act(async () => host.dispatchEvent(new window.Event('scroll')));
      await flush();
    },
    resize: async (
      rowHeight: number,
      nextWidth = width,
      nextViewport = viewport,
    ) => {
      height = rowHeight;
      width = nextWidth;
      viewport = nextViewport;
      await act(async () => observers.forEach((callback) => callback()));
      await flush();
    },
    key: async (element: HTMLElement, key: string, shiftKey = false) => {
      await act(async () =>
        element.dispatchEvent(
          new window.KeyboardEvent('keydown', {
            key,
            shiftKey,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      await flush();
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      assert.equal(observers.size, 0);
      assert.equal(frames.size, 0);
      window.close();
      for (const [name, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
function model(host: HTMLElement) {
  const element = host.querySelector<RowModelElement>('[data-row-window]');
  assert.ok(element?.logicalRows, 'real committed renderer member set');
  return element.logicalRows();
}
function treeProps(issues: Issue[]): React.ComponentProps<typeof TreeRows> {
  const node = buildIssueTree(issues, 'R-0')!;
  return {
    provider: 'jira',
    node,
    columns: ['issue', 'priority', 'assignee', 'status'],
    rankableKeys: new Set(issues.slice(1).map((i) => i.key)),
    rankingEnabled: true,
    statusColors: new Map(),
    depth: 0,
    expanded: new Set(['R-0']),
    expansionLocked: false,
    linkedExpanded: new Set(),
    onToggleLinks: noop,
    counts: treeCounts(node),
    seenIssues: {},
    confirmedIssues: new Map(issues.map((i) => [i.key, i])),
    onToggle: noop,
    selectedKey: 'R-0',
    selectedKeys: new Set(),
    suppressFocus: { current: false },
    onSelect: noop,
    onMultiSelect: noop,
    onOpenTab: noop,
    onOpenExternal: noop,
    onOpenWorkflow: noop,
    onCopyLink: noop,
    onPreview: noop,
    onContextMenu: noop,
    editor: null,
    beginEdit: noop,
    cancelEdit: noop,
    changeAssigneeQuery: noop,
    options: {},
    loadOptions: async () => {},
    updateIssue: async () => {},
    statusPaths: () => ({ routes: [], truncated: false }),
    transitionPath: async () => {},
    advanceEdit: noop,
    saving: new Set(),
    dragKey: null,
    setDragKey: noop,
    rankBefore: async () => {},
    keyboardRank: noop,
    focusNeighbor: noop,
  };
}

test('actual TreeRows mounts a bounded measured viewport and materializes complete keyboard destinations and selection', async () => {
  const state = await dom();
  try {
    const issues = Array.from({ length: 2001 }, (_, i) => issue(i));
    const props = treeProps(issues);
    let selected = '',
      range = '';
    props.onSelect = (key) => {
      selected = key;
    };
    props.onMultiSelect = (key) => {
      range = key;
    };
    await state.render(React.createElement(TreeRows, props));
    assert.ok(state.host.querySelectorAll('[data-tree-key]').length < 100);
    assert.deepEqual(
      model(state.host),
      issues.map((i) => i.key),
    );
    const first = state.host.querySelector<HTMLElement>(
      '[data-tree-key="R-0"]',
    )!;
    await act(async () => first.focus());
    await state.key(first, 'End');
    assert.equal(
      state.window.document.activeElement?.getAttribute('data-tree-key'),
      'R-2000',
    );
    assert.equal(selected, 'R-2000');
    assert.ok(state.host.scrollTop > 50_000);
    assert.equal(
      state.host
        .querySelector('[data-tree-key="R-2000"]')
        ?.getAttribute('aria-setsize'),
      '2000',
    );
    assert.equal(
      state.host
        .querySelector('[data-tree-key="R-2000"]')
        ?.getAttribute('aria-posinset'),
      '2000',
    );
    await state.key(state.window.document.activeElement, 'ArrowUp', true);
    assert.equal(range, 'R-1999');
    await state.key(state.window.document.activeElement, 'ArrowLeft');
    assert.equal(
      state.window.document.activeElement?.getAttribute('data-tree-key'),
      'R-0',
    );
    await state.key(state.window.document.activeElement, 'ArrowRight');
    assert.equal(
      state.window.document.activeElement?.getAttribute('data-tree-key'),
      'R-1',
    );
    await state.key(state.window.document.activeElement, 'Home');
    assert.equal(
      state.window.document.activeElement?.getAttribute('data-tree-key'),
      'R-0',
    );
    await state.scroll(30_000);
    assert.ok(state.host.querySelector('[data-tree-key="R-1000"]'));
    assert.equal(model(state.host).length, 2001);
    assert.ok(state.host.querySelectorAll('[data-tree-key]').length < 100);
    assert.ok(
      state.host.querySelector('[data-window-spacer][aria-hidden="true"]'),
    );
  } finally {
    await state.cleanup();
  }
});

test('real row focus, editor draft, menu and rank drag owners survive viewport recycling and scoped aliases', async () => {
  const state = await dom();
  try {
    const props = treeProps(Array.from({ length: 1001 }, (_, i) => issue(i)));
    props.editor = { connectionId: 'work', key: 'R-1', field: 'summary' };
    props.menuKey = 'R-2';
    props.dragKey = 'R-3';
    let dropped: string[] = [];
    props.rankBefore = async (key, before) => {
      dropped = [key, before];
    };
    await state.render(
      React.createElement(TreeRows, { ...props, key: 'work:a' }),
    );
    const input = state.host.querySelector<HTMLInputElement>(
      '[data-tree-key="R-1"] input',
    )!;
    assert.ok(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        state.window.HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'Unsaved local draft');
      input.dispatchEvent(new state.window.Event('input', { bubbles: true }));
    });
    await act(async () => input.focus());
    await state.scroll(20_000);
    assert.equal(
      state.host.querySelector('[data-tree-key="R-1"] input'),
      input,
    );
    assert.equal(input.value, 'Unsaved local draft');
    assert.equal(state.window.document.activeElement, input);
    assert.ok(state.host.querySelector('[data-tree-key="R-2"]'));
    assert.ok(state.host.querySelector('[data-tree-key="R-3"]'));
    const target = state.host.querySelector<HTMLElement>(
      '[data-tree-key="R-666"] > .issue-row',
    )!;
    assert.ok(target);
    await act(async () =>
      target.dispatchEvent(
        new state.window.Event('drop', { bubbles: true, cancelable: true }),
      ),
    );
    assert.deepEqual(dropped, ['R-3', 'R-666']);
    props.expanded = new Set();
    await state.render(
      React.createElement(TreeRows, { ...props, key: 'work:a' }),
    );
    assert.equal(
      state.host.querySelector('[data-tree-key="R-1"] input'),
      input,
      'collapse retains the active editor ancestry',
    );
    props.editor = null;
    props.menuKey = undefined;
    props.dragKey = null;
    await state.render(
      React.createElement(TreeRows, { ...props, key: 'other:b' }),
    );
    assert.equal(
      state.host.querySelector('input'),
      null,
      'foreign alias cannot inherit a local draft',
    );
    assert.equal(model(state.host).length, 1);
  } finally {
    await state.cleanup();
  }
});

test('variable real row measurements, viewport resize and reading settings update gaps without losing member identity', async () => {
  const state = await dom();
  try {
    const ids = Array.from({ length: 1000 }, (_, i) => `v${i}`);
    const api = { current: null as RowWindow | null };
    state.custom.set('v1', 90);
    await state.render(
      React.createElement(WindowedRows, {
        ids,
        api,
        scrollSelector: '.tree-scroll',
        renderRow: (i) => React.createElement('button', null, ids[i]),
      }),
    );
    const reveal = (id: string) =>
      act(async () => {
        api.current!.ensure(id)?.querySelector('button')?.focus();
      });
    await reveal('v500');
    await state.flush();
    assert.equal(state.window.document.activeElement?.textContent, 'v500');
    assert.equal(state.host.scrollTop, 500 * 30 + 60 - 300 + 30);
    const before = state.window.document.activeElement;
    const settings = readingStyle({
      textSize: 'large',
      spacing: 'comfortable',
    });
    for (const [key, value] of Object.entries(settings))
      state.host.style.setProperty(key, value);
    await state.resize(40, 400, 500);
    assert.equal(state.window.document.activeElement, before);
    assert.equal(model(state.host).length, 1000);
    await reveal('v999');
    await state.flush();
    assert.equal(state.window.document.activeElement?.textContent, 'v999');
    assert.ok(state.host.scrollTop > 35_000);
    assert.ok(state.host.querySelectorAll('[data-window-row]').length < 100);
    state.custom.set('v999', 120);
    await state.resize(40);
    assert.equal(state.window.document.activeElement?.textContent, 'v999');
  } finally {
    await state.cleanup();
  }
});

test('SavedViewsPanel windows actual deduplicated result models, full ARIA positions, keyboard, refresh and source identity', async () => {
  const state = await dom();
  state.host.className = 'saved-view-page';
  try {
    const snapshots = {
      a: {
        rootKey: 'R-0',
        issues: Array.from({ length: 1001 }, (_, i) => issue(i)),
        fetchedAt: 1,
        warnings: [],
      },
    };
    const sources = [
      { id: 'a', connectionId: 'work', rootKey: 'R-0' },
      { id: 'b', connectionId: 'work', rootKey: 'R-0' },
    ];
    const view: SavedIssueView = {
      id: 'large',
      name: 'Large roots',
      roots: sources,
      connectionIds: [],
      filters: { assignee: 'any', statuses: [], priority: '', hideDone: true },
      sort: { column: 'key', direction: 'asc' },
    };
    const results = viewResults(
      view,
      sources,
      { ...snapshots, b: snapshots.a },
      {},
    );
    let selected = '',
      opened = '',
      refreshed = 0;
    const props: React.ComponentProps<typeof SavedViewsPanel> = {
      view,
      connections: [
        {
          id: 'work',
          provider: 'jira',
          name: 'Work',
          url: 'https://fixture.invalid',
        },
      ],
      availableRoots: sources,
      sources,
      results,
      selected: null,
      errors: {},
      identityErrors: {},
      loading: new Set(),
      onSelect: (id) => {
        selected = id;
      },
      onOpen: (r) => {
        opened = r.issue.key;
      },
      onChange: noop,
      onDelete: noop,
      onRefresh: () => {
        refreshed++;
      },
    };
    await state.render(React.createElement(SavedViewsPanel, props));
    assert.ok(state.host.querySelectorAll('.saved-view-result').length < 100);
    assert.equal(model(state.host).length, 1001);
    const first = state.host.querySelector<HTMLElement>('.saved-view-choice')!;
    await act(async () => first.focus());
    await state.key(first, 'End');
    assert.equal(selected, JSON.stringify(['work', '1000']));
    const last =
      state.window.document.activeElement.closest('.saved-view-result');
    assert.equal(last.getAttribute('aria-setsize'), '1001');
    assert.equal(last.getAttribute('aria-posinset'), '1001');
    await act(async () => last.querySelector('.saved-view-open').click());
    assert.equal(opened, 'R-1000');
    await state.key(state.window.document.activeElement, 'Home');
    assert.equal(selected, JSON.stringify(['work', '0']));
    const refresh = [...state.host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Refresh',
    )!;
    await act(async () => refresh.click());
    assert.equal(refreshed, 1);
    results.splice(500);
    await state.render(
      React.createElement(SavedViewsPanel, { ...props, results: [...results] }),
    );
    assert.equal(model(state.host).length, 500);
  } finally {
    await state.cleanup();
  }
});

test('actual filtered rich rows retain hidden-Done semantics, linked controls and small-tree presentation', async () => {
  const state = await dom();
  try {
    const issues = Array.from({ length: 1001 }, (_, i) => ({
      ...issue(i),
      status:
        i && i % 2 === 0
          ? { id: 'done', name: 'Done', category: 'done' as const }
          : issue(i).status,
    }));
    issues[1].links = [
      {
        key: 'OTHER-1',
        summary: 'Visible dependency',
        relationship: 'relates to',
        direction: 'outward',
        statusCategory: 'new',
      },
    ];
    const props = treeProps(issues);
    props.node = filterTree(props.node, '', {}, true)!;
    props.linkedExpanded = new Set(['R-1']);
    let opened = '';
    props.onOpenTab = (key) => {
      opened = key;
    };
    state.custom.set('R-1', 100);
    await state.render(React.createElement(TreeRows, props));
    assert.deepEqual(
      model(state.host),
      visibleRows(props.node, props.expanded).map((row) => row.node.issue.key),
    );
    assert.equal(model(state.host).length, 501);
    assert.equal(state.host.querySelector('[data-tree-key="R-2"]'), null);
    const link = state.host.querySelector<HTMLElement>(
      '[data-tree-key="R-1"] .open-linked',
    )!;
    assert.ok(link);
    await act(async () => link.click());
    assert.equal(opened, 'OTHER-1');
    await state.scroll(10_000);
    await state.scroll(0);
    assert.ok(
      state.host.querySelector('[data-tree-key="R-1"] .open-linked'),
      'linked expansion survives recycled rows',
    );
    props.node = filterTree(
      buildIssueTree(issues, 'R-0'),
      'Region 999',
      {},
      true,
    )!;
    await state.render(React.createElement(TreeRows, props));
    assert.deepEqual(model(state.host), ['R-0', 'R-999']);
    assert.equal(state.host.querySelectorAll('[data-tree-key]').length, 2);
    assert.equal(
      state.host
        .querySelector('[data-row-window]')
        ?.getAttribute('data-row-window'),
      'all',
    );
  } finally {
    await state.cleanup();
  }
});

test('actual App editor prop and effective expansion preserve the owning alias and exclude foreign accounts', () => {
  const text = readFileSync(
    new URL('../src/renderer/App.tsx', import.meta.url),
    'utf8',
  );
  const ast = ts.createSourceFile(
    'App.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let editorExpression: string | undefined, expansion: string | undefined;
  const walk = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(ast) === 'TreeRows'
    ) {
      const attribute = node.attributes.properties.find(
        (prop) =>
          ts.isJsxAttribute(prop) && prop.name.getText(ast) === 'editor',
      ) as ts.JsxAttribute;
      editorExpression = (
        attribute.initializer as ts.JsxExpression
      ).expression!.getText(ast);
    }
    if (
      ts.isIfStatement(node) &&
      node.getText(ast).includes('ancestorPath(shownTree, editor.key)')
    )
      expansion = node.getText(ast);
    ts.forEachChild(node, walk);
  };
  walk(ast);
  assert.ok(editorExpression);
  assert.ok(expansion);
  const editor = { connectionId: 'work', key: 'R-500', field: 'summary' };
  const evaluate = (connectionId: string) =>
    vm.runInNewContext(`(${editorExpression})`, {
      editor,
      activeTab: { connectionId },
    });
  assert.equal(evaluate('work'), editor);
  assert.equal(evaluate('other'), null);
  const node = buildIssueTree(
    Array.from({ length: 1001 }, (_, i) => issue(i)),
    'R-0',
  )!;
  const expandedSet = new Set<string>();
  // Use the actual production ancestry helper, not a mirrored path algorithm.

  vm.runInNewContext(expansion, {
    editor,
    activeTab: { connectionId: 'work' },
    expandedSet,
    shownTree: node,
    ancestorPath,
  });
  assert.ok(expandedSet.has('R-0'));
});

test('explicit offscreen alignment settles actual tall neighborhoods, supersedes requests and releases transient owners', async () => {
  for (const heights of [
    [491, 500, 120],
    [500, 500, 120],
    [500, 500, 600],
  ]) {
    const state = await dom();
    const api = { current: null as RowWindow | null };
    try {
      const ids = Array.from({ length: 1000 }, (_, i) => `v${i}`);
      for (let i = heights[0]; i <= heights[1]; i++)
        state.custom.set(`v${i}`, heights[2]);
      const render = (members: readonly string[], key = 'scope') =>
        React.createElement(WindowedRows, {
          key,
          ids: members,
          api,
          scrollSelector: '.tree-scroll',
          renderRow: (i) => React.createElement('button', null, members[i]),
        });
      await state.render(
        React.createElement(React.StrictMode, null, render(ids)),
      );
      await act(async () =>
        api
          .current!.ensure('v500')!
          .querySelector('button')!
          .focus({ preventScroll: true }),
      );
      await state.flush();
      const row = state.host.querySelector<HTMLElement>(
        '[data-window-row="v500"]',
      )!;
      const rect = row.getBoundingClientRect();
      assert.equal(state.window.document.activeElement?.textContent, 'v500');
      assert.ok(
        rect.top >= -1 && rect.top < state.host.clientHeight,
        'actual target starts in viewport',
      );
      if (rect.height <= state.host.clientHeight)
        assert.ok(
          rect.bottom <= state.host.clientHeight + 1,
          'entire fitting target visible',
        );
      else
        assert.ok(
          Math.abs(rect.top) <= 1 && rect.bottom > state.host.clientHeight,
          'oversized target exposes its start honestly',
        );
      await act(async () => api.current!.ensure('v500'));
      await state.flush();
      await act(async () => {
        api.current!.ensure('v700');
        api.current!.ensure('v900');
        state.window.document.activeElement?.blur();
      });
      await state.flush();
      assert.ok(
        state.host
          .querySelector('[data-window-row="v900"]')!
          .getBoundingClientRect().top < state.host.clientHeight,
      );
      await act(async () => api.current!.ensure('v900'));
      await state.flush();
      await state.scroll(0);
      assert.ok(
        !state.host.querySelector('[data-window-row="v900"]'),
        'satisfied un-focused destination releases its transient owner',
      );
      await act(async () => api.current!.ensure('v800'));
      await state.render(
        React.createElement(React.StrictMode, null, render(ids.slice(0, 400))),
      );
      assert.ok(
        !state.host.querySelector('[data-window-row="v800"]'),
        'filter removes obsolete request',
      );
      assert.equal(api.current!.ensure('v800'), null);
      await state.render(
        React.createElement(React.StrictMode, null, render(ids, 'other-scope')),
      );
      await state.scroll(0);
      assert.ok(
        !state.host.querySelector('[data-window-row="v800"]'),
        'new owner has no old requested pin',
      );
    } finally {
      await state.cleanup();
      assert.equal(api.current, null, 'teardown releases navigation owner');
    }
  }
});

test('exact preparer hierarchy projections match real filtered, ranked, subtree and show-Done row markup', async () => {
  const state = await dom();
  try {
    const text = readFileSync(
      new URL('../tools/prepare-perf-desktop.mjs', import.meta.url),
      'utf8',
    );
    const start =
      text.indexOf('const projection = ') + 'const projection = '.length;
    const end = text.indexOf(';\n          const keys', start);
    assert.ok(start > 0 && end > start);
    const issues = [
      issue(0),
      issue(1),
      issue(2),
      issue(3, 'R-1'),
      {
        ...issue(4, 'R-1'),
        status: { id: 'done', name: 'Done', category: 'done' as const },
      },
      issue(5, 'R-2'),
    ];
    const full = buildIssueTree(issues, 'R-0')!;
    // Ranking is reflected in actual child order, independent of issue keys.
    full.children.reverse();
    full.children.find((n) => n.issue.key === 'R-1')!.children.reverse();
    const expanded = new Set(issues.map((i) => i.key));
    for (const [tree, query, hideDone] of [
      [full, '', true],
      [full, 'Region 3', true],
      [full, '', false],
      [full.children.find((n) => n.issue.key === 'R-1')!, '', false],
    ] as const) {
      const project = new Function(
        'filterTree',
        'flattenVisible',
        'tree',
        `return (${text.slice(start, end)});`,
      )(
        // Exercise the identical production projection with real show-Done
        // settings; the shipped native fixture itself deliberately hides Done.
        (node: typeof full, q: string, filters: unknown) =>
          filterTree(node, q, filters as {}, hideDone),
        flattenVisible,
        tree,
      ) as (query: string, expanded: Set<string>) => unknown[][];
      const expected = project(query, expanded);
      const node = filterTree(tree, query, {}, hideDone)!;
      const props = { ...treeProps(issues), node, expanded };
      await state.render(React.createElement(TreeRows, props));
      assert.deepEqual(
        model(state.host),
        expected.map((r) => r[0]),
      );
      const rows = [
        ...state.host.querySelectorAll<HTMLElement>('[data-tree-key]'),
      ];
      assert.equal(rows.length, expected.length);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i],
          data = expected[i];
        assert.equal(row.getAttribute('role'), 'treeitem');
        assert.deepEqual(
          [
            row.dataset.treeKey,
            row.dataset.treeParent ?? null,
            Number(row.getAttribute('aria-level')),
            Number(row.getAttribute('aria-posinset')),
            Number(row.getAttribute('aria-setsize')),
          ],
          data,
        );
      }
    }
  } finally {
    await state.cleanup();
  }
});

test('first ensure and focused tall-band requests retain visible targets through estimate settlement without a short-row pin', async () => {
  for (const strict of [false, true])
    for (const align of ['nearest', 'center'] as const)
      for (const focused of [false, true])
        for (const clamp of [false, true]) {
          const state = await dom(),
            api = { current: null as RowWindow | null },
            ids = Array.from({ length: 1000 }, (_, i) => `v${i}`);
          try {
            for (let i = 480; i <= 515; i++) state.custom.set(`v${i}`, 150);
            if (clamp) {
              let offset = 0;
              const maximum = () =>
                Math.max(
                  0,
                  [
                    ...state.host.querySelectorAll<HTMLElement>(
                      '[data-window-row],[data-window-spacer]',
                    ),
                  ].reduce(
                    (sum, row) =>
                      sum +
                      (row.hasAttribute('data-window-spacer')
                        ? parseFloat(row.style.height) || 0
                        : (state.custom.get(row.dataset.windowRow!) ?? 30)),
                    0,
                  ) - 300,
                );
              Object.defineProperty(state.host, 'scrollTop', {
                get: () => (offset = Math.min(offset, maximum())),
                set: (value: number) =>
                  (offset = Math.min(Math.max(0, value), maximum())),
              });
            }
            const element = React.createElement(WindowedRows, {
              ids,
              api,
              pinned: focused ? ['v500'] : [],
              scrollSelector: '.tree-scroll',
              renderRow: (i) => React.createElement('button', null, ids[i]),
            });
            await state.render(
              strict
                ? React.createElement(React.StrictMode, null, element)
                : element,
            );
            if (focused) {
              await act(async () =>
                state.host
                  .querySelector<HTMLElement>(
                    '[data-window-row="v500"] button',
                  )!
                  .focus({ preventScroll: true }),
              );
              await state.flush();
            }
            await act(async () => {
              const destination = api.current!.ensure('v500', align);
              assert.ok(
                destination,
                'first ensure retains its requested owner',
              );
              assert.ok(
                destination instanceof state.window.HTMLElement,
                'first ensure returns the actual owning element before focus',
              );
              destination
                .querySelector<HTMLElement>('button')!
                .focus({ preventScroll: true });
            });
            await state.flush();
            const target = state.host.querySelector<HTMLElement>(
              '[data-window-row="v500"]',
            )!;
            assert.equal(
              state.window.document.activeElement?.textContent,
              'v500',
            );
            assert.ok(
              target.getBoundingClientRect().top >= -1 &&
                target.getBoundingClientRect().bottom <= 301,
              'first fitting target stays visible after all committed estimate/offset work',
            );
            assert.equal(model(state.host).length, 1000);
            assert.ok(
              !state.host.querySelector('[data-window-row="v0"]'),
              'no artificial short DOM owner',
            );
            if (!focused) {
              await act(async () =>
                state.window.document.activeElement?.blur(),
              );
              await state.scroll(0);
              assert.ok(
                !state.host.querySelector('[data-window-row="v500"]'),
                'settled transient destination releases',
              );
            }
          } finally {
            await state.cleanup();
          }
        }
});

test('queued uniform reading-height estimates commit before explicit alignment settles', async () => {
  for (const align of ['nearest', 'center'] as const) {
    const state = await dom(),
      api = { current: null as RowWindow | null },
      ids = Array.from({ length: 1000 }, (_, i) => `v${i}`);
    try {
      await state.render(
        React.createElement(WindowedRows, {
          ids,
          api,
          scrollSelector: '.tree-scroll',
          renderRow: (i) => React.createElement('button', null, ids[i]),
        }),
      );
      await act(async () =>
        api
          .current!.ensure('v500', align)!
          .querySelector<HTMLElement>('button')!
          .focus({ preventScroll: true }),
      );
      // Width/signature invalidation removes every old short-row measurement.
      // The real observer then queues the new global estimate during this request.
      await state.resize(150, 700, 300);
      await state.flush();
      const rect = state.host
        .querySelector('[data-window-row="v500"]')!
        .getBoundingClientRect();
      assert.equal(state.window.document.activeElement?.textContent, 'v500');
      assert.ok(
        rect.top >= -1 && rect.bottom <= 301,
        'new committed estimate preserves requested visibility',
      );
      state.custom.set('v500', 600);
      await state.resize(150);
      const oversized = state.host
        .querySelector('[data-window-row="v500"]')!
        .getBoundingClientRect();
      await act(async () => api.current!.ensure('v500', align));
      await state.flush();
      assert.equal(oversized.height, 600);
      assert.ok(
        Math.abs(
          state.host
            .querySelector('[data-window-row="v500"]')!
            .getBoundingClientRect().top,
        ) <= 1,
        'oversized destination exposes its start',
      );
    } finally {
      await state.cleanup();
    }
  }
});

test('changing geometry respects eight measurements during and after synchronous acquisition and resumes on real inputs', async () => {
  for (const strict of [false, true])
    for (const align of ['nearest', 'center'] as const)
      for (const timing of ['acquisition', 'after'])
        for (const signature of [false, true]) {
          const state = await dom(),
            api = { current: null as RowWindow | null },
            ids = Array.from({ length: 1000 }, (_, i) => `v${i}`);
          const computed = globalThis.getComputedStyle;
          let changing = false,
            measurements = 0;
          globalThis.getComputedStyle = (element) => {
            const style = computed(element);
            if (!changing) return style;
            measurements++;
            for (const id of ids)
              state.custom.set(id, measurements % 2 ? 150 : 30);
            if (!signature) return style;
            return new Proxy(style, {
              get: (target, key) => {
                if (key === 'fontSize')
                  return measurements % 2 ? '15px' : '16px';
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
          };
          const make = (members: readonly string[], key = 'scope') => {
            const rows = React.createElement(WindowedRows, {
              key,
              ids: members,
              api,
              scrollSelector: '.tree-scroll',
              renderRow: (i) => React.createElement('button', null, members[i]),
            });
            return strict
              ? React.createElement(React.StrictMode, null, rows)
              : rows;
          };
          try {
            await state.render(make(ids));
            if (timing === 'acquisition') changing = true;
            await act(async () => {
              const row = api.current!.ensure('v500', align);
              assert.ok(
                row,
                'changing measurements must still return the actual destination synchronously',
              );
              assert.ok(row instanceof state.window.HTMLElement);
              assert.ok(
                measurements <= 8,
                'synchronous acquisition enforces existing bound',
              );
              row
                .querySelector<HTMLElement>('button')!
                .focus({ preventScroll: true });
            });
            if (timing === 'after') changing = true;
            await state.flush();
            assert.ok(
              measurements <= 8,
              'internal acquisition/settlement/passive chain stays bounded',
            );
            assert.equal(
              state.window.document.activeElement?.textContent,
              'v500',
            );
            assert.equal(model(state.host).length, 1000);
            const observed = measurements;
            await state.flush();
            assert.equal(
              measurements,
              observed,
              'no unsolicited measurement or pending-layout RAF polling',
            );
            await act(async () =>
              state.host.dispatchEvent(new state.window.Event('scroll')),
            );
            await state.flush();
            assert.equal(
              measurements,
              observed,
              'delivery of our own unchanged scroll correction cannot restart exhausted work',
            );
            // A real observer input starts new bounded work after the geometry settles.
            changing = false;
            state.custom.clear();
            await state.resize(30, 701, 300);
            await act(async () => {
              api
                .current!.ensure('v600', align)!
                .querySelector<HTMLElement>('button')!
                .focus({ preventScroll: true });
            });
            await state.flush();
            let rect = state.host
              .querySelector('[data-window-row="v600"]')!
              .getBoundingClientRect();
            assert.ok(
              rect.top >= -1 && rect.bottom <= 301,
              'settled geometry restores visible navigation',
            );
            await act(async () => {
              api.current!.ensure('v700');
              api.current!.ensure('v900');
              state.window.document.activeElement?.blur();
            });
            await state.flush();
            await state.scroll(0);
            assert.ok(
              !state.host.querySelector('[data-window-row="v900"]'),
              'bounded owner still releases',
            );
            await state.render(make(ids.filter((id) => id !== 'v900')));
            assert.equal(api.current!.ensure('v900'), null);
            await state.render(make(ids, 'new-scope'));
            await state.scroll(0);
            assert.ok(!state.host.querySelector('[data-window-row="v900"]'));
          } finally {
            globalThis.getComputedStyle = computed;
            await state.cleanup();
            assert.equal(api.current, null);
          }
        }
});
