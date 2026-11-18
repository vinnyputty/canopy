import { WorkspaceClose } from '../src/renderer/workspace-close';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';
import { callback, execute, findNode, sourceFile } from './source-probe';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const app = sourceFile(new URL('../src/renderer/App.tsx', import.meta.url));
const jsxCallback = (label: string, property: string, text = false) => {
  const element = findNode(
    app,
    (node): node is ts.JsxElement | ts.JsxSelfClosingElement =>
      (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) &&
      (text
        ? ts.isJsxElement(node) &&
          node.children.some(
            (child) => ts.isJsxText(child) && child.text.trim() === label,
          )
        : (ts.isJsxElement(node)
            ? node.openingElement.attributes
            : node.attributes
          ).properties.some(
            (attribute) =>
              ts.isJsxAttribute(attribute) &&
              attribute.name.getText() === 'aria-label' &&
              attribute.initializer?.getText() === JSON.stringify(label),
          )),
  );
  const attribute = (
    ts.isJsxElement(element)
      ? element.openingElement.attributes
      : element.attributes
  ).properties.find(
    (node) => ts.isJsxAttribute(node) && node.name.getText() === property,
  ) as ts.JsxAttribute;
  return (attribute.initializer as ts.JsxExpression).expression!.getText();
};

function fixture() {
  const dom = new JSDOM(
    '<button id="undo">Undo</button><div tabindex="0" data-tree-key="CAN-101"></div><button id="refresh">Refresh</button><input id="other">',
  );
  const document = dom.window.document as Document;
  const frames: FrameRequestCallback[] = [];
  const scope = {
    workspaceClose: { current: new WorkspaceClose() },
    document,
    useCallback: (run: unknown) => run,
    requestAnimationFrame: (run: FrameRequestCallback) => frames.push(run),
    activeTab: {
      id: 'source',
      connectionId: 'work',
      rootKey: 'CAN-100',
      selectedKey: 'CAN-101',
    } as {
      id: string;
      connectionId: string;
      rootKey: string;
      selectedKey: string;
    } | null,
    workspaceRef: {
      current: {
        activeTabId: 'source',
        activeSavedViewId: null as string | null,
      },
    },
    undoState: { busy: false },
    dialog: null as string | null,
    childParent: null as object | null,
    workBrief: null as object | null,
    pendingTabFocus: {
      current: null as { tabId: string; origin: Element | null } | null,
    },
    undoFocusRequest: null as {
      trigger: HTMLButtonElement;
      tabId: string;
      key: string;
    } | null,
    setUndoFocusRequest: (
      _request: {
        trigger: HTMLButtonElement;
        tabId: string;
        key: string;
      } | null,
    ) => {},
    refreshButtonRef: {
      current: document.querySelector<HTMLButtonElement>('#refresh'),
    },
    restoreTreeFocus: (_key?: string) => false,
    mutations: { undo: async () => {} },
  };
  scope.restoreTreeFocus = execute(
    callback(app, 'restoreTreeFocus'),
    scope,
  ) as typeof scope.restoreTreeFocus;
  scope.setUndoFocusRequest = (request) => {
    scope.undoFocusRequest = request;
  };
  return {
    dom,
    document,
    scope,
    frames: () => {
      if (scope.undoFocusRequest)
        (execute(callback(app, 'restoreUndoFocus'), scope) as () => void)();
      frames.splice(0).forEach((run) => run(0));
    },
    pendingFrames: () =>
      frames.length + Number(Boolean(scope.undoFocusRequest)),
    close: () => dom.window.close(),
  };
}

