import assert from 'node:assert/strict';
import { it } from 'node:test';
import React from 'react';
import ts from 'typescript';
import { callback, execute, findNode, sourceFile } from './source-probe';
import { starterViews } from '../src/renderer/saved-views';
import { renderToStaticMarkup } from 'react-dom/server';
import { demoWorkspace } from '../src/main/demo';
import type { RootView, Workspace } from '../src/shared/types';
import {
  DEFAULT_READING,
  recoverWorkspaceViews,
  validReading,
} from '../src/shared/views';
import {
  DEFAULT_VIEW,
  migrateViews,
  readingStyle,
  resetRootView,
  setRootView,
  viewKey,
} from '../src/renderer/table-view';
import { activateTab, closeTabs, reopenTab } from '../src/renderer/workspace';
import { Settings } from '../src/renderer/Settings';
import { ViewSettings } from '../src/renderer/TableView';
const a = {
  id: 'a',
  connectionId: 'one',
  rootKey: 'A-1',
  expanded: [],
  hideDone: true,
  scrollTop: 0,
};
const b = { ...a, id: 'b', connectionId: 'two', rootKey: 'B-1' };
const base: Workspace = {
  tabs: [a, b],
  activeTabId: 'b',
  shortcuts: {},
  theme: 'system',
  sidebarCollapsed: false,
};
const legacy = (textSize: string, spacing = 'comfortable') =>
  ({ ...DEFAULT_VIEW, textSize, spacing }) as RootView;
it('preserves active effective preference and removes legacy copies from every scope', () => {
  const saved = recoverWorkspaceViews({
    ...base,
    tabs: [
      { ...a, view: legacy('small') },
      { ...b, view: legacy('small') },
    ],
    closedTabs: [{ ...a, view: legacy('small') }],
    rootViews: { [viewKey(b)]: legacy('large') },
    viewDefaults: { two: legacy('medium') },
  });
  assert.deepEqual(saved.reading, {
    textSize: 'large',
    spacing: 'comfortable',
  });
  for (const view of [
    ...saved.tabs.map((tab) => tab.view),
    ...saved.closedTabs!.map((tab) => tab.view),
    ...Object.values(saved.rootViews!),
    ...Object.values(saved.viewDefaults!),
  ]) {
    assert.equal(view && 'textSize' in view, false);
    assert.equal(view && 'spacing' in view, false);
  }
  assert.deepEqual(
    recoverWorkspaceViews(JSON.parse(JSON.stringify(saved))),
    saved,
  );
});
it('uses active connection defaults before snapshots; valid global reading always wins', () => {
  const old = {
    ...base,
    tabs: [a, { ...b, view: legacy('small') }],
    viewDefaults: { two: legacy('large') },
  };
  assert.equal(recoverWorkspaceViews(old).reading?.textSize, 'large');
  assert.deepEqual(
    recoverWorkspaceViews({ ...old, reading: DEFAULT_READING }).reading,
    DEFAULT_READING,
  );
});
it('falls back deterministically through open, closed and sorted connection defaults', () => {
  assert.equal(
    recoverWorkspaceViews({
      ...base,
      activeTabId: null,
      tabs: [{ ...a, view: legacy('small') }, b],
    }).reading?.textSize,
    'small',
  );
  assert.equal(
    recoverWorkspaceViews({
      ...base,
      tabs: [],
      closedTabs: [{ ...a, view: legacy('large') }],
    }).reading?.textSize,
    'large',
  );
  assert.equal(
    recoverWorkspaceViews({
      ...base,
      tabs: [],
      viewDefaults: { z: legacy('large'), a: legacy('small') },
    }).reading?.textSize,
    'small',
  );
  assert.deepEqual(
    recoverWorkspaceViews({
      ...base,
      reading: { textSize: 'huge', spacing: 'compact' } as never,
    }).reading,
    { textSize: 'medium', spacing: 'compact' },
  );
  assert.equal(validReading({ textSize: 'small', spacing: 'wide' }), false);
});
it('recovers malformed persisted reading without coercion or losing workspace state', () => {
  const malformed = [
    { textSize: ['small'], spacing: 'compact' },
    { textSize: 'large', spacing: ['compact'] },
    { textSize: { toString: null }, spacing: 'compact' },
    { textSize: 'small', spacing: { toString: null } },
    { textSize: null, spacing: 'compact' },
    { textSize: 'medium', spacing: 0 },
  ];
  const current = setRootView(
    migrateViews({
      ...base,
      palette: 'forest',
      shortcuts: { quickOpen: 'Meta+o' },
      pinnedRoots: [a],
      savedViews: [],
    }),
    b,
    {
      columns: ['issue', 'status'],
      sort: { column: 'status', direction: 'desc' },
      filters: { priority: 'p9' },
      hideDone: false,
    },
  );
  for (const reading of malformed) {
    assert.equal(validReading(reading), false);
    const saved = JSON.parse(JSON.stringify({ ...current, reading }));
    const recovered = recoverWorkspaceViews(saved);
    assert.deepEqual(recovered, {
      ...current,
      reading: { textSize: 'medium', spacing: 'compact' },
    });
    assert.deepEqual(saved.reading, reading);
    const withLegacy = {
      ...saved,
      rootViews: {
        ...saved.rootViews,
        [viewKey(b)]: {
          ...saved.rootViews[viewKey(b)],
          textSize: 'large',
          spacing: 'comfortable',
        },
      },
    };
    assert.deepEqual(recoverWorkspaceViews(withLegacy), {
      ...current,
      reading: { textSize: 'large', spacing: 'comfortable' },
    });
  }
});
it('reading survives navigation, root reset, reopening and restart while root choices stay local', () => {
  let current = migrateViews(base);
  current = setRootView(current, a, { columns: ['issue'], hideDone: false });
  const snapshot = current.tabs[0];
  current = {
    ...current,
    reading: { textSize: 'large', spacing: 'comfortable' },
  };
  current = activateTab(current, snapshot);
  current = resetRootView(current, b);
  current = reopenTab(closeTabs(current, [a.id]));
  current = migrateViews(JSON.parse(JSON.stringify(current)));
  assert.deepEqual(current.reading, {
    textSize: 'large',
    spacing: 'comfortable',
  });
  assert.equal(current.tabs[0].hideDone, true);
  assert.equal(current.tabs[1].hideDone, false);
  assert.deepEqual(readingStyle(current.reading), {
    '--tree-font-size': '15px',
    '--row-height': '40px',
  });
});
it('Settings exposes global reading, scoped reset and setup destinations; root View keeps root controls', () => {
  const noop = () => {};
  const html = renderToStaticMarkup(
    React.createElement(Settings, {
      reading: DEFAULT_READING,
      onReading: noop,
      onAppearance: noop,
      onShortcuts: noop,
      onConnect: noop,
      onBackup: noop,
    }),
  );
  for (const label of [
    'Reading',
    'Text size',
    'Row spacing',
    'Reset reading to Medium / Comfortable',
    'Appearance',
    'Keyboard shortcuts',
    'Connection setup',
    'Saved automatically',
  ])
    assert.ok(html.includes(label));
  const root = renderToStaticMarkup(
    React.createElement(ViewSettings, {
      view: DEFAULT_VIEW,
      update: noop,
      reset: noop,
      useDefault: noop,
    }),
  );
  assert.ok(!root.includes('Text size'));
  assert.ok(!root.includes('Row spacing'));
  assert.ok(root.includes('Reset this root to default'));
});

