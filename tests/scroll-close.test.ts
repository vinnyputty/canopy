import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { WorkspaceClose } from '../src/renderer/workspace-close';
import { callback, execute, findNode, sourceFile } from './source-probe';

const source = sourceFile(
  process.env.CANOPY_SCROLL_RENDERER_SOURCE ?? 'src/renderer/App.tsx',
);
const registration = findNode(
  source,
  (node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    node.expression.getText() === 'window.canopy.onWorkspaceFlush',
);
const restoreEffect = findNode(
  source,
  (node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    node.expression.getText() === 'useEffect' &&
    node.arguments[0]
      ?.getText()
      .includes('pendingScrollRestore.current !== activeTab.id') === true,
);

for (const route of ['same-tab', 'new-tab', 'stale-marker'])
  test(`paused first-snapshot scroll restore ${route}`, () => {
    const switchTab = route !== 'same-tab';
    const controller = new WorkspaceClose();
    const tab = { id: 'original', scrollTop: 231.75 };
    let workspace = {
      activeTabId: tab.id,
      tabs: [tab, { id: 'other', scrollTop: 80 }],
    };
    let snapshot: unknown;
    const viewport = { scrollTop: 0 };
    const pendingScrollRestore = { current: tab.id as string | null };
    const scrollPositions = { current: new Map<string, number>() };
    const document = {
      body: { inert: false },
      activeElement: null,
      defaultView: {
        HTMLElement: class {},
        addEventListener() {},
        removeEventListener() {},
      },
    };
    let dependencies: unknown[] | undefined;
    let writes = 0;
    const restoreScroll = execute(callback(source, 'restoreScroll'), {
      useCallback: (fn: unknown) => fn,
      workspaceClose: { current: controller },
      scrollRef: { current: viewport },
      scrollPositions,
      setWorkspace: () => {
        writes++;
      },
    });
    const render = () =>
      execute(`() => { ${restoreEffect.getText()}; }`, {
        workspace,
        activeTab: workspace.tabs.find(
          (item) => item.id === workspace.activeTabId,
        ),
        snapshot,
        scrollRef: { current: viewport },
        pendingScrollRestore,
        restoreScroll,
        useEffect: (effect: () => void, next: unknown[]) => {
          if (
            !dependencies ||
            next.some((value, index) => !Object.is(value, dependencies![index]))
          ) {
            dependencies = next;
            effect();
          }
        },
      })();
    const release = execute(registration.arguments[1].getText(), {
      workspaceClose: { current: controller },
      storeWorkspace: (
        update: (current: typeof workspace) => typeof workspace,
      ) => {
        workspace = update(workspace);
        render();
      },
    });
    render();
    controller.pause(4, document as unknown as Document, () => {});
    snapshot = {};
    render();
    assert.equal(viewport.scrollTop, 0);
    assert.equal(pendingScrollRestore.current, tab.id);
    assert.equal(scrollPositions.current.size, 0);
    assert.equal(writes, 0);
    release(3);
    assert.equal(controller.paused, true);
    assert.equal(viewport.scrollTop, 0);
    if (switchTab) {
      workspace = { ...workspace, activeTabId: 'other' };
      if (route === 'new-tab') {
        snapshot = { root: 'other' };
        const changeTab = findNode(
          source,
          (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            node.expression.getText() === 'useEffect' &&
            node.arguments[0]?.getText().includes('setEditor(null)') === true &&
            node.arguments[1]?.getText() === '[activeTab?.id]',
        );
        execute(changeTab.arguments[0].getText(), {
          activeTab: workspace.tabs[1],
          pendingScrollRestore,
          setEditor() {},
          setDragKey() {},
          setRowMenu() {},
        })();
      }
      render();
    }
    release(4);
    assert.equal(controller.paused, false);
    assert.equal(document.body.inert, false);
    assert.equal(
      viewport.scrollTop,
      route === 'new-tab' ? 80 : route === 'stale-marker' ? 0 : tab.scrollTop,
    );
    assert.equal(
      pendingScrollRestore.current,
      route === 'stale-marker' ? tab.id : null,
    );
    assert.equal(writes, 0);
  });

test('snapshot refresh during close restores and persists a native clamp after refusal', () => {
  const controller = new WorkspaceClose();
  let workspace = { activeTabId: 'tab', tabs: [{ id: 'tab', scrollTop: 600 }] };
  const pendingScrollRestore = { current: null as string | null };
  const scrollPositions = { current: new Map<string, number>() };
  let top = 600;
  const viewport = {
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      top = Math.min(200, value);
    },
  };
  const document = {
    body: { inert: false },
    activeElement: null,
    defaultView: {
      HTMLElement: class {},
      addEventListener() {},
      removeEventListener() {},
    },
  };
  const setWorkspace = (
    update: (current: typeof workspace) => typeof workspace,
  ) => {
    workspace = update(workspace);
  };
  const restoreScroll = execute(callback(source, 'restoreScroll'), {
    useCallback: (fn: unknown) => fn,
    workspaceClose: { current: controller },
    scrollRef: { current: viewport },
    scrollPositions,
    setWorkspace,
  });
  const snapshotEffect = findNode(
    source,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      node.expression.getText() === 'useLayoutEffect' &&
      node.arguments[0]?.getText().includes('restoreScroll(activeTab)') ===
        true,
  );
  const context = () => ({
    activeTab: workspace.tabs[0],
    snapshot: {},
    workspaceClose: { current: controller },
    scrollRef: { current: viewport },
    pendingScrollRestore,
    restoreScroll,
  });
  controller.pause(7, document as unknown as Document, () => {});
  top = 200;
  execute(snapshotEffect.arguments[0].getText(), context())();
  assert.equal(workspace.tabs[0].scrollTop, 600);
  assert.equal(pendingScrollRestore.current, 'tab');
  const release = execute(registration.arguments[1].getText(), {
    workspaceClose: { current: controller },
    storeWorkspace: (
      update: (current: typeof workspace) => typeof workspace,
    ) => {
      setWorkspace(update);
      execute(restoreEffect.arguments[0].getText(), context())();
    },
  });
  release(7);
  assert.equal(controller.paused, false);
  assert.equal(pendingScrollRestore.current, null);
  assert.equal(workspace.tabs[0].scrollTop, 200);
  assert.equal(scrollPositions.current.get('tab'), 200);
  assert.equal(viewport.scrollTop, 200);
});