for (const result of [
  'success',
  'error',
  'missing row',
  'no fallback',
  'retained button',
  'other control',
  'other tab',
  'saved view',
  'dialog',
  'child dialog',
  'work brief',
  'unowned',
  'busy',
  'no tab',
] as const)
  test(`Undo focus recovery respects ${result}`, async () => {
    const f = fixture();
    const trigger = f.document.querySelector<HTMLButtonElement>('#undo')!;
    let calls = 0;
    f.scope.mutations.undo = async () => {
      calls++;
      if (result === 'retained button') trigger.blur();
      else trigger.remove();
      if (result === 'error') throw new Error('undo failed');
    };
    trigger.focus();
    if (result === 'busy') f.scope.undoState.busy = true;
    if (result === 'no tab') f.scope.activeTab = null;
    if (result === 'unowned') trigger.blur();
    if (result === 'missing row' || result === 'no fallback')
      f.document.querySelector('[data-tree-key]')!.remove();
    if (result === 'no fallback') f.scope.refreshButtonRef.current = null;
    const undo = execute(callback(app, 'undoFromButton'), f.scope) as (
      trigger: HTMLButtonElement,
    ) => Promise<void>;
    try {
      if (result === 'error')
        await assert.rejects(undo(trigger), /undo failed/);
      else await undo(trigger);
      if (result === 'other control')
        f.document.querySelector<HTMLInputElement>('#other')!.focus();
      if (result === 'other tab')
        f.scope.workspaceRef.current.activeTabId = 'next';
      if (result === 'saved view')
        f.scope.workspaceRef.current.activeSavedViewId = 'view';
      if (result === 'dialog') f.scope.dialog = 'commands';
      if (result === 'child dialog') f.scope.childParent = {};
      if (result === 'work brief') f.scope.workBrief = {};
      const before = f.document.activeElement;
      f.frames();
      assert.equal(calls, result === 'busy' || result === 'no tab' ? 0 : 1);
      const expected =
        result === 'success' || result === 'error'
          ? f.document.querySelector('[data-tree-key]')
          : result === 'missing row'
            ? f.scope.refreshButtonRef.current
            : before;
      assert.equal(f.document.activeElement, expected);
      if (result === 'unowned') assert.equal(f.pendingFrames(), 0);
    } finally {
      f.close();
    }
  });

test('Undo retains its trigger until the operation settles', async () => {
  const f = fixture();
  const trigger = f.document.querySelector<HTMLButtonElement>('#undo')!;
  let finish!: () => void;
  f.scope.mutations.undo = () =>
    new Promise<void>((resolve) => {
      finish = () => {
        trigger.remove();
        resolve();
      };
    });
  const undo = execute(callback(app, 'undoFromButton'), f.scope) as (
    trigger: HTMLButtonElement,
  ) => Promise<void>;
  try {
    trigger.focus();
    const pending = undo(trigger);
    assert.equal(f.pendingFrames(), 0);
    assert.equal(f.document.activeElement, trigger);
    finish();
    await pending;
    f.frames();
    assert.equal(
      f.document.activeElement,
      f.document.querySelector('[data-tree-key]'),
    );
  } finally {
    f.close();
  }
});

test('processed Undo recovery cannot replay after a later focus loss', async () => {
  const f = fixture();
  const trigger = f.document.querySelector<HTMLButtonElement>('#undo')!;
  f.scope.mutations.undo = async () => {
    trigger.remove();
  };
  const undo = execute(callback(app, 'undoFromButton'), f.scope) as (
    trigger: HTMLButtonElement,
  ) => Promise<void>;
  try {
    trigger.focus();
    await undo(trigger);
    f.frames();
    (f.document.activeElement as HTMLElement).blur();
    f.frames();
    assert.equal(f.document.activeElement, f.document.body);
  } finally {
    f.close();
  }
});

test('an empty post-commit Undo request does not schedule an update or move focus', () => {
  const f = fixture();
  f.scope.setUndoFocusRequest = () => assert.fail('unexpected focus update');
  const restore = execute(
    callback(app, 'restoreUndoFocus'),
    f.scope,
  ) as () => void;
  try {
    f.scope.refreshButtonRef.current!.focus();
    restore();
    assert.equal(f.document.activeElement, f.scope.refreshButtonRef.current);
  } finally {
    f.close();
  }
});

for (const blocked of ['none', 'busy', 'cooldown'] as const)
  test(`Refresh rejects repeat activation during ${blocked}`, () => {
    const f = fixture();
    const calls: unknown[] = [];
    const refresh = execute(jsxCallback('Refresh', 'onClick'), {
      activeTab: f.scope.activeTab,
      refreshing: new Set(blocked === 'busy' ? ['source'] : []),
      cooldownTimes: blocked === 'cooldown' ? { work: 200 } : {},
      syncNow: 100,
      refreshTab: (...args: unknown[]) => calls.push(args),
    }) as () => void;
    try {
      refresh();
      assert.deepEqual(
        calls,
        blocked === 'none' ? [[f.scope.activeTab, true, true, true, true]] : [],
      );
    } finally {
      f.close();
    }
  });

