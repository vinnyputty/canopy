import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildIssueTree,
  flattenVisible,
  filterTree,
} from '../src/renderer/tree';
import { largeProvider } from './fixtures/large-trees';
import { Mutations, type MutationView } from '../src/renderer/mutations';
import { boundRoots, markRootSeen, unseenChanges } from '../src/renderer/seen';
import type {
  CanopyAPI,
  Issue,
  TabState,
  TreeSnapshot,
} from '../src/shared/types';

const issue = (i: number): Issue => ({
  id: String(i),
  key: `TEST-${i}`,
  summary: `Issue ${i}`,
  parentKey: i > 0 ? `TEST-${i - 1}` : undefined,
  type: 'Task',
  priority: null,
  assignee: null,
  status: { id: 'open', name: 'Open', category: 'new' },
  links: [],
});
const snapshot = (issues: Issue[]): TreeSnapshot => ({
  rootKey: issues[0].key,
  issues,
  fetchedAt: 1,
  warnings: [],
});
const tab = (id: string): TabState => ({
  id,
  connectionId: id,
  rootKey: 'TEST-0',
  expanded: [],
  hideDone: true,
  scrollTop: 0,
});

test('deep tree construction reads parent edges a bounded number of times and keeps sibling order', () => {
  let reads = 0;
  const issues = Array.from({ length: 2001 }, (_, i) => {
    const value = issue(i);
    const parentKey = value.parentKey;
    Object.defineProperty(value, 'parentKey', {
      get: () => {
        reads++;
        return parentKey;
      },
    });
    return value;
  });
  const tree = buildIssueTree(issues, 'TEST-0')!;
  assert.ok(reads < issues.length * 8, `${reads} parent reads`);
  assert.equal(
    flattenVisible(tree, new Set(issues.map((x) => x.key))).length,
    issues.length,
  );
  const wide = buildIssueTree(
    [issue(0), ...[3, 1, 2].map((i) => ({ ...issue(i), parentKey: 'TEST-0' }))],
    'TEST-0',
  )!;
  assert.deepEqual(
    wide.children.map((x) => x.issue.key),
    ['TEST-3', 'TEST-1', 'TEST-2'],
  );
  assert.equal(
    filterTree(wide, 'Issue 2', {}, true)!.children[0].issue.key,
    'TEST-2',
  );
});

test('cycle members detach while descendants entering a cycle retain their parent edge', () => {
  const a = { ...issue(0), parentKey: 'TEST-1' };
  const b = { ...issue(1), parentKey: 'TEST-0' };
  const c = { ...issue(2), parentKey: 'TEST-0' };
  assert.deepEqual(
    buildIssueTree([a, b, c], a.key)!.children.map((x) => x.issue.key),
    [c.key],
  );
});

for (const kind of ['jira', 'github'] as const) {
  test(`${kind} publishes pages before completion and cancels within bounded transport calls`, async () => {
    const fixture = largeProvider(kind, 'wide', 501);
    const controller = new AbortController();
    const progress: TreeSnapshot[] = [];
    fixture.onCall(() => {
      if (fixture.calls() === 3) controller.abort();
    });
    const partial = await fixture.provider.tree(fixture.rootKey, {
      signal: controller.signal,
      progress: (next) => progress.push(structuredClone(next)),
    });
    assert.ok(progress.length > 0);
    assert.equal(progress[0].issues.length, 1);
    assert.ok(partial.issues.length > 1 && partial.issues.length < 501);
    assert.match(partial.incomplete!.reason, /cancelled/);
    assert.equal(partial.ranking!.state, 'unknown');
    assert.equal(fixture.calls(), 3);
    controller.abort();
    const stopped = largeProvider(kind, 'wide', 501);
    await assert.rejects(
      stopped.provider.tree(stopped.rootKey, { signal: controller.signal }),
      /abort|cancel/i,
    );
    assert.equal(stopped.calls(), 0);
  });
  test(`${kind} preserves readable partial data on offline failure and retries to a complete tree`, async () => {
    const fixture = largeProvider(kind, 'wide', 501);
    fixture.fail(3);
    const partial = await fixture.provider.tree(fixture.rootKey, {
      allowPartial: true,
    });
    assert.ok(partial.issues.length > 1);
    assert.match(partial.incomplete!.reason, /Offline/);
    fixture.fail(Infinity);
    const full = await fixture.provider.tree(fixture.rootKey, {
      allowPartial: true,
    });
    assert.equal(full.incomplete, undefined);
    assert.equal(full.issues.length, 501);
  });
  test(`${kind} bounds issue and call budgets without presenting partial results as complete`, async () => {
    const fixture = largeProvider(kind, 'wide', 501);
    const limited = await fixture.provider.tree(fixture.rootKey, {
      allowPartial: true,
      maxIssues: 150,
    });
    assert.equal(limited.issues.length, 150);
    assert.match(limited.incomplete!.reason, /issue budget/);
    const deep = largeProvider(kind, 'deep', 50);
    const bounded = await deep.provider.tree(deep.rootKey, {
      allowPartial: true,
      maxCalls: 10,
    });
    assert.equal(deep.calls(), 10);
    assert.match(bounded.incomplete!.reason, /request budget/);
  });
}

