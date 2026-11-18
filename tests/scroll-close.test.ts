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
      .includes('pendingScrollRestore.current = null') === true,
);

for (const switchTab of [false, true])
  test(`paused first-snapshot scroll restore ${switchTab ? 'does not follow a tab change' : 'retries the saved fractional offset on owner release'}`, () => {
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
      render();
    }
    release(4);
    assert.equal(controller.paused, false);
    assert.equal(document.body.inert, false);
    assert.equal(viewport.scrollTop, switchTab ? 0 : tab.scrollTop);
    assert.equal(pendingScrollRestore.current, switchTab ? tab.id : null);
    assert.equal(writes, 0);
  });
