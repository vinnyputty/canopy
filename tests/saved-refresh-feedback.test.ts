import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RefreshStatus } from '../src/renderer/RefreshStatus';
import { SavedViewsPanel } from '../src/renderer/SavedViewsPanel';
import {
  sourceTabId,
  starterViews,
  viewSources,
} from '../src/renderer/saved-views';
import {
  RefreshAnnouncements,
  refreshDestination,
  type RefreshAnnouncement,
  type RefreshView,
} from '../src/renderer/refresh';
import type { TreeSnapshot, TabState } from '../src/shared/types';

const tree = (
  fetchedAt: number,
  rootKey = 'CAN-100',
  warnings: string[] = [],
): TreeSnapshot => ({ rootKey, fetchedAt, issues: [], warnings });
const view: RefreshView = {
  name: 'Sample view',
  roots: [
    { id: 'root100', label: 'CAN-100', tabIds: ['a', 'alias'] },
    { id: 'root200', label: 'CAN-200', tabIds: ['saved-view:virtual'] },
  ],
};
const setup = () => {
  const messages: RefreshAnnouncement[] = [];
  const feedback = new RefreshAnnouncements((message) =>
    messages.push(message),
  );
  const owner = refreshDestination('a', 'view-a');
  feedback.activate(owner, view);
  const markup = () =>
    renderToStaticMarkup(
      React.createElement(RefreshStatus, {
        message: messages.at(-1) ?? null,
        owner,
        scope: feedback.scope,
      }),
    );
  return { feedback, messages, owner, markup };
};

it('invalidates completed, pending and failed outgoing tree feedback through a saved view with the same retained tree id', () => {
  for (const settle of ['complete', 'pending', 'error']) {
    const messages: RefreshAnnouncement[] = [];
    const f = new RefreshAnnouncements((message) => messages.push(message));
    f.activate(refreshDestination('a'));
    f.request('a');
    const request = f.begin('a', 'CAN-100', tree(1));
    const oldScope = f.scope;
    f.activate(refreshDestination('a', 'view-a'), view);
    if (settle === 'complete') f.complete(request, tree(2));
    if (settle === 'error') f.fail(request, 'CAN-100', 'Late tree error');
    f.activate(refreshDestination('a'));
    assert.notEqual(f.scope, oldScope);
    const markup = () =>
      renderToStaticMarkup(
        React.createElement(RefreshStatus, {
          message: messages.at(-1)!,
          owner: 'a',
          scope: f.scope,
        }),
      );
    assert.doesNotMatch(markup(), /Checking|last updated|Late tree error/);
    if (settle === 'pending') {
      f.complete(request, tree(2));
      assert.doesNotMatch(markup(), /Checking|last updated/);
    }
    assert.equal(messages.length, 1);
  }
});

