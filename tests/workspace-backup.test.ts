import { DEFAULT_VIEW, migrateViews } from '../src/renderer/table-view';
import { activateTab, closeTabs } from '../src/renderer/workspace';
import { validateWorkspace } from '../src/shared/workspace-validation';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createBackup,
  parseBackup,
  planImport,
  BACKUP_LIMIT,
  validateBackupWorkspace,
} from '../src/shared/workspace-backup';
import type { Connection, Workspace } from '../src/shared/types';
import {
  backupConnections,
  backupWorkspace,
} from './fixtures/workspace-backup';
const fixture = () =>
  createBackup(
    structuredClone(backupWorkspace),
    backupConnections,
    '2026-10-02T00:00:00.000Z',
  );
const mapping = {
  'sample-jira': 'destination-jira',
  'sample-github': 'destination-github',
};
const destinations: Connection[] = backupConnections.map((c) => ({
  ...c,
  id: mapping[c.id as keyof typeof mapping],
}));
const empty = (): Workspace => ({
  tabs: [],
  activeTabId: null,
  theme: 'light',
  sidebarCollapsed: false,
  shortcuts: {},
});

test('round trips portable settings and excludes secrets, snapshots, and navigation history', () => {
  const local = {
    ...structuredClone(backupWorkspace),
    credentials: { marker: 'FAKE SECRET' },
    issueSnapshots: { marker: 'PRIVATE CACHE' },
  };
  const connections = backupConnections.map((c) => ({
    ...c,
    token: 'FAKE TOKEN',
    accountName: 'private-account',
  }));
  const backup = createBackup(local, connections);
  const contents = JSON.stringify(backup);
  for (const forbidden of [
    'FAKE SECRET',
    'FAKE TOKEN',
    'PRIVATE CACHE',
    'PRIVATE SNAPSHOT',
    'private-account',
    'seenRoots',
    'credentials',
    'issueSnapshots',
  ])
    assert.ok(!contents.includes(forbidden), forbidden);
  assert.deepEqual(backup.workspace.tabs[0].expanded, []);
  assert.equal(backup.workspace.tabs[0].scrollTop, 0);
  assert.deepEqual(parseBackup(contents), backup);
  assert.deepEqual(backup.workspace.reading, backupWorkspace.reading);
  assert.deepEqual(backup.workspace.pinnedRoots, backupWorkspace.pinnedRoots);
  assert.deepEqual(backup.workspace.savedViews, backupWorkspace.savedViews);
});

test('rejects malformed, truncated, oversized, and unsupported versions', () => {
  for (const contents of [
    '{',
    'null',
    '[]',
    JSON.stringify({ ...fixture(), version: 2 }),
    JSON.stringify({ ...fixture(), version: '1' }),
    ' '.repeat(BACKUP_LIMIT + 1),
  ])
    assert.throws(() => parseBackup(contents));
  const b = fixture();
  b.workspace.tabs[0].hideDone = 'yes' as never;
  assert.throws(() => parseBackup(JSON.stringify(b)));
});

test('rejects unknown fields and malicious keys throughout the allowlist', () => {
  for (const mutate of [
    (b: any) => {
      b.credentials = { fake: 'TOKEN' };
    },
    (b: any) => {
      b.workspace.seenRoots = {};
    },
    (b: any) => {
      b.connections[0].token = 'FAKE';
    },
    (b: any) => {
      b.workspace.tabs[0].snapshot = {};
    },
    (b: any) => {
      b.workspace.tabs[0].filters = { status: 'Open', token: 'FAKE' };
    },
    (b: any) => {
      b.workspace.savedViews[0].filters.token = 'FAKE';
    },
    (b: any) => {
      b.workspace.savedViews[0].filters.assignee = ['any'];
    },
    (b: any) => {
      b.workspace.savedViews[0].sort.direction = ['asc'];
    },
    (b: any) => {
      b.workspace.rootViews['["sample-jira","SAMPLE-1"]'].widths.token = 'FAKE';
    },
    (b: any) => {
      b.workspace.shortcuts = JSON.parse('{"__proto__":"Meta+K"}');
    },
    (b: any) => {
      b.workspace.rootViews = JSON.parse('{"constructor":{}}');
    },
    (b: any) => {
      b.workspace.tabs[0].rootKey = '../../../credentials';
    },
    (b: any) => {
      b.connections[0].url = 'https://user:FAKE@sample.invalid';
    },
    (b: any) => {
      b.connections[0].url = 'https://sample.invalid?token=FAKE';
    },
  ]) {
    const b = fixture();
    mutate(b);
    assert.throws(() => parseBackup(JSON.stringify(b)));
  }
});