test('partial refresh retains cached descendants and their unread differences', () => {
  let view!: MutationView;
  const mutations = new Mutations(
    {} as CanopyAPI,
    (next) => {
      view = next;
    },
    () => {},
  );
  const original = snapshot([issue(0), issue(1)]);
  const seen = markRootSeen(original);
  mutations.receive(tab('one'), original, 0);
  const changed = { ...issue(1), summary: 'Remote change' };
  mutations.receive(tab('one'), snapshot([issue(0), changed]), 0);
  mutations.receive(
    tab('one'),
    { ...snapshot([issue(0)]), incomplete: { reason: 'Offline', calls: 2 } },
    0,
  );
  assert.equal(view.snapshots.one.issues.length, 2);
  assert.equal(
    unseenChanges(seen.issues[changed.key], view.snapshots.one.issues[1]).fields
      .length,
    1,
  );
});

test('snapshot pressure releases inactive owners while protecting active drafts and pending writes', async () => {
  let view!: MutationView;
  let resolve!: (value: Issue) => void;
  const api = {
    update: () =>
      new Promise<Issue>((r) => {
        resolve = r;
      }),
  } as unknown as CanopyAPI;
  const first = snapshot([issue(0)]);
  const bytes = new TextEncoder().encode(JSON.stringify(first)).byteLength;
  const mutations = new Mutations(
    api,
    (next) => {
      view = next;
    },
    () => {},
    undefined,
    bytes * 2 + 10,
  );
  mutations.protectSnapshots(['draft']);
  mutations.receive(tab('draft'), first, 0);
  mutations.receive(tab('writing'), first, 0);
  const write = mutations.update('writing', 'TEST-0', { summary: 'Saved' });
  await Promise.resolve();
  mutations.receive(tab('inactive'), first, 0);
  assert.ok(view.snapshots.draft);
  assert.ok(view.snapshots.writing);
  assert.ok(view.evicted.has('inactive'));
  resolve({ ...issue(0), summary: 'Saved' });
  await write;
  mutations.protectSnapshots([]);
  mutations.receive(tab('new'), first, 0);
  assert.ok(Object.keys(view.snapshots).length <= 2);
});

test('baseline admission pressure keeps existing unread roots and issues', () => {
  const roots = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      String(i),
      markRootSeen(snapshot([issue(0)])),
    ]),
  );
  const proposed = { ...roots, extra: markRootSeen(snapshot([issue(1)])) };
  const retained = boundRoots(proposed, roots);
  assert.deepEqual(Object.keys(retained), Object.keys(roots));
  const thousand = markRootSeen(
    snapshot(Array.from({ length: 1000 }, (_, i) => issue(i))),
  );
  const incoming = markRootSeen(
    snapshot(Array.from({ length: 1000 }, (_, i) => issue(i + 1000))),
    thousand,
  );
  const bounded = boundRoots({ one: incoming }, { one: thousand });
  assert.deepEqual(
    Object.keys(bounded.one.issues),
    Object.keys(thousand.issues),
  );
  assert.equal(
    unseenChanges(bounded.one.issues['TEST-0'], {
      ...issue(0),
      summary: 'Changed',
    }).fields.length,
    1,
  );
});

test('undo history keeps recent edits and protects an open bulk session token', async () => {
  const api = {
    update: async (_id: string, key: string, patch: { summary?: string }) => ({
      ...issue(Number(key.split('-')[1])),
      summary: patch.summary ?? key,
    }),
  } as unknown as CanopyAPI;
  const mutations = new Mutations(
    api,
    () => {},
    () => {},
  );
  mutations.receive(
    tab('one'),
    snapshot(Array.from({ length: 122 }, (_, i) => issue(i))),
    0,
  );
  const token = Symbol('open bulk session');
  await mutations.update(
    'one',
    'TEST-0',
    { summary: 'Bulk draft' },
    undefined,
    true,
    token,
  );
  for (let i = 1; i <= 121; i++)
    await mutations.update('one', `TEST-${i}`, { summary: 'Edited' });
  assert.ok(mutations.canUndo('one', 'TEST-0', token));
  assert.equal(mutations.canUndo('one', 'TEST-1'), false);
  assert.ok(mutations.canUndo('one', 'TEST-121'));
  mutations.discardHistory(token);
  assert.equal(mutations.canUndo('one', 'TEST-0', token), false);
});