test('Retry moves focus to the stable Refresh control before starting work', () => {
  const f = fixture();
  const focus: unknown[] = [];
  const retry = execute(jsxCallback('Retry', 'onClick', true), {
    ...f.scope,
    refreshTab: () => focus.push(f.document.activeElement),
  }) as () => void;
  try {
    retry();
    assert.deepEqual(focus, [f.scope.refreshButtonRef.current]);
  } finally {
    f.close();
  }
});

for (const destination of [
  'same tree',
  'other control',
  'other tab',
  'no row',
  'other key',
] as const)
  test(`Find dismissal preserves ${destination} focus ownership`, () => {
    const f = fixture();
    const input = f.document.querySelector<HTMLInputElement>('#other')!;
    const queries: unknown[] = [];
    const close = execute(jsxCallback('Find in tree', 'onKeyDown'), {
      ...f.scope,
      setQueries: (update: (value: unknown) => unknown) =>
        queries.push(update({ source: 'needle', other: 'kept' })),
    }) as (event: unknown) => void;
    try {
      input.focus();
      close({
        key: destination === 'other key' ? 'a' : 'Escape',
        currentTarget: input,
        preventDefault() {},
        stopPropagation() {},
      });
      if (destination === 'other control')
        f.scope.refreshButtonRef.current!.focus();
      if (destination === 'other tab')
        f.scope.workspaceRef.current.activeTabId = 'next';
      if (destination === 'no row')
        f.document.querySelector('[data-tree-key]')!.remove();
      const before = f.document.activeElement;
      f.frames();
      assert.equal(
        f.document.activeElement,
        destination === 'same tree'
          ? f.document.querySelector('[data-tree-key]')
          : before,
      );
      assert.deepEqual(
        queries,
        destination === 'other key' ? [] : [{ source: '', other: 'kept' }],
      );
    } finally {
      f.close();
    }
  });

test('relative tab shortcuts defer focus until commit, with a single-tab guard', () => {
  const f = fixture();
  const tabs = [{ id: 'source' }, { id: 'next' }];
  const workspaceRef = { current: { tabs, activeTabId: 'source' } };
  let navigations = 0;
  for (const tab of tabs) {
    const element = f.document.createElement('div');
    element.className = 'top-tab';
    element.dataset.tabId = tab.id;
    element.tabIndex = 0;
    f.document.body.append(element);
  }
  const select = execute(callback(app, 'selectRelativeTab'), {
    ...f.scope,
    workspaceRef,
    navigate: (tab: { id: string }) => {
      navigations++;
      workspaceRef.current.activeTabId = tab.id;
    },
  }) as (direction: -1 | 1) => void;
  try {
    const input = f.document.querySelector<HTMLInputElement>('#other')!;
    input.focus();
    for (const [direction, id] of [
      [1, 'next'],
      [1, 'source'],
      [-1, 'next'],
    ] as const) {
      select(direction);
      assert.equal(workspaceRef.current.activeTabId, id);
      assert.equal(f.document.activeElement, input);
      assert.equal(f.scope.pendingTabFocus.current?.tabId, id);
      assert.equal(f.scope.pendingTabFocus.current?.origin, input);
    }
    workspaceRef.current.tabs = [tabs[1]];
    f.scope.pendingTabFocus.current = null;
    select(1);
    assert.equal(navigations, 3);
    assert.equal(f.scope.pendingTabFocus.current, null);
    workspaceRef.current.tabs = tabs;
    f.document.querySelector('[data-tab-id="source"]')!.remove();
    select(1);
    assert.equal(workspaceRef.current.activeTabId, 'source');
    assert.equal(f.document.activeElement, input);
    workspaceRef.current.tabs = [];
    select(1);
    assert.equal(navigations, 4);
  } finally {
    f.close();
  }
});