test('version 1 migrates absent reading and missing commands, rejects duplicate identities and shortcuts', () => {
  const b = fixture();
  delete b.workspace.reading;
  delete b.workspace.shortcuts.selectTab9;
  const restored = parseBackup(JSON.stringify(b));
  assert.deepEqual(restored.workspace.reading, {
    textSize: 'medium',
    spacing: 'compact',
  });
  assert.equal(restored.workspace.shortcuts.selectTab9, '');
  b.workspace.shortcuts.quickOpen = b.workspace.shortcuts.commandPalette;
  assert.throws(() => parseBackup(JSON.stringify(b)), /Conflicting/);
  const duplicate = fixture();
  duplicate.workspace.tabs.push({
    ...duplicate.workspace.tabs[0],
    id: 'unique',
  });
  assert.throws(() => parseBackup(JSON.stringify(duplicate)), /Duplicate root/);
});

test('mapping requires explicit compatible distinct destinations and preserves cross-provider identity', () => {
  const b = fixture();
  assert.throws(
    () => planImport(b, empty(), destinations, {}, 'merge'),
    /Reconnect/,
  );
  assert.throws(
    () =>
      planImport(
        b,
        empty(),
        [{ ...destinations[0], url: 'https://other.invalid' }, destinations[1]],
        mapping,
        'merge',
      ),
    /same provider/,
  );
  assert.throws(
    () =>
      planImport(
        b,
        empty(),
        destinations,
        { ...mapping, 'sample-github': 'destination-jira' },
        'merge',
      ),
    /same provider/,
  );
  const result = planImport(
    b,
    empty(),
    destinations,
    mapping,
    'replace',
  ).workspace;
  assert.deepEqual(
    result.tabs.map((t) => t.connectionId),
    ['destination-jira', 'destination-github'],
  );
  assert.equal(
    result.savedViews?.[0].roots[0].connectionId,
    'destination-jira',
  );
  const unknown = fixture();
  unknown.workspace.tabs[0].connectionId = 'missing';
  assert.throws(
    () => parseBackup(JSON.stringify(unknown)),
    /Missing connection/,
  );
});

test('merge keeps existing conflicts and appearance, reidentifies tab collisions, and previews effects', () => {
  const current = {
    ...empty(),
    tabs: [
      {
        ...backupWorkspace.tabs[0],
        connectionId: 'destination-jira',
        rootKey: 'sample-1',
      },
      { ...backupWorkspace.tabs[1], connectionId: 'other-github' },
    ],
    activeTabId: 'tab-1',
    savedViews: [{ ...backupWorkspace.savedViews![0], name: 'Existing view' }],
  };
  const plan = planImport(fixture(), current, destinations, mapping, 'merge');
  assert.equal(plan.workspace.theme, 'light');
  assert.equal(plan.workspace.tabs.length, 3);
  assert.equal(plan.workspace.tabs[2].id, 'import-tab-2');
  assert.equal(plan.workspace.savedViews?.[0].name, 'Existing view');
  assert.ok(plan.conflicts.some((c) => c.startsWith('Open root')));
  assert.ok(plan.conflicts.some((c) => c.startsWith('Saved view')));
});