for (const kind of ['jira', 'github'] as const) {
  test(`${kind} real authenticated request code retains partial reads, blocks cooldown calls and recovers`, async () => {
    const { Auth } = await import('../src/main/auth');
    const { JiraProvider } = await import('../src/main/jira');
    const { GithubProvider } = await import('../src/main/github');
    const fixture = largeProvider(kind, 'wide', 501);
    const connection = {
      id: kind,
      provider: kind,
      name: 'Isolated performance fixture',
      url: 'https://fixture.atlassian.net',
      repositories: [fixture.repository],
    };
    const store = {
      readSecrets: async () => ({
        grants: [],
        accounts:
          kind === 'jira'
            ? [
                {
                  connection,
                  email: 'fixture@example.invalid',
                  token: 'fixture-only',
                  apiBase: 'https://fixture.atlassian.net',
                },
              ]
            : [],
        githubAccounts:
          kind === 'github' ? [{ connection, token: 'fixture-only' }] : [],
      }),
    };
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let now = originalNow();
    let calls = 0;
    let throttled = true;
    Date.now = () => now;
    const auth = new Auth(
      store as unknown as import('../src/main/storage').Storage,
      async () => {},
    );
    await auth.load();
    globalThis.fetch = async (url, init) => {
      calls++;
      if (throttled && calls === 3)
        return new Response('{"message":"rate limit"}', {
          status: 429,
          headers: { 'retry-after': '2' },
        });
      const parsed = new URL(String(url));
      return Response.json(
        await fixture.request(parsed.pathname + parsed.search, init),
      );
    };
    try {
      const provider =
        kind === 'jira'
          ? new JiraProvider((path, init) => auth.request(kind, path, init))
          : new GithubProvider(connection, (path, init) =>
              auth.githubRequest(kind, path, init),
            );
      const partial = await provider.tree(fixture.rootKey, {
        allowPartial: true,
      });
      assert.ok(partial.issues.length > 1);
      assert.match(partial.incomplete!.reason, /rate limit/);
      assert.equal(calls, 3);
      const status =
        kind === 'jira' ? auth.syncStatus(kind) : auth.githubSyncStatus(kind);
      assert.equal(status.retryAt, now + 2000);
      await assert.rejects(
        provider.tree(fixture.rootKey, { allowPartial: true }),
        /rate limit/,
      );
      assert.equal(calls, 3);
      now += 2001;
      throttled = false;
      const recovered = await provider.tree(fixture.rootKey, {
        allowPartial: true,
      });
      assert.equal(recovered.incomplete, undefined);
      assert.equal(recovered.issues.length, 501);
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
  });
}

test('baseline admission bounds actual UTF-8 bytes while retaining known unread fields', () => {
  const baseline = markRootSeen(snapshot([issue(0)]));
  let roots = { known: baseline };
  for (let i = 0; i < 12; i++) {
    const next = markRootSeen(
      snapshot(
        Array.from({ length: 1000 }, (_, n) => ({
          ...issue(n),
          summary: '界'.repeat(300),
        })),
      ),
    );
    roots = boundRoots({ ...roots, [`new-${i}`]: next }, roots) as typeof roots;
  }
  assert.ok(
    new TextEncoder().encode(JSON.stringify(roots)).byteLength <= 2_000_000,
  );
  assert.equal(roots.known.issues['TEST-0'].fields.Summary, 'Issue 0');
});

test('undo retention respects the byte budget for realistic Unicode issue summaries', async () => {
  const issues = Array.from({ length: 80 }, (_, i) => ({
    ...issue(i),
    summary: '界'.repeat(10000),
  }));
  const mutations = new Mutations(
    {
      update: async (_id: string, key: string) => ({
        ...issue(Number(key.split('-')[1])),
        summary: 'Edited',
      }),
    } as unknown as CanopyAPI,
    () => {},
    () => {},
  );
  mutations.receive(tab('one'), snapshot(issues), 0);
  for (const value of issues)
    await mutations.update('one', value.key, { summary: 'Edited' });
  assert.equal(mutations.canUndo('one', issues[0].key), false);
  assert.ok(mutations.canUndo('one', issues.at(-1)!.key));
});