it('exposes held progress then aggregate success/partial failure through the actual saved-view consumer', () => {
  const { feedback: f, messages, owner, markup } = setup();
  assert.equal(f.requestView(), true);
  assert.match(
    markup(),
    /Waiting to refresh Sample view: 2 of 2 roots pending/,
  );
  assert.equal(f.requestView(), false); // Coalesce while requested work is pending.
  f.request('a');
  f.request('saved-view:virtual');
  const a = f.begin('a', 'CAN-100', tree(1));
  const b = f.begin('saved-view:virtual', 'CAN-200', tree(1, 'CAN-200'));
  assert.match(markup(), /Refreshing Sample view: 2 of 2 roots pending/);
  f.complete(a, tree(2, 'CAN-100', ['Linked issues unavailable']));
  assert.match(markup(), /1 of 2 roots pending/);
  assert.match(markup(), /partial results.*Linked issues unavailable/);
  f.fail(b, 'CAN-200', 'Offline');
  assert.match(
    markup(),
    /refreshed 1 of 2 roots.*1 roots failed.*Offline.*issues retained/,
  );
  assert.match(markup(), /1 roots returned partial results/);
  assert.equal(messages.at(-1)?.tabId, owner);
  const saved = starterViews()[0];
  const panel = renderToStaticMarkup(
    React.createElement(SavedViewsPanel, {
      view: saved,
      refreshStatusId: 'refresh-status',
      connections: [],
      availableRoots: [],
      sources: [],
      results: [],
      selected: null,
      errors: {},
      identityErrors: {},
      loading: new Set<string>(),
      onSelect() {},
      onOpen() {},
      onChange() {},
      onDelete() {},
      onRefresh() {},
    }),
  );
  assert.match(panel, /aria-describedby="refresh-status"/);
  assert.match(
    markup(),
    /id="refresh-status".*role="status".*aria-atomic="true"/,
  );
  assert.equal(f.requestView(), true);
  f.request('a');
  f.request('saved-view:virtual');
  const retryA = f.begin('a', 'CAN-100', tree(2));
  const retryB = f.begin('saved-view:virtual', 'CAN-200', tree(1, 'CAN-200'));
  f.complete(retryA, tree(3));
  f.complete(retryB, tree(3, 'CAN-200'));
  assert.match(markup(), /refreshed 2 of 2 roots/);
  assert.doesNotMatch(markup(), /failed|partial results/);
});

it('keeps offline/editor-deferred and poll-overlapped view requests pending until their manual reads settle', () => {
  const { feedback: f, messages, markup } = setup();
  const poll = f.begin('a', 'CAN-100', tree(1));
  f.requestView();
  f.request('a');
  f.request('saved-view:virtual');
  // No begin while offline or editor-blocked: publication remains truthful waiting.
  assert.match(markup(), /2 waiting to start/);
  f.complete(poll, tree(2));
  assert.match(markup(), /2 waiting to start/);
  const a = f.begin('a', 'CAN-100', tree(2));
  assert.match(markup(), /1 waiting to start/);
  const b = f.begin('saved-view:virtual', 'CAN-200', tree(1, 'CAN-200'));
  const heldCount = messages.length;
  f.fail(poll, 'CAN-100', 'Obsolete poll');
  f.end(poll);
  assert.equal(messages.length, heldCount);
  f.complete(a, tree(3));
  assert.match(markup(), /1 of 2 roots pending/);
  f.complete(b, tree(3, 'CAN-200'));
  assert.match(markup(), /refreshed 2 of 2 roots/);
});

it('batches meaningful automatic changes/failure/recovery and keeps unchanged, unrelated and old-scope alias deliveries quiet', () => {
  const { feedback: f, messages, markup } = setup();
  let a = f.begin('a', 'CAN-100', tree(1));
  let b = f.begin('saved-view:virtual', 'CAN-200', tree(1, 'CAN-200'));
  f.complete(a, tree(2));
  f.complete(b, tree(2, 'CAN-200'));
  assert.equal(messages.length, 0);
  const unrelated = f.begin('other', 'CAN-300', tree(1, 'CAN-300'));
  f.fail(unrelated, 'CAN-300', 'Unrelated error');
  assert.equal(messages.length, 0);
  a = f.begin('a', 'CAN-100', tree(2));
  b = f.begin('saved-view:virtual', 'CAN-200', tree(2, 'CAN-200'));
  f.complete(a, tree(3, 'CAN-100', ['Partial']));
  assert.equal(messages.length, 0); // Another visible source remains held.
  f.fail(b, 'CAN-200', 'Sample error');
  assert.equal(messages.length, 1);
  assert.match(markup(), /Changes found across 2 roots.*Sample error.*Partial/);
  a = f.begin('a', 'CAN-100', tree(3, 'CAN-100', ['Partial']));
  b = f.begin('saved-view:virtual', 'CAN-200', tree(2, 'CAN-200'));
  f.complete(a, tree(4, 'CAN-100', ['Partial']));
  f.complete(b, tree(4, 'CAN-200'));
  assert.match(markup(), /Refresh recovered across 1 roots/);
  assert.doesNotMatch(markup(), /Sample error/);
  const count = messages.length;
  f.receive(
    'alias',
    tree(5, 'CAN-100', ['Partial']),
    tree(4, 'CAN-100', ['Partial']),
  );
  assert.equal(messages.length, count);
  f.receive(
    'alias',
    tree(6, 'CAN-100', ['New partial']),
    tree(5, 'CAN-100', ['Partial']),
    f.scope - 1,
  );
  assert.equal(messages.length, count);
});