test('replace previews removal, preserves local seen data, and leaves source inputs untouched', () => {
  const current = {
    ...empty(),
    seenRoots: structuredClone(backupWorkspace.seenRoots),
  };
  const b = fixture();
  const serialized = JSON.stringify(b);
  const plan = planImport(b, current, destinations, mapping, 'replace');
  assert.equal(plan.workspace.theme, 'dark');
  assert.deepEqual(plan.workspace.seenRoots, current.seenRoots);
  assert.ok(plan.conflicts.some((c) => c.startsWith('Replace removes')));
  assert.equal(JSON.stringify(b), serialized);
});

test('distinct source accounts cannot collapse to one destination and merge limits fail explicitly', () => {
  const b = fixture();
  b.connections.push({ ...b.connections[0], id: 'second-source' });
  assert.throws(
    () =>
      planImport(
        b,
        empty(),
        destinations,
        { ...mapping, 'second-source': 'destination-jira' },
        'merge',
      ),
    /distinct/,
  );
  const current = {
    ...empty(),
    tabs: Array.from({ length: 100 }, (_, i) => ({
      ...backupWorkspace.tabs[0],
      id: `local-${i}`,
      rootKey: `SAMPLE-${i + 10}`,
      connectionId: 'destination-jira',
    })),
  };
  assert.throws(
    () => planImport(fixture(), current, destinations, mapping, 'merge'),
    /exceed/,
  );
});

test('retains literal shortcut keys supported by the shortcut recorder', () => {
  const b = fixture();
  b.workspace.shortcuts.quickOpen = 'Meta++';
  b.workspace.shortcuts.selectTab9 = 'Meta+ ';
  b.workspace.shortcuts.selectTab8 = 'F24';
  assert.deepEqual(
    parseBackup(JSON.stringify(b)).workspace.shortcuts,
    b.workspace.shortcuts,
  );
});

test('export normalizes repeated close/reopen and restored history without relaxing external validation', () => {
  let history = migrateViews(structuredClone(backupWorkspace));
  const original = history.tabs[0];
  history = closeTabs(history, [original.id]);
  history = activateTab(history, { ...original, id: 'opened-again' });
  history = closeTabs(history, ['opened-again']);
  validateWorkspace(history);
  const before = JSON.stringify(history);
  const backup = createBackup(history, backupConnections);
  assert.equal(
    backup.workspace.closedTabs?.filter((t) => t.rootKey === original.rootKey)
      .length,
    1,
  );
  assert.equal(backup.workspace.closedTabs?.[0].id, 'opened-again');
  assert.equal(JSON.stringify(history), before);
  const ambiguous = structuredClone(backup);
  ambiguous.workspace.closedTabs!.push({
    ...ambiguous.workspace.closedTabs![0],
    id: 'duplicate-root',
  });
  assert.throws(
    () => parseBackup(JSON.stringify(ambiguous)),
    /Duplicate root identities/,
  );

  let restored = closeTabs(migrateViews(structuredClone(backupWorkspace)), [
    original.id,
  ]);
  restored = activateTab(restored, original, true);
  validateWorkspace(restored);
  const reopened = createBackup(restored, backupConnections);
  assert.equal(reopened.workspace.tabs[0].id, restored.tabs[0].id);
  assert.ok(
    !reopened.workspace.closedTabs?.some((t) => t.rootKey === original.rootKey),
  );
  reopened.workspace.closedTabs!.push({
    ...reopened.workspace.tabs[0],
    rootKey: 'SAMPLE-99',
  });
  assert.throws(
    () => parseBackup(JSON.stringify(reopened)),
    /Duplicate tab identifiers/,
  );
});

