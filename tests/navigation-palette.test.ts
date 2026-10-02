import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { demoSeeds } from '../src/main/demo-provider';
import { CommandDialog } from '../src/renderer/App';
import {
  paletteIndex,
  paletteIssueTab,
  searchPalette,
  paletteSelection,
  movePaletteSelection,
} from '../src/renderer/navigation-palette';
import { paletteReturn } from '../src/renderer/palette-return';
import type { Connection, TreeSnapshot, Workspace } from '../src/shared/types';

const connection = (id: string): Connection => ({
  id,
  name: `Site ${id}`,
  provider: 'jira',
  url: `https://${id}.atlassian.net`,
  accountName: id,
});
const tab = (id: string, connectionId = 'one') => ({
  id,
  connectionId,
  rootKey: 'CAN-100',
  expanded: ['CAN-100'],
  hideDone: false,
  scrollTop: 100,
});
const workspace: Workspace = {
  tabs: [tab('first'), tab('second', 'two')],
  activeTabId: 'first',
  recentRoots: [
    tab('duplicate'),
    { connectionId: 'one', rootKey: 'CAN-200', summary: 'Platform' },
    { connectionId: 'removed', rootKey: 'CAN-300' },
  ],
  savedViews: [
    {
      id: 'view',
      name: 'Platform planning',
      roots: [],
      connectionIds: ['one'],
      filters: { assignee: 'any', statuses: [], priority: '', hideDone: false },
      sort: { column: 'key', direction: 'asc' },
    },
  ],
  shortcuts: {},
  theme: 'system',
  sidebarCollapsed: false,
};
const snapshot: TreeSnapshot = {
  rootKey: 'CAN-100',
  fetchedAt: 1,
  warnings: ['Some linked issues could not be loaded'],
  issues: demoSeeds.slice(0, 5),
};
const actions = [{ id: 'refresh', label: 'Refresh current tree' }];
const index = () =>
  paletteIndex(
    workspace,
    [connection('one'), connection('two')],
    { first: snapshot, second: snapshot, duplicate: snapshot },
    actions,
  );

test('local search retains provider identity, root context and snapshot disclosures', () => {
  const entries = index();
  assert.equal(entries.filter((e) => e.target.type === 'Open root').length, 2);
  assert.equal(
    entries.filter((e) => e.target.type === 'Recent root').length,
    1,
  );
  assert.equal(
    entries.filter((e) => e.target.type === 'Loaded issue').length,
    10,
  );
  assert.ok(!entries.some((e) => e.context.includes('removed')));
  const issues = searchPalette(entries, 'CAN-100').filter(
    (e) => e.target.type === 'Loaded issue' && e.target.key === 'CAN-100',
  );
  assert.equal(issues.length, 2);
  assert.notEqual(issues[0].id, issues[1].id);
  assert.match(issues[0].context, /Site one · jira · in CAN-100/);
  assert.match(issues[0].context, /may be stale/);
  assert.match(issues[0].context, /Some linked issues could not be loaded/);
  assert.equal(
    searchPalette(entries, 'platform planning')[0].target.type,
    'Saved view',
  );
  assert.equal(searchPalette(entries, 'refresh')[0].target.type, 'Action');
  assert.equal(
    searchPalette(entries, 'site two jira').some(
      (e) => e.target.type === 'Connection',
    ),
    true,
  );
  assert.equal(searchPalette(entries, '')[0].id, entries[0].id);
  assert.ok(
    searchPalette(entries, '').every((e) => e.target.type !== 'Loaded issue'),
  );
});

test('exact keys outrank summary prefixes; keyboard identity survives ranking changes', () => {
  const entries = index();
  const exact = searchPalette(entries, 'CAN-100');
  assert.equal(exact[0].target.type, 'Open root');
  const selected = exact.at(-1)!;
  assert.equal(
    paletteSelection([...exact].reverse(), selected.id)?.id,
    selected.id,
  );
  assert.equal(paletteSelection(exact, 'gone')?.id, exact[0].id);
  assert.equal(movePaletteSelection(exact, exact[0].id, -1), exact[0].id);
  assert.equal(
    movePaletteSelection(exact, exact.at(-1)?.id, 1),
    exact.at(-1)?.id,
  );
  assert.equal(movePaletteSelection([], undefined, 1), undefined);
  assert.equal(searchPalette(entries, 'no match').length, 0);
  assert.ok(searchPalette(entries, 'CAN', 2).length <= 2);
});

test('dismissal restores focus without native scrolling and restores both scroll axes', () => {
  let focusOptions: FocusOptions | undefined;
  const focus = {
    isConnected: true,
    focus: (options: FocusOptions) => {
      focusOptions = options;
    },
  } as unknown as HTMLElement;
  const scroll = {
    isConnected: true,
    scrollTop: 321,
    scrollLeft: 42,
  } as HTMLElement;
  const restore = paletteReturn(focus, scroll);
  scroll.scrollTop = 999;
  scroll.scrollLeft = 99;
  restore();
  assert.deepEqual(focusOptions, { preventScroll: true });
  assert.equal(scroll.scrollTop, 321);
  assert.equal(scroll.scrollLeft, 42);
  paletteReturn(null, null)();
  const removed = {
    isConnected: false,
    focus: () => assert.fail('detached focus'),
    scrollTop: 8,
    scrollLeft: 2,
  } as unknown as HTMLElement;
  const detachedReturn = paletteReturn(removed, removed);
  removed.scrollTop = 9;
  detachedReturn();
  assert.equal(removed.scrollTop, 9);
});

