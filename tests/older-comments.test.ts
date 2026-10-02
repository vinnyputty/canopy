import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OlderComments, mergeComments } from '../src/renderer/older-comments';
import type { CommentPage } from '../src/shared/types';
const comment = (id: number, body = String(id)) => ({
  id: String(id),
  body,
  author: 'tester',
  created: '2026-01-01T00:00:00Z',
});

test('older pages retain chronological ordering, unique IDs, recent copies, and retryable cursor', async () => {
  let fail = true;
  const calls: number[] = [];
  const loader = new OlderComments(
    {
      olderComments: async (_connection, _key, page) => {
        calls.push(page);
        if (fail) throw new Error('offline');
        return page === 2
          ? {
              comments: [comment(101), comment(201, 'shifted')],
              start: 101,
              end: 200,
              olderPage: 1,
            }
          : {
              comments: [comment(1), comment(101, 'shifted')],
              start: 1,
              end: 100,
            };
      },
    },
    () => {},
  );
  const recent = [comment(201, 'recent')];
  loader.reset('github', 'team/a#1', { start: 201, end: 205, olderPage: 2 });
  await loader.load();
  assert.equal(loader.state.error, 'offline');
  assert.equal(loader.state.olderPage, 2);
  assert.deepEqual(loader.state.comments, []);
  fail = false;
  await loader.load();
  await loader.load();
  assert.deepEqual(calls, [2, 2, 1]);
  assert.equal(loader.state.start, 1);
  assert.equal(loader.state.olderPage, undefined);
  assert.deepEqual(mergeComments(loader.state.comments, recent), [
    comment(1),
    comment(101),
    comment(201, 'recent'),
  ]);
  assert.deepEqual(recent, [comment(201, 'recent')]);
});

test('held older responses and errors cannot cross preview identity, retry, or close boundaries', async () => {
  const pending: {
    resolve: (page: CommentPage) => void;
    reject: (error: Error) => void;
  }[] = [];
  const loader = new OlderComments(
    {
      olderComments: async () =>
        new Promise((resolve, reject) => pending.push({ resolve, reject })),
    },
    () => {},
  );
  loader.reset('github-a', 'team/a#1', { start: 201, end: 205, olderPage: 2 });
  const old = loader.load();
  await loader.load();
  assert.equal(pending.length, 1);
  loader.reset('github-b', 'team/a#1', { start: 101, end: 105, olderPage: 1 });
  pending[0].resolve({
    comments: [comment(101)],
    start: 101,
    end: 200,
    olderPage: 1,
  });
  await old;
  assert.deepEqual(loader.state.comments, []);
  assert.equal(loader.state.start, 101);
  const retry = loader.load();
  loader.reset();
  pending[1].reject(new Error('stale failure'));
  await retry;
  assert.equal(loader.state.error, '');
  assert.equal(loader.state.loading, false);
});

test('an empty newest page still allows older comment ranges to load', async () => {
  const loader = new OlderComments(
    {
      olderComments: async () => ({
        comments: [comment(101)],
        start: 101,
        end: 101,
        olderPage: 1,
      }),
    },
    () => {},
  );
  loader.reset('github', 'team/a#1', { start: 0, end: 0, olderPage: 2 });
  await loader.load();
  assert.equal(loader.state.start, 101);
  assert.equal(loader.state.end, 101);
  assert.equal(loader.state.olderPage, 1);
});

test('retrying the same preview or selecting another issue discards held older pages', async () => {
  let resolve!: (page: CommentPage) => void;
  const loader = new OlderComments(
    {
      olderComments: async () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
    () => {},
  );
  for (const destination of ['team/a#1', 'team/b#2']) {
    loader.reset('github', 'team/a#1', { start: 201, end: 205, olderPage: 2 });
    const held = loader.load();
    loader.reset('github', destination, { start: 101, end: 105, olderPage: 1 });
    resolve({ comments: [comment(1)], start: 1, end: 100 });
    await held;
    assert.deepEqual(loader.state.comments, []);
    assert.equal(loader.state.olderPage, 1);
    assert.equal(loader.state.start, 101);
  }
});