it('separates view A and B ownership even when they share a root and ignores late background completion/error', () => {
  const { feedback: f, messages, owner } = setup();
  f.requestView();
  f.request('a');
  f.request('saved-view:virtual');
  const a = f.begin('a', 'CAN-100', tree(1));
  const virtual = f.begin('saved-view:virtual', 'CAN-200', tree(1, 'CAN-200'));
  f.activate(refreshDestination('a', 'view-b'), {
    name: 'Other view',
    roots: [view.roots[0]],
  });
  f.requestView();
  assert.equal(f.request('a'), true); // New destination owns deferred intent, even behind an old manual read.
  const count = messages.length;
  f.complete(a, tree(2));
  f.fail(virtual, 'CAN-200', 'Late A failure');
  assert.equal(messages.length, count);
  const current = f.begin('a', 'CAN-100', tree(2));
  f.complete(current, tree(3));
  assert.match(messages.at(-1)!.text, /Other view: refreshed 1 of 1 roots/);
  f.activate(owner, view);
  const returned = renderToStaticMarkup(
    React.createElement(RefreshStatus, {
      message: messages.at(-1)!,
      owner,
      scope: f.scope,
    }),
  );
  assert.doesNotMatch(returned, /Other view|Late A failure|Refreshing/);
});

it('reports interruption and no-source requests without inventing successful delivery', () => {
  const { feedback: f, messages, markup } = setup();
  f.requestView();
  f.request('a');
  f.request('saved-view:virtual');
  const a = f.begin('a', 'CAN-100', tree(1));
  f.end(a);
  f.forget('saved-view:virtual');
  assert.match(markup(), /refreshed 0 of 2 roots.*2 roots failed.*interrupted/);
  f.activate(refreshDestination('a', 'empty'), {
    name: 'Empty view',
    roots: [],
  });
  assert.equal(f.requestView(), true);
  assert.match(
    messages.at(-1)!.text,
    /Empty view: no roots selected to refresh/,
  );
  assert.doesNotMatch(messages.at(-1)!.text, /refreshed|pending/);
});

it('uses actual SavedViews root resolution for virtual/shared sources and wires App to a single consumer outside conditional destinations', () => {
  const selected = {
    ...starterViews()[0],
    roots: [
      { connectionId: 'demo', rootKey: 'CAN-100' },
      { connectionId: 'demo', rootKey: 'CAN-200' },
    ],
  };
  const sources = viewSources(selected, []);
  const tabs: TabState[] = [
    {
      id: 'a',
      connectionId: 'demo',
      rootKey: 'CAN-100',
      expanded: [],
      hideDone: false,
      scrollTop: 0,
    },
  ];
  assert.equal(sourceTabId(sources[0], tabs), 'a');
  assert.equal(sourceTabId(sources[1], tabs), sources[1].id);
  const app = readFileSync(
    new URL('../src/renderer/App.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    app,
    /refreshDestination\(\s*workspace.activeTabId,\s*activeSavedView\?\.id/,
  );
  assert.equal((app.match(/<RefreshStatus\b/g) ?? []).length, 1);
  assert.ok(
    app.indexOf('<RefreshStatus') < app.indexOf('{activeSavedView && ('),
  );
  assert.match(app, /refreshStatusId="refresh-status"/);
  assert.match(app, /if \(!refreshAnnouncements.requestView\(\)\) return/);
  assert.match(app, /previous,\s*announcement.scope/);
});