for (const command of ['nextTab', 'previousTab'] as const)
  for (const modal of ['none', 'dialog', 'child'] as const)
    test(`${command} respects the ${modal} modal boundary`, () => {
      const f = fixture();
      const moves: number[] = [];
      let prevented = 0;
      const key = execute(callback(app, 'onKey'), {
        ...f.scope,
        workspaceTransferBusy: { current: false },
        workBrief: null,
        dialog: modal === 'dialog' ? 'commands' : null,
        childParent: modal === 'child' ? {} : null,
        editor: null,
        Element: f.dom.window.Element,
        navigator: { platform: 'Linux' },
        appearanceSaving: { current: false },
        workspace: {
          shortcuts: { nextTab: 'nextTab', previousTab: 'previousTab' },
        },
        matchesShortcut: (_event: unknown, shortcut: string) =>
          shortcut === command,
        selectRelativeTab: (direction: number) => moves.push(direction),
      }) as (event: unknown) => void;
      try {
        key({
          key: 'Tab',
          ctrlKey: true,
          shiftKey: command === 'previousTab',
          target: f.document.body,
          preventDefault: () => {
            prevented++;
          },
        });
        assert.deepEqual(
          moves,
          modal === 'none' ? [command === 'nextTab' ? 1 : -1] : [],
        );
        assert.equal(prevented, 1);
      } finally {
        f.close();
      }
    });

for (const existing of [false, true]) {
  for (const focus of [undefined, false, true]) {
    test(`opening a tree queues post-commit focus only when requested: existing=${existing}, focus=${focus}`, () => {
      const f = fixture();
      try {
        const input = f.document.querySelector<HTMLInputElement>('#other')!;
        input.focus();
        const tab = {
          id: 'destination',
          connectionId: 'work',
          rootKey: 'CAN-200',
        };
        const navigated: (typeof tab)[] = [];
        const dialogs: unknown[] = [];
        const run = execute(callback(app, 'openTab'), {
          ...f.scope,
          connections: [{ id: 'work', provider: 'jira' }],
          workspaceRef: { current: { tabs: existing ? [tab] : [] } },
          rootView: () => ({ hideDone: false }),
          navigate: (value: typeof tab) => navigated.push(value),
          setDialog: (value: unknown) => dialogs.push(value),
        });
        run('work', 'can-200', focus);
        assert.equal(navigated.length, 1);
        assert.equal(navigated[0].rootKey, 'CAN-200');
        if (existing) assert.equal(navigated[0], tab);
        assert.equal(
          f.document.activeElement === input,
          true,
          'opening waits for commit before moving focus',
        );
        if (focus) {
          assert.equal(f.scope.pendingTabFocus.current?.tabId, navigated[0].id);
          assert.equal(f.scope.pendingTabFocus.current?.origin === input, true);
        } else assert.equal(f.scope.pendingTabFocus.current, null);
        assert.deepEqual(dialogs, [null]);
      } finally {
        f.close();
      }
    });
  }
}

const errorRecoveryBanner = findNode(
  app,
  (node): node is ts.JsxOpeningElement =>
    ts.isJsxOpeningElement(node) &&
    node.attributes.properties.some(
      (attribute) =>
        ts.isJsxAttribute(attribute) &&
        attribute.name.getText() === 'role' &&
        attribute.initializer?.getText() === '"alert"',
    ) &&
    node.attributes.properties.some(
      (attribute) =>
        ts.isJsxAttribute(attribute) &&
        attribute.name.getText() === 'data-tree-recovery',
    ),
);
const errorRecoveryAttribute = errorRecoveryBanner.attributes.properties.find(
  (node) =>
    ts.isJsxAttribute(node) && node.name.getText() === 'data-tree-recovery',
) as ts.JsxAttribute;
const errorRecoveryOwner = (errors: Record<string, string>) =>
  execute(
    (
      errorRecoveryAttribute.initializer as ts.JsxExpression
    ).expression!.getText(),
    { errors, activeTab: { id: 'source' } },
  );

for (const unrelated of ['workspace', 'edit', 'app', 'other'])
  test(`the rendered error-banner attribute only identifies tree recovery with ${unrelated} errors`, () => {
    assert.equal(errorRecoveryOwner({ [unrelated]: 'Failure' }), undefined);
    assert.equal(
      errorRecoveryOwner({ [unrelated]: 'Failure', source: 'Tree failure' }),
      'source',
    );
  });