test('both import modes retain tab-only table settings before creating root maps', () => {
  const source = structuredClone(backupWorkspace);
  delete source.rootViews;
  delete source.viewDefaults;
  source.tabs[0].view = {
    ...structuredClone(DEFAULT_VIEW),
    widths: { ...DEFAULT_VIEW.widths, issue: 777 },
    hideDone: false,
    filters: { status: 'custom-status' },
  };
  source.tabs[0].hideDone = false;
  source.tabs[0].filters = { status: 'custom-status' };
  const backup = createBackup(source, backupConnections);
  for (const mode of ['merge', 'replace'] as const) {
    const plan = planImport(backup, empty(), destinations, mapping, mode);
    assert.equal(plan.workspace.tabs[0].view?.widths.issue, 777, mode);
    assert.equal(plan.workspace.tabs[0].hideDone, false, mode);
    assert.deepEqual(
      plan.workspace.tabs[0].filters,
      { status: 'custom-status' },
      mode,
    );
    assert.deepEqual(
      plan.workspace.rootViews?.['["destination-jira","SAMPLE-1"]'],
      source.tabs[0].view,
      mode,
    );
    const filtersOnly = structuredClone(backup);
    delete filtersOnly.workspace.tabs[0].view;
    const legacy = planImport(
      filtersOnly,
      empty(),
      destinations,
      mapping,
      mode,
    );
    assert.equal(legacy.workspace.tabs[0].hideDone, false);
    assert.deepEqual(legacy.workspace.tabs[0].filters, {
      status: 'custom-status',
    });
  }
  const localView = {
    ...structuredClone(DEFAULT_VIEW),
    widths: { ...DEFAULT_VIEW.widths, issue: 888 },
    filters: { status: 'local-status' },
  };
  const local = {
    ...empty(),
    tabs: [
      {
        ...source.tabs[0],
        connectionId: 'destination-jira',
        view: localView,
        hideDone: true,
        filters: localView.filters,
      },
    ],
    activeTabId: 'tab-1',
  };
  const merged = planImport(backup, local, destinations, mapping, 'merge');
  assert.deepEqual(merged.workspace.tabs[0].view, localView);
  assert.ok(merged.conflicts.some((c) => c.startsWith('Root view:')));
  const replaced = planImport(backup, local, destinations, mapping, 'replace');
  assert.equal(replaced.workspace.tabs[0].view?.widths.issue, 777);
});

test('timestamps require an exact valid calendar round trip', () => {
  for (const createdAt of [
    '2026-02-30T00:00:00.000Z',
    '2026-02-29T00:00:00.000Z',
    '2026-04-31T00:00:00.000Z',
    '2026-10-02T24:00:00.000Z',
  ]) {
    const backup = fixture();
    backup.createdAt = createdAt;
    assert.throws(
      () => parseBackup(JSON.stringify(backup)),
      /timestamp/,
      createdAt,
    );
  }
  const leap = fixture();
  leap.createdAt = '2028-02-29T00:00:00.000Z';
  assert.equal(parseBackup(JSON.stringify(leap)).createdAt, leap.createdAt);
});

test('portable imports preserve destination triage and validate local inbox preferences', () => {
  const current = empty();
  current.triage = { version: 1, items: [], reviewStatuses: {}, history: [] };
  validateWorkspace(current);
  const backup = fixture();
  assert.ok(!Object.hasOwn(backup.workspace, 'triage'));
  for (const mode of ['merge', 'replace'] as const)
    assert.deepEqual(
      planImport(backup, current, destinations, mapping, mode).workspace.triage,
      current.triage,
    );
  assert.throws(
    () =>
      validateWorkspace({
        ...current,
        triage: { ...current.triage!, version: 2 },
      } as unknown as Workspace),
    /Invalid inbox preferences/,
  );
});

