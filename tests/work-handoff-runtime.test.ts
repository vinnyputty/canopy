import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  WorkHandoffQueue,
  launchHandoffArguments,
  HANDOFF_ACK_MS,
  HANDOFF_WAIT_MS,
  HANDOFF_CAPACITY,
} from '../src/main/work-handoff';
import { handoffNavigation } from '../src/renderer/work-handoff';
import type { HandoffState } from '../src/shared/types';
import { parseWorkHandoff } from '../src/shared/work-handoff';
import { connection, workspace, snapshot } from './fixtures/work-handoff';

const args = (view: string) => [
  '--canopy-open',
  `canopy://handoff/view?view=${view}`,
];

it('extracts only exact packaged/development arguments with documented demo and Linux suffixes', () => {
  assert.deepEqual(
    launchHandoffArguments(['Canopy', ...args('triage')], true, 'darwin'),
    args('triage'),
  );
  assert.deepEqual(
    launchHandoffArguments(
      ['electron', '/app', '--canopy-demo', ...args('triage'), '--no-sandbox'],
      false,
      'linux',
    ),
    args('triage'),
  );
  for (const raw of [
    ['electron', '/app', '--unknown', ...args('triage')],
    ['electron', '/app', ...args('triage'), '--execute'],
    ['electron', '/app', 'x'.repeat(2049)],
  ]) {
    const queue = new WorkHandoffQueue();
    queue.receive(launchHandoffArguments(raw, false, 'linux'));
    const ready = queue.ready(() => {});
    assert.equal(ready.rejected, true);
    assert.equal(ready.delivery, undefined);
    queue.stop();
  }
});

it('retains startup FIFO, deduplicates only pending/current intents and binds acknowledgments', () => {
  const queue = new WorkHandoffQueue();
  const sent: HandoffState[] = [];
  queue.receive(args('one'));
  queue.receive(args('two'));
  queue.receive(args('one'));
  queue.receive(args('three'));
  const first = queue.ready((state) => sent.push(state));
  assert.equal(first.delivery?.intent.kind, 'view');
  assert.equal((first.delivery!.intent as { view: string }).view, 'one');
  assert.equal(sent.length, 0);
  assert.equal(
    queue.acknowledge('foreign', first.delivery!.id, 'opened'),
    false,
  );
  assert.equal(queue.acknowledge(first.session, 'foreign', 'opened'), false);
  assert.equal(
    queue.acknowledge(first.session, first.delivery!.id, 'unknown'),
    false,
  );
  assert.equal(
    queue.acknowledge(first.session, first.delivery!.id, 'opened'),
    true,
  );
  assert.equal((sent[0].delivery!.intent as { view: string }).view, 'two');
  queue.receive(args('one')); // A completed command is allowed again, behind three.
  for (const expected of ['three', 'one']) {
    const current = sent.at(-1)!.delivery!;
    assert(queue.acknowledge(first.session, current.id, 'opened'));
    assert.equal(
      (sent.at(-1)!.delivery!.intent as { view: string }).view,
      expected,
    );
  }
  queue.stop();
});

it('refuses capacity overflow, expires hydration/current delivery and drains the next command', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
  const queue = new WorkHandoffQueue();
  const sent: HandoffState[] = [];
  for (let i = 0; i < HANDOFF_CAPACITY + 1; i++)
    queue.receive(args(`view-${i}`));
  const ready = queue.ready((state) => sent.push(state));
  assert.equal(ready.rejected, true);
  const first = ready.delivery!;
  context.mock.timers.tick(HANDOFF_ACK_MS);
  assert.equal(sent[0].canceledId, first.id);
  assert(sent[0].rejected);
  assert(sent[1].delivery);
  assert.equal(queue.acknowledge(ready.session, first.id, 'opened'), false);
  queue.cancel();
  queue.receive(args('waiting'));
  context.mock.timers.tick(HANDOFF_WAIT_MS);
  const empty = queue.ready(() => {});
  assert(empty.rejected);
  assert.equal(empty.delivery, undefined);
  queue.stop();
});

it('cancels old-session work and allows a fresh generation while stopping permanently at quit', () => {
  const queue = new WorkHandoffQueue();
  queue.receive(args('old'));
  const old = queue.ready(() => {});
  assert.equal(queue.cancel('foreign'), false);
  assert(queue.cancel(old.session));
  queue.receive(args('new'));
  const next = queue.ready(() => {});
  assert.notEqual(old.session, next.session);
  assert.equal(
    queue.acknowledge(old.session, old.delivery!.id, 'opened'),
    false,
  );
  queue.stop();
  queue.receive(args('later'));
  assert.throws(() => queue.ready(() => {}));
});