for (const outcome of ['success', 'failure'] as const)
  for (const origin of [
    'Retry',
    'Retry load',
    'Cancel load',
    'Dismiss error',
    'other control',
    'other tab',
    'saved view',
    'other recovery',
    'workspace error',
    'edit error',
    'app error',
    'no fallback',
  ] as const)
    test(`background refresh preserves ${origin} focus through ${outcome}`, async () => {
      const f = fixture();
      const banner = f.document.createElement('div');
      const persistentError = [
        'workspace error',
        'edit error',
        'app error',
      ].includes(origin);
      const recoveryOwner = errorRecoveryOwner(
        persistentError
          ? { [origin.split(' ')[0]]: 'Failure' }
          : { source: 'Tree failure' },
      );
      if (recoveryOwner !== undefined)
        banner.dataset.treeRecovery =
          origin === 'other recovery' ? 'other' : recoveryOwner;
      const trigger = f.document.createElement('button');
      trigger.textContent = origin;
      banner.append(trigger);
      f.document.body.append(banner);
      if (origin === 'other control')
        f.document.querySelector<HTMLInputElement>('#other')!.focus();
      else trigger.focus();
      if (origin === 'other tab')
        f.scope.workspaceRef.current.activeTabId = 'other';
      if (origin === 'saved view')
        f.scope.workspaceRef.current.activeSavedViewId = 'view';
      if (origin === 'no fallback') f.scope.refreshButtonRef.current = null;
      const before = f.document.activeElement;
      const tab = f.scope.activeTab!;
      let resolve!: (value: unknown) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      let busy = false;
      const focusAtBusy: Element[] = [];
      const scope = {
        ...f.scope,
        tabsRef: { current: [tab] },
        manualRelationshipRefreshes: { current: new Set() },
        forcedRefreshes: { current: new Set() },
        cancelledTrees: { current: new Set() },
        deferredRefreshes: { current: new Set() },
        runningExplicitRefreshes: { current: new Map() },
        refreshSequences: { current: {} },
        snapshotsRef: { current: {} },
        cooldowns: { current: {} },
        refreshBlocked: { current: () => false },
        refreshSchedule: { current: { begin: () => true, finish() {} } },
        rootRefreshes: {
          current: {
            load: () => ({ promise, started: true, generation: 1 }),
            isCurrent: () => true,
            replaceSnapshot() {},
          },
        },
        mutations: {
          isEvicted: () => false,
          beginRefresh: () => 1,
          endRefresh() {},
          confirmedSnapshot: () => undefined,
          receive() {},
        },
        refreshAnnouncements: {
          request() {},
          begin() {},
          complete() {},
          fail() {},
          end() {},
        },
        invalidateRelationships() {},
        refreshRootKey: () => 'root',
        navigator: { onLine: true },
        demoMode: false,
        connectionsRef: { current: [] },
        window: { canopy: { syncStatus: async () => null } },
        treeRefreshError: () => 'Request failed',
        setConnectionErrors() {},
        setErrors() {
          if (outcome === 'success' && !persistentError) banner.remove();
        },
        setWorkspace() {},
        setRefreshing() {
          busy = !busy;
          if (busy) {
            focusAtBusy.push(f.document.activeElement!);
            if (!persistentError) trigger.disabled = true;
          }
        },
      };
      const refresh = execute(callback(app, 'refreshTab'), scope) as (
        tab: unknown,
        quiet: boolean,
      ) => Promise<void>;
      try {
        const pending = refresh(tab, true);
        const shouldTransfer = ![
          'other control',
          'other tab',
          'saved view',
          'other recovery',
          'workspace error',
          'edit error',
          'app error',
          'no fallback',
        ].includes(origin);
        assert.equal(
          focusAtBusy[0],
          shouldTransfer ? f.scope.refreshButtonRef.current : before,
        );
        if (outcome === 'success') resolve({ issues: [], warnings: [] });
        else reject(new Error('Request failed'));
        await pending;
        assert.equal(busy, false);
        if (shouldTransfer)
          assert.equal(
            f.document.activeElement,
            f.scope.refreshButtonRef.current,
          );
        else if (origin === 'other control' || persistentError)
          assert.equal(f.document.activeElement, before);
        else
          assert.notEqual(
            f.document.activeElement,
            f.scope.refreshButtonRef.current,
          );
      } finally {
        f.close();
      }
    });