test('merge retains full local closed history and previews every dropped unique root', () => {
  const current = {
    ...empty(),
    closedTabs: Array.from({ length: 20 }, (_, i) => ({
      ...backupWorkspace.closedTabs![0],
      id: `local-${i}`,
      rootKey: `SAMPLE-${100 - i}`,
      connectionId: 'destination-jira',
    })),
  };
  validateWorkspace(current);
  const backup = fixture();
  backup.workspace.closedTabs!.push({
    ...backup.workspace.closedTabs![0],
    id: 'another-closed',
    rootKey: 'SAMPLE-3',
  });
  const parsed = parseBackup(JSON.stringify(backup));
  const before = structuredClone({ current, parsed, destinations, mapping });
  const plan = planImport(parsed, current, destinations, mapping, 'merge');
  assert.deepEqual(
    plan.workspace.closedTabs?.map((t) => t.id),
    current.closedTabs.map((t) => t.id),
  );
  assert.deepEqual(
    plan.conflicts.filter((c) => c.startsWith('Closed root:')),
    [
      'Closed root: ["destination-jira","sample-2"] — omit from full closed history',
      'Closed root: ["destination-jira","sample-3"] — omit from full closed history',
    ],
  );
  assert.equal(plan.workspace.tabs.length, 2);
  assert.ok(plan.effects.some((e) => e.includes('20 closed roots')));
  assert.deepEqual({ current, parsed, destinations, mapping }, before);
  assert.equal(
    planImport(parsed, current, destinations, mapping, 'replace').workspace
      .closedTabs?.length,
    2,
  );
});

test('merge fills closed history in local-first order with connection identity and unique tab IDs', () => {
  const current = {
    ...empty(),
    tabs: [{ ...backupWorkspace.tabs[0], connectionId: 'destination-jira' }],
    activeTabId: 'tab-1',
    closedTabs: Array.from({ length: 18 }, (_, i) => ({
      ...backupWorkspace.closedTabs![0],
      id: i === 0 ? 'closed-1' : i === 1 ? 'import-tab-1' : `local-${i}`,
      rootKey: i === 0 ? 'sample-2' : `SAMPLE-${100 - i}`,
      connectionId: 'destination-jira',
      summary: 'local visit',
    })),
  };
  const backup = fixture();
  backup.workspace.tabs[0].id = 'source-open';
  backup.workspace.activeTabId = 'source-open';
  backup.connections.push({ ...backup.connections[0], id: 'other-source' });
  const extraDestination = { ...destinations[0], id: 'other-destination' };
  backup.workspace.closedTabs!.push(
    {
      ...backup.workspace.closedTabs![0],
      id: 'import-closed-1',
      connectionId: 'other-source',
      summary: 'separate account',
    },
    { ...backup.workspace.closedTabs![0], id: 'tab-1', rootKey: 'SAMPLE-3' },
    { ...backup.workspace.closedTabs![0], id: 'drop-1', rootKey: 'SAMPLE-4' },
    { ...backup.workspace.closedTabs![0], id: 'drop-2', rootKey: 'SAMPLE-5' },
  );
  const parsed = parseBackup(JSON.stringify(backup));
  const connections = [...destinations, extraDestination];
  const mapped = { ...mapping, 'other-source': extraDestination.id };
  const before = structuredClone({ current, parsed, connections, mapped });
  const plan = planImport(parsed, current, connections, mapped, 'merge');
  const closed = plan.workspace.closedTabs!;
  assert.deepEqual(
    closed.slice(0, 18).map((t) => t.id),
    current.closedTabs.map((t) => t.id),
  );
  assert.equal(closed[0].summary, 'local visit');
  assert.deepEqual(
    closed.slice(18).map((t) => [t.connectionId, t.rootKey, t.id]),
    [
      ['other-destination', 'SAMPLE-2', 'import-import-closed-1'],
      ['destination-jira', 'SAMPLE-3', 'import-import-tab-1'],
    ],
  );
  assert.deepEqual(
    plan.conflicts.filter((c) => c.startsWith('Closed root:')),
    [
      'Closed root: ["destination-jira","sample-2"] — keep existing',
      'Closed root: ["destination-jira","sample-4"] — omit from full closed history',
      'Closed root: ["destination-jira","sample-5"] — omit from full closed history',
    ],
  );
  assert.deepEqual(
    plan.workspace.tabs.map((t) => t.id),
    ['tab-1', 'tab-2'],
  );
  assert.equal(plan.workspace.activeTabId, 'tab-1');
  const tabs = [...plan.workspace.tabs, ...closed];
  assert.equal(new Set(tabs.map((t) => t.id)).size, tabs.length);
  assert.deepEqual({ current, parsed, connections, mapped }, before);
});

