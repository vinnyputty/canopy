import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InboxPanel } from '../src/renderer/InboxPanel';
import { SavedViewsPanel } from '../src/renderer/SavedViewsPanel';
import { BulkTriage } from '../src/renderer/BulkTriage';
import type { InboxInspection } from '../src/renderer/inbox';
import type { Issue, Workspace } from '../src/shared/types';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const connection = {
  id: 'work',
  name: 'Work account',
  provider: 'jira' as const,
  url: 'https://example.invalid',
};
const source = { id: 'root', connectionId: 'work', rootKey: 'A-1' };
const issue = (key: string, review = false): Issue => ({
  id: key,
  key,
  summary: `Readable title ${key}`,
  type: 'Task',
  priority: null,
  assignee: review ? null : { id: 'me', name: 'Me' },
  status: {
    id: review ? 'review' : 'open',
    name: review ? 'Review' : 'Open',
    category: 'new',
  },
  links: [],
});
const initial: Workspace = {
  tabs: [],
  activeTabId: null,
  shortcuts: {},
  theme: 'light',
  sidebarCollapsed: false,
  triage: {
    version: 1,
    items: [],
    history: [],
    reviewStatuses: { work: ['Review'] },
  },
};

test('inbox filters preserve local actions and recover focus only when the action removes its row', async () => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>', {
    url: 'https://fixture.example',
    pretendToBeVisual: true,
  });
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom.window,
    navigator: dom.window.navigator,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const host = dom.window.document.querySelector('#host') as HTMLDivElement;
  const root = createRoot(host);
  let workspace = initial;
  let snapshots = {
    root: {
      rootKey: 'A-1',
      fetchedAt: Date.now(),
      warnings: [],
      issues: [issue('A-1'), issue('A-2', true)],
    },
  };
  let loading = new Set<string>();
  let errors = {};
  let sources = [source];
  let opened = '';
  let focusRefresh = false;
  const inspection = {
    reset() {},
    cancel() {},
    async load() {},
  } as unknown as InboxInspection;
  const render = () =>
    root.render(
      React.createElement(InboxPanel, {
        workspace,
        inspection,
        graphs: {},
        busy: false,
        connections: [connection],
        sources,
        totalRoots: 1,
        snapshots,
        errors,
        identityErrors: {},
        users: { work: { id: 'me' } },
        loading,
        now: Date.now(),
        onChange(update) {
          workspace = update(workspace);
          if (focusRefresh)
            host
              .querySelector<HTMLButtonElement>('.saved-view-header button')!
              .focus();
          render();
        },
        onSeen() {},
        onOpen(item) {
          opened = item.issue.key;
        },
        onRefresh() {},
        onMoreRoots() {},
      }),
    );
  const button = (name: string) => {
    const node = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent?.trim() === name,
    );
    assert.ok(node, name);
    return node;
  };
  const choose = async (value: string) => {
    const select = host.querySelector<HTMLSelectElement>(
      '.inbox-filters select',
    )!;
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
  };
  try {
    await act(async () => render());
    assert.equal(host.querySelectorAll('.inbox-item').length, 2);
    await choose('Assigned to you');
    assert.equal(host.querySelectorAll('.inbox-item').length, 1);
    await act(async () => button('A-1 Readable title A-1').click());
    assert.equal(opened, 'A-1');
    const pin = button('Pin');
    pin.focus();
    await act(async () => pin.click());
    assert.equal(workspace.triage?.items[0].pinned, true);
    assert.equal(dom.window.document.activeElement, button('Unpin'));
    await act(async () => button('Unpin').click());
    assert.equal(workspace.triage?.items.length, 0);
    const snooze = host.querySelector<HTMLSelectElement>(
      '[aria-label="Snooze A-1"]',
    )!;
    snooze.focus();
    await act(async () => {
      snooze.value = '3600000';
      snooze.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.ok(workspace.triage?.items[0].snoozedUntil);
    assert.equal(host.querySelectorAll('.inbox-item').length, 0);
    assert.equal(
      dom.window.document.activeElement,
      host.querySelector('.inbox-filters select'),
    );
    assert.match(
      host.querySelector('.inbox-empty')!.textContent!,
      /No items match these filters/,
    );
    const show = host.querySelector<HTMLInputElement>('.inbox-filters input')!;
    await act(async () => show.click());
    assert.equal(host.querySelectorAll('.inbox-item').length, 1);
    await act(async () => button('Wake now').click());
    assert.equal(workspace.triage?.items.length, 0);
    await act(async () => show.click());
    const secondSnooze = host.querySelector<HTMLSelectElement>(
      '[aria-label="Snooze A-1"]',
    )!;
    secondSnooze.focus();
    focusRefresh = true;
    await act(async () => {
      secondSnooze.value = '3600000';
      secondSnooze.dispatchEvent(
        new dom.window.Event('change', { bubbles: true }),
      );
    });
    assert.equal(
      dom.window.document.activeElement,
      host.querySelector('.saved-view-header button'),
    );
    focusRefresh = false;
    await choose('Review:');
    assert.match(host.querySelector('.inbox-item')!.textContent!, /A-2/);
    await choose('Pinned locally');
    assert.equal(host.querySelectorAll('.inbox-item').length, 0);
    await choose('');
    snapshots = { root: { ...snapshots.root, issues: [] } };
    loading = new Set(['root']);
    await act(async () => render());
    assert.match(
      host.querySelector('.inbox-empty')!.textContent!,
      /Loading your inbox/,
    );
    loading = new Set();
    errors = { root: 'Offline' };
    await act(async () => render());
    assert.match(
      host.querySelector('.inbox-empty')!.textContent!,
      /No attention items in available data/,
    );
    assert.match(
      host.querySelector('.inbox-overview')!.textContent!,
      /Coverage incomplete/,
    );
    errors = {};
    await act(async () => render());
    assert.match(
      host.querySelector('.inbox-empty')!.textContent!,
      /caught up in loaded roots/,
    );
    sources = [];
    await act(async () => render());
    assert.match(
      host.querySelector('.inbox-empty')!.textContent!,
      /Choose roots for your inbox/,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('inbox source lines name providers and retain identity when account names are missing', () => {
  for (const [provider, label, name] of [
    ['github', 'GitHub', 'Work account'],
    ['jira', 'Jira', 'Work account'],
    ['demo', 'Demo', 'Work account'],
    ['other', 'Unknown provider', 'Work account'],
    ['jira', 'Jira', undefined],
  ] as const) {
    const html = renderToStaticMarkup(
      React.createElement(InboxPanel, {
        workspace: initial,
        inspection: {} as InboxInspection,
        graphs: {},
        busy: false,
        connections: [{ ...connection, provider, name } as typeof connection],
        sources: [
          source,
          { id: 'missing', connectionId: 'missing', rootKey: 'M-1' },
        ],
        totalRoots: 2,
        snapshots: {
          root: {
            rootKey: 'A-1',
            fetchedAt: 1,
            warnings: [],
            issues: [issue('A-1')],
          },
          missing: {
            rootKey: 'M-1',
            fetchedAt: 1,
            warnings: [],
            issues: [issue('M-1')],
          },
        },
        errors: {},
        identityErrors: {},
        users: { work: { id: 'me' } },
        loading: new Set<string>(),
        now: 1,
        onChange() {},
        onSeen() {},
        onOpen() {},
        onRefresh() {},
        onMoreRoots() {},
      }),
    );
    const document = new JSDOM(html).window.document;
    const sources = document.querySelectorAll('.inbox-source');
    assert.equal(sources.length, 1);
    assert.equal(
      sources[0].textContent,
      `${label} · ${name ?? 'work'} · work · roots: A-1`,
    );
    assert.doesNotMatch(
      document.querySelector('.inbox-items')!.textContent!,
      /M-1/,
    );
  }
});

test('saved views expose active filters, provider context and partial-result guidance', () => {
  const github = {
    ...connection,
    id: 'github',
    name: 'Engineering',
    provider: 'github' as const,
  };
  const githubSource = {
    id: 'repo',
    connectionId: 'github',
    rootKey: 'org/repo',
  };
  const demo = {
    ...connection,
    id: 'demo',
    name: 'Sample workspace',
    provider: 'demo' as const,
  };
  const demoSource = {
    id: 'demo-root',
    connectionId: 'demo',
    rootKey: 'DEMO-1',
  };
  const missingSource = {
    id: 'missing-root',
    connectionId: 'missing',
    rootKey: 'MISSING-1',
  };
  const html = renderToStaticMarkup(
    React.createElement(SavedViewsPanel, {
      view: {
        id: 'review',
        name: 'Review work',
        connectionIds: ['work'],
        roots: [],
        filters: {
          assignee: 'me',
          statuses: ['Review'],
          priority: '',
          hideDone: true,
        },
        sort: { column: 'key', direction: 'asc' },
      },
      connections: [connection, github, demo],
      availableRoots: [source, githubSource, demoSource],
      sources: [source, githubSource, demoSource, missingSource],
      results: [
        { issue: issue('A-1'), source },
        { issue: issue('org/repo#7'), source: githubSource },
        { issue: issue('DEMO-1'), source: demoSource },
        { issue: issue('MISSING-1'), source: missingSource },
      ],
      selected: JSON.stringify(['work', 'A-1']),
      errors: { root: 'Offline; retained snapshot' },
      identityErrors: {},
      loading: new Set<string>(),
      onSelect() {},
      onOpen() {},
      onChange() {},
      onDelete() {},
      onRefresh() {},
    }),
  );
  assert.match(html, /aria-label="Active filters"/);
  assert.match(html, /Assigned to me/);
  assert.match(html, /Done hidden/);
  assert.match(html, /results may be incomplete/);
  assert.match(html, /Jira/);
  assert.match(html, /GitHub/);
  assert.match(html, /Demo/);
  assert.match(html, /Unknown provider/);
  assert.match(html, /<strong>Demo · Sample workspace<\/strong>/);
  assert.match(html, /<small>Demo · Sample workspace · DEMO-1/);
  assert.match(html, /<small>Unknown provider · missing · MISSING-1/);
  assert.match(html, /Engineering/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /Open A-1 in tree/);
});

test('bulk triage context names supported providers and unknown providers accurately', () => {
  for (const [provider, label] of [
    ['github', 'GitHub'],
    ['jira', 'Jira'],
    ['demo', 'Demo'],
    ['other', 'Unknown provider'],
  ] as const) {
    const html = renderToStaticMarkup(
      React.createElement(BulkTriage, {
        api: {} as never,
        connection: { ...connection, provider } as typeof connection,
        issues: [],
        operation: null,
        update: async () => true,
        undo: async () => true,
        canUndo: () => true,
        onClear() {},
        onOperation() {},
        copy: async () => true,
      }),
    );
    assert.match(html, new RegExp(`${label} · Work account`));
  }
});

test('bulk results retain titles, failure reasons, Retry and eligible Undo', () => {
  const token = Symbol();
  const html = renderToStaticMarkup(
    React.createElement(BulkTriage, {
      api: {} as never,
      connection,
      issues: [issue('A-1'), issue('A-2')],
      update: async () => true,
      undo: async () => true,
      canUndo: () => true,
      onClear() {},
      onOperation() {},
      copy: async () => true,
      operation: {
        action: 'assignee',
        choice: null,
        working: false,
        results: [
          { issue: issue('A-1'), state: 'saved', token },
          { issue: issue('A-2'), state: 'failed', reason: 'Permission denied' },
        ],
      },
    }),
  );
  assert.match(html, /1 saved/);
  assert.match(html, /1 need attention/);
  assert.match(html, /Readable title A-2/);
  assert.match(html, /Permission denied/);
  assert.match(html, />Retry</);
  assert.match(html, />Undo</);
});
