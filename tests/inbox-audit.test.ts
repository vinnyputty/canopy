import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  Connection,
  Issue,
  IssueRelationships,
  TreeSnapshot,
  Workspace,
} from '../src/shared/types';
import { triageIdentity } from '../src/shared/triage';
import { InboxPanel } from '../src/renderer/InboxPanel';
import {
  inboxCandidates,
  inboxItems,
  type InboxGraph,
} from '../src/renderer/inbox';
import { configuredRoots, viewSources } from '../src/renderer/saved-views';
import { nextTasks } from '../src/renderer/next-tasks';
import type { CanopyAPI } from '../src/shared/types';

it('executes the real inbox sample IPC fixture without Electron and renders canonical data', async () => {
  const source = readFileSync(
    new URL('../tools/smoke-inbox.mjs', import.meta.url),
    'utf8',
  );
  const start =
    source.indexOf('await app.evaluate(') + 'await app.evaluate('.length;
  const end = source.indexOf('\n  });\n  try', start) + '\n  }'.length;
  assert.ok(start > 0 && end > start);
  type Handler = (...args: unknown[]) => any;
  const handlers = new Map<string, Handler>();
  const context = {
    ipcMain: {
      _invokeHandlers: handlers,
      removeHandler: (channel: string) => handlers.delete(channel),
      handle: (channel: string, handler: Handler) =>
        handlers.set(channel, handler),
    },
    inboxAudit: undefined as unknown as {
      saved: Workspace | null;
      failed: boolean;
      accountFailed: boolean;
      accountCalls: string[];
      treeCalls: { connection: string; key: string }[];
      searches: number;
      mode: string;
      release: () => void;
      calls: { connection: string; key: string; requestId: string }[];
      cancelled: { connection: string; requestId: string }[];
      lateCompleted: number;
    },
  };
  runInNewContext(`(${source.slice(start, end)})({ipcMain})`, context);
  const call = (name: string, ...args: unknown[]) =>
    handlers.get(`canopy:${name}`)!(null, ...args);
  const workspace: Workspace = call('loadWorkspace');
  const connections: Connection[] = call('connections');
  const roots = configuredRoots(workspace, connections);
  const sources = viewSources(
    {
      id: 'sample',
      name: 'sample',
      roots,
      connectionIds: [],
      filters: { assignee: 'any', statuses: [], priority: '', hideDone: false },
      sort: { column: 'key', direction: 'asc' },
    },
    roots,
  );
  const snapshots: Record<string, TreeSnapshot> = {};
  const errors: Record<string, string> = {};
  for (const source of sources) {
    try {
      snapshots[source.id] = call('tree', source.connectionId, source.rootKey);
    } catch {
      errors[source.id] = 'Sample root unavailable';
    }
  }
  assert.equal(Object.keys(errors).length, 1);
  assert.equal(Object.keys(snapshots).length, 3);
  const candidates = inboxCandidates(sources, snapshots, connections);
  const graphs: Record<string, InboxGraph> = {};
  for (const candidate of candidates) {
    graphs[triageIdentity(candidate.source.connectionId, candidate.issue.key)] =
      {
        stamp: candidate.stamp,
        graph: await call(
          'relationships',
          candidate.source.connectionId,
          candidate.issue.key,
          'fixture-read',
        ),
      };
  }
  const helperStart = source.indexOf('const expectOwner =');
  const helperEnd = source.indexOf(
    '    await expect(\n      inbox.getByText(/Sample Jira account lookup failed/)',
    helperStart,
  );
  assert.ok(helperStart > 0 && helperEnd > helperStart);
  context.inboxAudit.saved = workspace;
  const active = () =>
    workspace.tabs.find((tab) => tab.id === workspace.activeTabId)!;
  const nativeExpect = Object.assign(
    (value: any) => ({
      toHaveAttribute: (_name: string, expected: string) =>
        assert.equal(value.selected ? 'true' : 'false', expected),
      toHaveCount: (expected: number) => assert.equal(value.count, expected),
      toBeVisible: () => assert.equal(value.visible, true),
      toBeFocused: () => assert.equal(value.focused, true),
    }),
    {
      poll: (callback: () => Promise<unknown>) => ({
        toBe: async (expected: unknown) =>
          assert.equal(await callback(), expected),
      }),
    },
  );
  const helperContext = {
    ...context,
    expect: nativeExpect,
    app: {
      evaluate: async (
        callback: (electron: unknown, payload: unknown) => unknown,
        payload: unknown,
      ) => callback({ ipcMain: context.ipcMain }, payload),
    },
    page: {
      getByRole: () => ({
        nth: (index: number) => ({
          selected: workspace.tabs[index]?.id === workspace.activeTabId,
        }),
      }),
      locator: (selector: string) => ({
        count: selector.includes(active().selectedKey ?? 'missing') ? 1 : 0,
        visible: true,
        focused: selector.includes(active().selectedKey ?? 'missing'),
      }),
    },
    expectOwner: undefined as unknown as (
      id: string,
      connection: string,
      key: string,
    ) => Promise<void>,
  };
  runInNewContext(
    `${source.slice(helperStart, helperEnd)};globalThis.expectOwner = expectOwner;`,
    helperContext,
  );
  await helperContext.expectOwner('other-source', 'other', 'org/repo#1');
  await assert.rejects(
    helperContext.expectOwner('source', 'work', 'org/repo#1'),
  );
  workspace.activeTabId = 'source';
  workspace.tabs.find((tab) => tab.id === 'source')!.selectedKey = 'org/repo#1';
  await helperContext.expectOwner('source', 'work', 'org/repo#1');
  await assert.rejects(
    helperContext.expectOwner('source', 'other', 'org/repo#1'),
  );
  workspace.activeTabId = 'other-source';
  assert.equal(workspace.activeTabId, 'other-source');
  assert.equal(
    workspace.tabs.find((tab) => tab.id === 'source')?.connectionId,
    'work',
  );
  assert.equal(
    workspace.tabs.find((tab) => tab.id === 'other-source')?.connectionId,
    'other',
  );
  const users: Record<string, { id: string }> = {};
  const identityErrors: Record<string, string> = {};
  for (const connection of connections) {
    try {
      users[connection.id] = call('currentUser', connection.id);
    } catch {
      identityErrors[connection.id] = 'Sample Jira account lookup failed';
    }
  }
  assert.notEqual(users.work.id, users.other.id);
  assert.equal(users.jira, undefined);
  assert.equal(identityErrors.jira, 'Sample Jira account lookup failed');
  const items = inboxItems(
    candidates,
    workspace,
    connections,
    snapshots,
    users,
    graphs,
    Date.now(),
  );
  assert.equal(items.length, 3);
  const work = items.find((item) => item.source.connectionId === 'work')!;
  assert.deepEqual(work.reasons, [
    'Unread changes',
    'Assigned to you',
    'Blocked by org/repo#9',
  ]);
  assert.equal(
    items
      .find((item) => item.source.connectionId === 'other')
      ?.reasons.join(','),
    'Assigned to you',
  );
  assert.ok(
    items
      .find((item) => item.source.connectionId === 'jira')
      ?.reasons.includes('Review: Review'),
  );
  assert.equal(
    items
      .find((item) => item.source.connectionId === 'jira')
      ?.reasons.includes('Assigned to you'),
    false,
  );
  const wrongUsers = { ...users, work: users.other };
  assert.equal(
    inboxItems(
      candidates,
      workspace,
      connections,
      snapshots,
      wrongUsers,
      graphs,
      Date.now(),
    )
      .find((item) => item.source.connectionId === 'work')
      ?.reasons.includes('Assigned to you'),
    false,
  );
  context.inboxAudit.accountFailed = false;
  users.jira = call('currentUser', 'jira');
  assert.ok(
    inboxItems(
      candidates,
      workspace,
      connections,
      snapshots,
      users,
      graphs,
      Date.now(),
    )
      .find((item) => item.source.connectionId === 'jira')
      ?.reasons.includes('Assigned to you'),
  );
  const snapshot = snapshots[work.source.id];
  assert.equal(
    nextTasks(snapshot, 'github', 'blocked', undefined, false, undefined, {
      [work.issue.key]: graphs[triageIdentity('work', work.issue.key)].graph!,
    })[0].blocker,
    'blocked',
  );
  context.inboxAudit.failed = false;
  assert.equal(call('tree', 'work', 'org/repo#10').issues.length, 1);
  assert.equal(context.inboxAudit.searches, 0);
  assert.equal(
    new Set(
      context.inboxAudit.treeCalls.map((item) =>
        JSON.stringify([item.connection, item.key]),
      ),
    ).size,
    4,
  );
  context.inboxAudit.mode = 'hold';
  const held: Promise<IssueRelationships> = call(
    'relationships',
    'work',
    'org/repo#1',
    'held-request',
  );
  call('cancelRelationships', 'work', 'held-request');
  assert.deepEqual(JSON.parse(JSON.stringify(context.inboxAudit.cancelled)), [
    { connection: 'work', requestId: 'held-request' },
  ]);
  context.inboxAudit.release();
  const late = await held;
  assert.equal(late.groups[0].items[0].summary, 'Late result');
  assert.equal(late.groups[0].items[0].key, 'org/repo#999');
  assert.equal(context.inboxAudit.lateCompleted, 1);
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { canopy: {} as CanopyAPI },
  });
  let html: string;
  try {
    html = renderToStaticMarkup(
      React.createElement(InboxPanel, {
        workspace,
        connections,
        sources,
        totalRoots: 14,
        snapshots,
        errors,
        identityErrors,
        users: { work: users.work, other: users.other },
        loading: new Set<string>(),
        now: Date.now(),
        onChange: () => {},
        onSeen: () => {},
        onOpen: () => {},
        onRefresh: () => {},
        onMoreRoots: () => {},
      }),
    );
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow,
    });
  }
  assert.match(html, /4 of 14 known roots/);
  assert.match(html, /Load 10 more roots/);
  assert.match(html, /Sample root unavailable/);
  assert.match(html, /Sample Jira account lookup failed/);
  assert.match(html, /Sample partial hierarchy/);
  assert.match(html, /Last confirmed update:/);
  assert.match(html, /cannot establish global absence/);
  assert.match(html, /Mark seen/);
  assert.match(html, /Review: Review/);
  if (process.env.CANOPY_INBOX_SAMPLE_OUTPUT) {
    const css = readFileSync(
      new URL('../src/renderer/styles.css', import.meta.url),
      'utf8',
    );
    writeFileSync(
      process.env.CANOPY_INBOX_SAMPLE_OUTPUT,
      `<!doctype html><html data-theme="light"><meta charset="utf-8"><title>Canopy issue84 disposable sample</title><style>${css}</style><body><main style="height:100vh;overflow:auto">${html}<p>This is an inert server-rendered fixture. Blocker inspection effects and interactions have not run.</p></main></body></html>`,
    );
  }
});