test('merge keeps strict favorite and recent-root capacity limits', () => {
  for (const key of ['pinnedRoots', 'recentRoots'] as const) {
    const current = {
      ...empty(),
      [key]: Array.from({ length: 1000 }, (_, i) => ({
        connectionId: 'destination-jira',
        rootKey: `SAMPLE-${i + 10}`,
      })),
    };
    validateWorkspace(current);
    assert.throws(
      () => planImport(fixture(), current, destinations, mapping, 'merge'),
      /Merged (Favorite|Recent root) exceed/,
    );
  }
});

test('external backups retain strict closed, open, favorite and recent-root limits', () => {
  for (const [key, limit] of [
    ['closedTabs', 20],
    ['tabs', 100],
    ['pinnedRoots', 1000],
    ['recentRoots', 1000],
  ] as const) {
    const backup = fixture();
    const roots = Array.from({ length: limit }, (_, i) => ({
      connectionId: 'sample-jira',
      rootKey: `SAMPLE-${i + 10}`,
    }));
    if (key === 'tabs' || key === 'closedTabs')
      backup.workspace[key] = roots.map((root, i) => ({
        ...backup.workspace.tabs[0],
        ...root,
        id: `limit-${i}`,
      }));
    else backup.workspace[key] = roots;
    if (key === 'tabs') backup.workspace.activeTabId = 'limit-0';
    assert.doesNotThrow(() => parseBackup(JSON.stringify(backup)), key);
    backup.workspace[key]!.push({
      ...backup.workspace.tabs[0],
      id: 'overflow',
      rootKey: 'SAMPLE-9999',
    });
    assert.throws(
      () => parseBackup(JSON.stringify(backup)),
      /Invalid backup list/,
      key,
    );
  }
});

const viewMap = (connectionId: string, start: number, count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      JSON.stringify([connectionId, `SAMPLE-${start + i}`]),
      structuredClone(DEFAULT_VIEW),
    ]),
  );

test('merge rejects view map overflow after mapping without changing inputs', () => {
  for (const key of ['rootViews', 'viewDefaults'] as const) {
    const local = {
      ...empty(),
      [key]:
        key === 'rootViews'
          ? viewMap('destination-jira', 1, 1000)
          : Object.fromEntries(
              Array.from({ length: 1000 }, (_, i) => [
                `local-${i}`,
                structuredClone(DEFAULT_VIEW),
              ]),
            ),
    };
    validateWorkspace(local);
    const backup = fixture();
    if (key === 'rootViews')
      backup.workspace.rootViews = viewMap('sample-jira', 1001, 1);
    const before = structuredClone({ local, backup, destinations, mapping });
    assert.throws(
      () => planImport(backup, local, destinations, mapping, 'merge'),
      key === 'rootViews'
        ? /Merged Root view entries exceed the workspace limit; use replace or reduce the workspace\./
        : /Merged Connection view entries exceed the workspace limit; use replace or reduce the workspace\./,
    );
    assert.deepEqual({ local, backup, destinations, mapping }, before);
    const replaced = planImport(
      backup,
      local,
      destinations,
      mapping,
      'replace',
    );
    assert.equal(Object.keys(replaced.workspace[key]!).length, 1);
    assert.doesNotThrow(() => createBackup(replaced.workspace, destinations));
  }
});