it('selects the exact known account/root and reveals filtered completed issues without rewriting view settings', () => {
  const issue = {
    ...snapshot.issues[0],
    key: 'team/repo#43',
    parentKey: 'team/repo#42',
    status: { id: 'done', name: 'Done', category: 'done' as const },
  };
  const root = 'team/repo#42';
  const state = {
    ...workspace,
    tabs: [
      {
        id: 'tab',
        connectionId: connection.id,
        rootKey: root,
        expanded: [],
        hideDone: true,
        filters: { status: 'open' },
        focusKey: 'team/repo#7',
        scrollTop: 123,
      },
    ],
    activeTabId: 'tab',
  };
  const intent = parseWorkHandoff(
    `canopy://handoff/issue?${new URLSearchParams({ connection: connection.id, provider: 'github', host: 'github.com', root, key: issue.key })}`,
  );
  const trees = [
    {
      connectionId: connection.id,
      snapshot: {
        ...snapshot,
        rootKey: root,
        issues: [snapshot.issues[0], issue],
      },
    },
  ];
  const plan = handoffNavigation(
    intent,
    [connection, { ...connection, id: 'account-b' }],
    state,
    trees,
    () => {
      throw Error('Should reuse tab');
    },
  );
  assert.equal(plan.kind, 'issue');
  if (plan.kind !== 'issue') return;
  assert.equal(plan.tab.connectionId, connection.id);
  assert.equal(plan.tab.selectedKey, issue.key);
  assert.equal(plan.tab.focusKey, undefined);
  assert.equal(plan.tab.hideDone, true);
  assert.deepEqual(plan.tab.filters, { status: 'open' });
  assert.equal(plan.tab.scrollTop, 123);
  assert.deepEqual(plan.tab.expanded, [root, issue.key]);
  assert.throws(() =>
    handoffNavigation(
      intent,
      [connection],
      state,
      [{ connectionId: 'account-b', snapshot: trees[0].snapshot }],
      () => '',
    ),
  );
});

it('refuses saved-view activation if any configured source lacks confirmed data', () => {
  const view = {
    id: 'triage',
    name: 'Triage',
    connectionIds: [connection.id],
    roots: [],
    filters: {
      assignee: 'any' as const,
      statuses: [],
      priority: '',
      hideDone: true,
    },
    sort: { column: 'key' as const, direction: 'asc' as const },
  };
  const state = { ...workspace, savedViews: [view] };
  const target = parseWorkHandoff('canopy://handoff/view?view=triage');
  const data = [{ connectionId: connection.id, snapshot }];
  assert.deepEqual(
    handoffNavigation(target, [connection], state, data, () => ''),
    { kind: 'view', viewId: 'triage' },
  );
  assert.throws(() =>
    handoffNavigation(
      target,
      [connection],
      {
        ...state,
        recentRoots: [{ connectionId: connection.id, rootKey: 'unknown/repo' }],
      },
      data,
      () => '',
    ),
  );
  assert.throws(() => handoffNavigation(target, [], state, data, () => ''));
  assert.throws(() =>
    handoffNavigation(target, [connection], workspace, data, () => ''),
  );
});

it('new renderer ownership prevents a late old readiness/cancel from clearing replacement work', () => {
  const queue = new WorkHandoffQueue();
  queue.receive(args('old'));
  const old = queue.ready(() => {}, 'old-client');
  const next = queue.ready(() => {}, 'next-client');
  assert.notEqual(next.session, old.session);
  queue.receive(args('replacement'));
  assert.equal(queue.cancel(old.session), false);
  assert.equal(
    queue.acknowledge(old.session, old.delivery!.id, 'opened'),
    false,
  );
  assert.equal(
    (queue.ready(() => {}, 'next-client').delivery!.intent as { view: string })
      .view,
    'replacement',
  );
  queue.stop();
});

it('opens actual Auth metadata ID formats without interpreting the namespace as credentials', () => {
  for (const [id, provider] of [
    ['github:' + 'a'.repeat(24), 'github'],
    ['token:' + 'b'.repeat(24), 'jira'],
    [
      '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
      'jira',
    ],
  ] as const) {
    const root = provider === 'github' ? 'team/repo' : 'CAN-100';
    const key = provider === 'github' ? 'team/repo#42' : 'CAN-111';
    const host = provider === 'github' ? 'github.com' : 'jira.example.com';
    const account = { ...connection, id, provider, url: `https://${host}` };
    const state = {
      ...workspace,
      pinnedRoots: [{ connectionId: id, rootKey: root }],
    };
    const tree = {
      ...snapshot,
      rootKey: root,
      issues: [
        { ...snapshot.issues[0], key: root },
        { ...snapshot.issues[0], key, parentKey: root },
      ],
    };
    const target = parseWorkHandoff(
      `canopy://handoff/issue?${new URLSearchParams({ connection: id, provider, host, root, key })}`,
    );
    const plan = handoffNavigation(
      target,
      [account],
      state,
      [{ connectionId: id, snapshot: tree }],
      () => 'new-tab',
    );
    assert.equal(plan.kind, 'issue');
    if (plan.kind === 'issue') assert.equal(plan.tab.connectionId, id);
    assert.throws(() =>
      handoffNavigation(
        target,
        [{ ...account, id: 'wrong-account' }],
        state,
        [{ connectionId: id, snapshot: tree }],
        () => '',
      ),
    );
  }
});