test('palette renders typed contextual options and an explicit remote search entry', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { activeElement: null },
  });
  try {
    const html = renderToStaticMarkup(
      React.createElement(CommandDialog, {
        workspace,
        connections: [connection('one'), connection('two')],
        snapshots: { first: snapshot },
        sources: [],
        commands: [],
        shortcuts: {},
        scrollElement: null,
        onOpen: () => assert.fail('render contacted provider'),
        onNavigate: () => assert.fail('render navigated'),
        onClose: () => {},
      }),
    );
    assert.match(html, /role="combobox"/);
    assert.match(html, /aria-activedescendant="palette-root:/);
    assert.match(html, /role="option" aria-selected="true"/);
    assert.match(html, /Open root/);
    assert.match(html, /Recent root/);
    assert.match(html, /Saved view/);
    assert.match(html, /Connection/);
    assert.match(html, /Search remote issues/);
    assert.match(html, /may be stale or incomplete/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('representative busy workspace benchmark measures index build and warm query p50/p95', () => {
  const connections = Array.from({ length: 250 }, (_, i) =>
    connection(`site-${i}`),
  );
  const tabs = Array.from({ length: 2000 }, (_, i) => ({
    ...tab(`tab-${i}`, connections[i % connections.length].id),
    rootKey: `ROOT-${i}`,
  }));
  const busy: Workspace = {
    ...workspace,
    tabs,
    activeTabId: tabs[0].id,
    recentRoots: Array.from({ length: 2000 }, (_, i) => ({
      connectionId: connections[i % connections.length].id,
      rootKey: `RECENT-${i}`,
      summary: `Recent platform ${i}`,
    })),
  };
  const snapshots = Object.fromEntries(
    tabs.map((t, i) => [
      t.id,
      {
        ...snapshot,
        rootKey: t.rootKey,
        issues: Array.from({ length: 20 }, (_, j) => ({
          ...demoSeeds[0],
          key: `ISSUE-${i * 20 + j}`,
          summary: `Platform task ${j}`,
        })),
      },
    ]),
  );
  const start = performance.now();
  const entries = paletteIndex(busy, connections, snapshots, actions);
  const build = performance.now() - start;
  const queries = [
    'platform',
    'ROOT-1999',
    'site-249',
    'refresh',
    'platform site-24',
    'missing',
    '',
  ];
  for (const query of queries) searchPalette(entries, query);
  const samples = Array.from({ length: 70 }, (_, i) => {
    const start = performance.now();
    const found = searchPalette(entries, queries[i % queries.length]);
    assert.ok(found.length <= 80);
    return performance.now() - start;
  }).sort((a, b) => a - b);
  console.log(
    `Palette benchmark: 250 connections, 2,000 open + 2,000 recent roots, 40,000 issues; ${entries.length} entries; build=${build.toFixed(2)}ms; query p50=${samples[35].toFixed(2)}ms p95=${samples[66].toFixed(2)}ms max=${samples.at(-1)!.toFixed(2)}ms`,
  );
  assert.ok(entries.length > 40000);
  assert.equal(searchPalette(entries, 'ROOT-1999')[0].label, 'ROOT-1999');
  // A loose guard catches accidental quadratic work without asserting machine speed.
  assert.ok(
    build < 10000 && samples.at(-1)! < 2000,
    'palette took seconds on a representative workspace',
  );
});

test('loaded issue navigation expands ancestors, preserves root position and clears focused subtree', () => {
  const source = {
    ...tab('source'),
    focusKey: 'OTHER-1',
    expanded: ['EXISTING-1'],
    selectedKey: 'ROOT-1',
  };
  const tree: TreeSnapshot = {
    ...snapshot,
    rootKey: 'ROOT-1',
    issues: [
      { ...demoSeeds[0], key: 'ROOT-1', parentKey: undefined },
      { ...demoSeeds[0], key: 'PARENT-1', parentKey: 'ROOT-1' },
      { ...demoSeeds[0], key: 'CHILD-1', parentKey: 'PARENT-1' },
    ],
  };
  const next = paletteIssueTab(source, 'CHILD-1', tree);
  assert.equal(next.id, source.id);
  assert.equal(next.connectionId, source.connectionId);
  assert.equal(next.scrollTop, 100);
  assert.equal(next.selectedKey, 'CHILD-1');
  assert.equal(next.focusKey, undefined);
  assert.deepEqual(next.expanded, [
    'EXISTING-1',
    'ROOT-1',
    'PARENT-1',
    'CHILD-1',
  ]);
  assert.deepEqual(source.expanded, ['EXISTING-1']);
});