test('merge counts unique mapped root views at the export boundary and keeps local conflicts', () => {
  const localView = { ...structuredClone(DEFAULT_VIEW), hideDone: false };
  const local = { ...empty(), rootViews: viewMap('destination-jira', 1, 900) };
  local.rootViews['["destination-jira","SAMPLE-1"]'] = localView;
  const backup = fixture();
  backup.workspace.rootViews = viewMap('sample-jira', 901, 100);
  backup.workspace.rootViews['["sample-jira","sample-1"]'] =
    structuredClone(DEFAULT_VIEW);
  backup.workspace.rootViews['["sample-github","sample/repo#1"]'] =
    structuredClone(DEFAULT_VIEW);
  // A different mapped account remains unique, even at the same root key.
  delete backup.workspace.rootViews['["sample-jira","SAMPLE-1000"]'];
  const parsed = parseBackup(JSON.stringify(backup));
  const before = structuredClone({ local, parsed, destinations, mapping });
  const merged = planImport(parsed, local, destinations, mapping, 'merge');
  assert.equal(Object.keys(merged.workspace.rootViews!).length, 1000);
  assert.deepEqual(
    merged.workspace.rootViews!['["destination-jira","SAMPLE-1"]'],
    localView,
  );
  assert.deepEqual(
    merged.conflicts.filter((c) => c.startsWith('Root view:')),
    ['Root view: ["destination-jira","SAMPLE-1"] — keep existing'],
  );
  assert.ok(
    merged.workspace.rootViews!['["destination-github","SAMPLE/REPO#1"]'],
  );
  const exported = createBackup(merged.workspace, destinations);
  assert.deepEqual(parseBackup(JSON.stringify(exported)), exported);
  assert.equal(Object.keys(exported.workspace.rootViews!).length, 1000);
  assert.deepEqual({ local, parsed, destinations, mapping }, before);
  parsed.workspace.rootViews!['["sample-jira","SAMPLE-1000"]'] =
    structuredClone(DEFAULT_VIEW);
  assert.throws(
    () => planImport(parsed, local, destinations, mapping, 'merge'),
    /Merged Root view entries exceed/,
  );
});

test('merge counts exact connection view keys and rejects oversized valid local maps', () => {
  for (const key of ['rootViews', 'viewDefaults'] as const) {
    const local = {
      ...empty(),
      [key]:
        key === 'rootViews'
          ? viewMap('destination-jira', 1, 1000)
          : Object.fromEntries(
              Array.from({ length: 1000 }, (_, i) => [
                i === 0 ? 'destination-github' : `local-${i}`,
                structuredClone(DEFAULT_VIEW),
              ]),
            ),
    };
    const backup = fixture();
    const merged = planImport(backup, local, destinations, mapping, 'merge');
    assert.equal(Object.keys(merged.workspace[key]!).length, 1000);
    assert.ok(
      merged.conflicts.some((c) =>
        c.startsWith(key === 'rootViews' ? 'Root view:' : 'Connection view:'),
      ),
    );
    const extraKey =
      key === 'rootViews' ? '["destination-jira","SAMPLE-1001"]' : 'local-1001';
    local[key]![extraKey] = structuredClone(DEFAULT_VIEW);
    validateWorkspace(local); // Ordinary workspace validation permits large maps.
    const before = structuredClone(local);
    assert.throws(
      () => planImport(backup, local, destinations, mapping, 'merge'),
      /Merged .* view entries exceed.*use replace or reduce/,
    );
    assert.deepEqual(local, before); // Reject rather than clip local entries.
  }
});

