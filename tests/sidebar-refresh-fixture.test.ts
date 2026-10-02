import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { validRootView } from '../src/shared/views';
import { migrateViews, rootView } from '../src/renderer/table-view';
import type { Workspace } from '../src/shared/types';
import { ControlledDemoProvider } from './fixtures/controlled';

it('holds changed refresh data until release and records completion only after the response is available', async () => {
  const provider = new ControlledDemoProvider();
  const original = await provider.tree('CAN-100');
  await provider.remoteUpdate('CAN-100', {
    summary: 'Completed sidebar refresh',
  });
  provider.hold('sidebar-refresh', 'tree', 'CAN-100');
  let responded = false;
  const response = provider.tree('CAN-100').then((snapshot) => {
    responded = true;
    return snapshot;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(provider.started('sidebar-refresh'), true);
  assert.equal(responded, false);
  assert.equal(provider.completed('sidebar-refresh'), false);
  assert.notEqual(
    original.issues.find((issue) => issue.key === 'CAN-100')?.summary,
    'Completed sidebar refresh',
  );
  provider.release('sidebar-refresh');
  const refreshed = await response;
  assert.equal(responded, true);
  assert.equal(
    refreshed.issues.find((issue) => issue.key === 'CAN-100')?.summary,
    'Completed sidebar refresh',
  );
  assert.equal(provider.completed('sidebar-refresh'), true);
});

it('retains the actual sidebar smoke root override through workspace migration', async () => {
  const view = JSON.parse(
    await readFile(
      new URL('./fixtures/sidebar-root-view.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(
    validRootView(view),
    true,
    'Smoke must seed a supported root sort column',
  );
  const tab = {
    id: 'sample',
    connectionId: 'demo',
    rootKey: 'CAN-100',
    expanded: ['CAN-100'],
    hideDone: true,
    scrollTop: 0,
  };
  const workspace: Workspace = {
    tabs: [tab],
    activeTabId: tab.id,
    rootViews: { '["demo","CAN-100"]': view },
    theme: 'system',
    sidebarCollapsed: false,
    shortcuts: {},
  };
  const migrated = migrateViews(JSON.parse(JSON.stringify(workspace)));
  assert.deepEqual(migrated.rootViews?.['["demo","CAN-100"]'], view);
  assert.deepEqual(rootView(migrated, tab), view);
  assert.deepEqual(rootView(migrated, tab).columns, ['issue', 'status']);
  assert.equal(rootView(migrated, tab).hideDone, false);
  assert.equal(rootView(migrated, tab).widths.issue, 520);
  const invalid = {
    ...workspace,
    rootViews: {
      '["demo","CAN-100"]': {
        ...view,
        sort: { column: 'key', direction: 'asc' },
      },
    },
  } as Workspace;
  assert.deepEqual(
    migrateViews(invalid).rootViews,
    {},
    'Unsupported key sort reproduces the observed dropped override',
  );
});
