import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IssueSearch, rankSearchIssues } from '../src/renderer/issue-search';
import { demoSeeds } from './fixtures/demo';
import type { SearchPage } from '../src/shared/types';

const issue = (key: string, summary: string, updated = '') => ({
  ...demoSeeds[0],
  key,
  summary,
  updated,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
test('summary relevance precedes project context and recency, with stable deduplication', () => {
  const ranked = rankSearchIssues(
    [
      issue('CAN-1', 'Platform work', '2025-01-01'),
      issue('OTH-1', 'Platf', '2020-01-01'),
      issue('CAN-2', 'Platform', '2026-01-01'),
      issue('CAN-3', 'Add platform', '2026-02-01'),
      issue('OTH-2', 'Platform', '2026-03-01'),
      issue('CAN-2', 'Platform', '2026-01-01'),
    ],
    'platf',
    'CAN',
  );
  assert.deepEqual(
    ranked.map((i) => i.key),
    ['OTH-1', 'CAN-2', 'CAN-1', 'OTH-2', 'CAN-3'],
  );
});
test('obsolete responses and errors cannot replace a current query, even if cancellation is ignored', async () => {
  const pending: {
    resolve: (page: SearchPage) => void;
    reject: (error: Error) => void;
    id: string;
  }[] = [];
  const canceled: string[] = [];
  const search = new IssueSearch(
    {
      search: async (_id, _query, options) =>
        new Promise((resolve, reject) =>
          pending.push({ resolve, reject, id: options.requestId }),
        ),
      cancelSearch: async (_id, id) => {
        canceled.push(id);
      },
    },
    () => {},
    0,
  );
  search.start('site', 'old');
  await tick();
  search.start('site', 'new');
  await tick();
  pending[1].resolve({ issues: [issue('NEW-1', 'new')] });
  await tick();
  pending[0].resolve({ issues: [issue('OLD-1', 'old')] });
  await tick();
  assert.deepEqual(
    search.state.issues.map((i) => i.key),
    ['NEW-1'],
  );
  assert.deepEqual(canceled, [pending[0].id]);
  search.start('site', 'older');
  await tick();
  search.start('other-site', 'newest');
  await tick();
  pending[3].resolve({ issues: [] });
  await tick();
  pending[2].reject(new Error('obsolete'));
  await tick();
  assert.equal(search.state.error, '');
  assert.equal(search.state.searched, true);
  assert.deepEqual(search.state.issues, []);
  search.cancel();
});
test('pagination is on demand, retries keep loaded results, later exact matches move ahead', async () => {
  const tokens: (string | undefined)[] = [];
  let fail = true;
  const search = new IssueSearch(
    {
      search: async (_id, _query, options) => {
        tokens.push(options.nextPageToken);
        if (!options.nextPageToken)
          return {
            issues: [issue('CAN-1', 'Add dinghy')],
            nextPageToken: 'more',
          };
        if (fail) {
          fail = false;
          throw new Error('temporary');
        }
        return { issues: [issue('CAN-2', 'Dinghy')] };
      },
      cancelSearch: async () => {},
    },
    () => {},
    0,
  );
  search.start('site', 'dinghy');
  await tick();
  assert.deepEqual(tokens, [undefined]);
  await search.load();
  assert.equal(search.state.error, 'temporary');
  assert.equal(search.state.issues.length, 1);
  await search.load();
  assert.deepEqual(tokens, [undefined, 'more', 'more']);
  assert.deepEqual(
    search.state.issues.map((i) => i.key),
    ['CAN-2', 'CAN-1'],
  );
  assert.equal(search.state.nextPageToken, undefined);
  assert.equal(search.state.error, '');
  search.cancel();
});
test('closing during debounce avoids a request; initial errors are retryable', async () => {
  let calls = 0;
  const search = new IssueSearch(
    {
      search: async () => {
        calls++;
        if (calls === 1) throw new Error('offline');
        return { issues: [] };
      },
      cancelSearch: async () => {},
    },
    () => {},
    0,
  );
  search.start('site', 'query');
  search.cancel();
  await tick();
  assert.equal(calls, 0);
  search.start('site', 'query');
  await tick();
  assert.equal(search.state.error, 'offline');
  await search.load();
  assert.equal(search.state.error, '');
  assert.equal(search.state.searched, true);
  search.cancel();
});