test('merge counts saved views after ID and name conflicts and rejects unique overflow', () => {
  const local = {
    ...empty(),
    savedViews: Array.from({ length: 99 }, (_, i) => ({
      ...structuredClone(backupWorkspace.savedViews![0]),
      id: `local-${i}`,
      name: `Local ${i}`,
      connectionIds: ['destination-jira'],
      roots: [{ connectionId: 'destination-jira', rootKey: 'SAMPLE-1' }],
    })),
    activeSavedViewId: 'local-0',
  };
  const backup = fixture();
  backup.workspace.savedViews = [
    {
      ...structuredClone(backup.workspace.savedViews![0]),
      id: 'local-0',
      name: 'ID conflict',
    },
    {
      ...structuredClone(backup.workspace.savedViews![0]),
      id: 'name-conflict',
      name: 'Local 1',
    },
    {
      ...structuredClone(backup.workspace.savedViews![0]),
      id: 'unique',
      name: 'Unique',
    },
  ];
  backup.workspace.activeSavedViewId = 'unique';
  const parsed = parseBackup(JSON.stringify(backup));
  const before = structuredClone({ local, parsed, destinations, mapping });
  const merged = planImport(parsed, local, destinations, mapping, 'merge');
  assert.equal(merged.workspace.savedViews!.length, 100);
  assert.deepEqual(merged.workspace.savedViews!.slice(0, 99), local.savedViews);
  assert.equal(merged.workspace.activeSavedViewId, 'local-0');
  assert.deepEqual(
    merged.conflicts.filter((c) => c.startsWith('Saved view:')),
    [
      'Saved view: ID conflict (local-0) — keep existing',
      'Saved view: Local 1 (name-conflict) — keep existing',
    ],
  );
  const exported = createBackup(merged.workspace, destinations);
  assert.equal(
    parseBackup(JSON.stringify(exported)).workspace.savedViews!.length,
    100,
  );
  assert.deepEqual({ local, parsed, destinations, mapping }, before);
  parsed.workspace.savedViews!.push({
    ...structuredClone(parsed.workspace.savedViews![2]),
    id: 'overflow',
    name: 'Overflow',
  });
  const overflowBefore = structuredClone({ local, parsed });
  assert.throws(
    () => planImport(parsed, local, destinations, mapping, 'merge'),
    /Merged saved views exceed the workspace limit; use replace or reduce the workspace\./,
  );
  assert.deepEqual({ local, parsed }, overflowBefore);
  assert.equal(
    planImport(parsed, local, destinations, mapping, 'replace').workspace
      .savedViews!.length,
    4,
  );
});

test('external backups enforce exact view map and saved-view limits', () => {
  const backup = fixture();
  backup.workspace.rootViews = viewMap('sample-jira', 1, 1000);
  assert.doesNotThrow(() => parseBackup(JSON.stringify(backup)));
  backup.workspace.rootViews['["sample-jira","SAMPLE-1001"]'] =
    structuredClone(DEFAULT_VIEW);
  assert.throws(
    () => parseBackup(JSON.stringify(backup)),
    /Too many table views/,
  );
  delete backup.workspace.rootViews;
  backup.workspace.viewDefaults = Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [
      `source-${i}`,
      structuredClone(DEFAULT_VIEW),
    ]),
  );
  assert.doesNotThrow(() =>
    validateBackupWorkspace(structuredClone(backup.workspace)),
  );
  // Count is valid; reference validation still rejects unknown connections.
  assert.throws(
    () => parseBackup(JSON.stringify(backup)),
    /Missing connection descriptor/,
  );
  backup.workspace.viewDefaults['source-1000'] = structuredClone(DEFAULT_VIEW);
  assert.throws(
    () => parseBackup(JSON.stringify(backup)),
    /Too many table views/,
  );
  delete backup.workspace.viewDefaults;
  backup.workspace.savedViews = Array.from({ length: 100 }, (_, i) => ({
    ...structuredClone(backupWorkspace.savedViews![0]),
    id: `saved-${i}`,
    name: `Saved ${i}`,
  }));
  backup.workspace.activeSavedViewId = 'saved-0';
  assert.doesNotThrow(() => parseBackup(JSON.stringify(backup)));
  backup.workspace.savedViews.push({
    ...structuredClone(backup.workspace.savedViews[0]),
    id: 'saved-100',
    name: 'Overflow',
  });
  assert.throws(
    () => parseBackup(JSON.stringify(backup)),
    /Invalid backup list/,
  );
});