it('keeps migration density separate from fresh workspace and reset defaults', () => {
  assert.deepEqual(migrateViews(demoWorkspace).reading, {
    textSize: 'medium',
    spacing: 'comfortable',
  });
  assert.deepEqual(DEFAULT_READING, {
    textSize: 'medium',
    spacing: 'comfortable',
  });
  for (const workspace of [base, { ...base, tabs: [], activeTabId: null }]) {
    const saved = JSON.parse(JSON.stringify(workspace));
    const migrated = migrateViews(saved);
    assert.deepEqual(migrated.reading, {
      textSize: 'medium',
      spacing: 'compact',
    });
    assert.deepEqual(
      migrateViews(JSON.parse(JSON.stringify(migrated))),
      migrated,
    );
    assert.equal(saved.reading, undefined);
  }
  for (const spacing of ['compact', 'comfortable'] as const) {
    for (const textSize of ['small', 'medium', 'large'] as const) {
      const reading = { textSize, spacing };
      const saved = { ...base, reading };
      assert.deepEqual(migrateViews(saved).reading, reading);
      assert.deepEqual(
        migrateViews({
          ...base,
          tabs: [{ ...a, view: legacy(textSize, spacing) }],
        }).reading,
        reading,
      );
    }
  }
  assert.deepEqual(
    migrateViews({ ...base, reading: { ...DEFAULT_READING } }).reading,
    DEFAULT_READING,
  );
});

it('hydrates fresh startup with Comfortable while saved workspaces retain their density', () => {
  const renderer = sourceFile(
    new URL('../src/renderer/App.tsx', import.meta.url),
  );
  const hydration = findNode(
    renderer,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      node.expression.getText() === 'setWorkspace' &&
      node.arguments[0]?.getText().includes('...EMPTY_WORKSPACE') === true &&
      node.arguments[0]?.getText().includes('...saved') === true,
  ).arguments[0].getText();
  const context = {
    PLATFORM_SHORTCUTS: {},
    DEFAULT_READING,
    migrateViews,
    starterViews,
    nextConnections: [],
  };
  const empty = execute(callback(renderer, 'EMPTY_WORKSPACE'), context);
  const hydrate = (saved?: Workspace) =>
    execute(hydration, {
      ...context,
      EMPTY_WORKSPACE: empty,
      saved,
      tabs: saved?.tabs ?? [],
    }) as Workspace;
  assert.deepEqual(hydrate().reading, {
    textSize: 'medium',
    spacing: 'comfortable',
  });
  assert.deepEqual(hydrate(base).reading, {
    textSize: 'medium',
    spacing: 'compact',
  });
  assert.deepEqual(hydrate({ ...base, tabs: [], activeTabId: null }).reading, {
    textSize: 'medium',
    spacing: 'compact',
  });
  for (const spacing of ['compact', 'comfortable'] as const) {
    const saved = { ...base, reading: { textSize: 'large', spacing } as const };
    assert.deepEqual(hydrate(saved).reading, saved.reading);
    assert.deepEqual(
      hydrate(JSON.parse(JSON.stringify(hydrate(saved)))).reading,
      saved.reading,
    );
  }
});
