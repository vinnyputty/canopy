import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React, { act } from 'react';
import ts from 'typescript';
import { Settings } from '../src/renderer/Settings';
import { openIssueError } from '../src/renderer/open-issue-error';
import { DEFAULT_READING } from '../src/shared/views';
import {
  callback,
  declaration,
  execute,
  findNode,
  sourceFile,
} from './source-probe';

const { JSDOM } = createRequire(import.meta.url)('jsdom');

test('only the confirmed openIssue transport envelope is removed', () => {
  const prefix = "Error invoking remote method 'canopy:openIssue': Error: ";
  for (const error of [
    prefix + 'Browser unavailable',
    new Error(prefix + 'Browser unavailable'),
  ])
    assert.equal(openIssueError(error), 'Browser unavailable');
  for (const message of [
    'Provider unavailable',
    'Error: Provider unavailable',
    prefix,
    "Error invoking remote method 'canopy:tree': Error: Failure",
    "Error invoking remote method 'canopy:openIssue': TypeError: Failure",
    'Provider detail: ' + prefix + 'Failure',
  ])
    assert.equal(openIssueError(new Error(message)), message);
  assert.equal(openIssueError(null), 'null');
});

test('empty search resets only its root and restores search focus, including an absent search control', () => {
  const ast = sourceFile('src/renderer/App.tsx');
  const empty = findNode(
    ast,
    (node): node is ts.JsxSelfClosingElement =>
      ts.isJsxSelfClosingElement(node) &&
      node.getText().includes('title="No matching issues"'),
  );
  const action = empty.attributes.properties.find(
    (p) => ts.isJsxAttribute(p) && p.name.getText() === 'onAction',
  );
  assert.ok(
    action &&
      ts.isJsxAttribute(action) &&
      action.initializer &&
      ts.isJsxExpression(action.initializer),
  );
  let queries = { one: 'search', two: 'other search' };
  const patches: unknown[] = [];
  let focused = 0;
  const searchRef: { current: { focus: () => void } | null } = {
    current: { focus: () => focused++ },
  };
  const reset = execute(action.initializer.expression!.getText(), {
    activeTab: { id: 'one' },
    searchRef,
    setQueries: (update: (current: typeof queries) => typeof queries) => {
      queries = update(queries);
    },
    updateTab: (id: string, patch: unknown) => patches.push({ id, patch }),
    requestAnimationFrame: (callback: () => void) => callback(),
  });
  reset();
  assert.deepEqual(queries, { one: '', two: 'other search' });
  assert.deepEqual(patches, [
    { id: 'one', patch: { filters: {}, hideDone: false } },
  ]);
  assert.equal(focused, 1);
  searchRef.current = null;
  assert.doesNotThrow(reset);
  assert.equal(focused, 1);
});

test('welcome destinations, Reading autosave, and Appearance preview/save/cancel remain usable', async () => {
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const host = dom.window.document.querySelector('#host')! as HTMLElement;
  const root = createRoot(host);
  const calls: string[] = [];
  const noopIcon = () => null;
  const ast = sourceFile('src/renderer/App.tsx');
  const Welcome = execute(declaration(ast, 'Welcome').getText(), {
    __jsx: React.createElement,
    AlertCircle: noopIcon,
    Search: noopIcon,
    LogIn: noopIcon,
    Plus: noopIcon,
    shortcutDisplay: () => '⌘O',
    PLATFORM_SHORTCUTS: { quickOpen: 'Mod+O' },
  });
  const props = {
    onOpen: () => calls.push('open'),
    onConnect: () => calls.push('connect'),
    onDemo: () => calls.push('demo'),
    onHelp: () => calls.push('help'),
    onShortcuts: () => calls.push('shortcuts'),
    loading: false,
    demoMode: false,
    hasConnections: false,
  };
  const render = async (node: React.ReactNode) =>
    act(async () => root.render(node));
  const button = (name: string) => {
    const found = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === name,
    );
    assert.ok(found, name);
    return found;
  };
  const click = async (name: string) => act(async () => button(name).click());
  try {
    await render(React.createElement(Welcome, { ...props, loading: true }));
    assert.match(
      host.querySelector('[role="status"]')!.textContent!,
      /Loading saved connections/,
    );
    assert.equal(
      host.querySelector('button'),
      null,
      'startup cannot offer an unhydrated connection',
    );
    await render(React.createElement(Welcome, props));
    assert.match(host.textContent!, /No account needed/);
    for (const name of [
      'Connect Jira or GitHub',
      'Try demo',
      'Setup help',
      'Keyboard shortcuts',
    ])
      await click(name);
    assert.deepEqual(calls, ['connect', 'demo', 'help', 'shortcuts']);
    await render(
      React.createElement(Welcome, {
        ...props,
        hasConnections: true,
        error: 'Fixture failure',
      }),
    );
    assert.match(
      host.querySelector('[role="alert"]')!.textContent!,
      /Fixture failure/,
    );
    await click('Open an issue');
    await click('Add connection');
    assert.deepEqual(calls.slice(-2), ['open', 'connect']);
    await render(React.createElement(Welcome, { ...props, demoMode: true }));
    assert.ok(!host.textContent!.includes('Try demo'));
    await click('Open an issue');
    const reading: unknown[] = [];
    await render(
      React.createElement(Settings, {
        reading: DEFAULT_READING,
        onReading: (value) => reading.push(value),
        onAppearance: () => calls.push('appearance'),
        onConnect: props.onConnect,
        onShortcuts: props.onShortcuts,
        onBackup: () => calls.push('backup'),
      }),
    );
    const select = host.querySelector<HTMLSelectElement>(
      '[aria-label="Text size"]',
    )!;
    await act(async () => {
      select.value = 'large';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.deepEqual(reading, [{ ...DEFAULT_READING, textSize: 'large' }]);
    await click('Reset reading to Medium / Comfortable');
    assert.deepEqual(reading.at(-1), DEFAULT_READING);
    assert.ok(
      ![...host.querySelectorAll('button')].some(
        (b) => b.textContent === 'Save',
      ),
    );
    await click('Appearance');
    await click('Workspace backup and transfer');
    assert.deepEqual(calls.slice(-2), ['appearance', 'backup']);
    const previews: unknown[] = [];
    const saves: unknown[] = [];
    let rejectSave: (error: Error) => void = () => {};
    let failSave = true;
    const Appearance = execute(declaration(ast, 'AppearanceDialog').getText(), {
      __jsx: React.createElement,
      useState: React.useState,
      useEffect: React.useEffect,
      useRef: React.useRef,
      Dialog: ({ children }: { children: React.ReactNode }) =>
        React.createElement('div', null, children),
    });
    await render(
      React.createElement(Appearance, {
        theme: 'dark',
        palette: 'forest',
        onPreview: (value: unknown) => previews.push(value),
        onClose: () => calls.push('cancel-appearance'),
        onShortcuts: props.onShortcuts,
        onSave: async (theme: string, palette: string) => {
          saves.push({ theme, palette });
          if (failSave)
            await new Promise<void>((_, reject) => {
              rejectSave = reject;
            });
        },
      }),
    );
    await act(async () =>
      host
        .querySelectorAll<HTMLInputElement>('[name="appearance-mode"]')[1]
        .click(),
    );
    assert.deepEqual(previews.at(-1), { theme: 'light', palette: 'forest' });
    await click('Reset appearance');
    assert.deepEqual(previews.at(-1), { theme: 'system', palette: 'default' });
    assert.deepEqual(saves, [], 'preview and reset never persist without Save');
    await click('Cancel');
    assert.equal(calls.at(-1), 'cancel-appearance');
    await click('Save');
    assert.ok(button('Save').disabled);
    assert.ok(button('Cancel').disabled);
    await click('Save');
    assert.equal(saves.length, 1, 'disabled pending save refuses a duplicate');
    await act(async () => rejectSave(new Error('Disk full')));
    assert.match(
      host.querySelector('[role="alert"]')!.textContent!,
      /Disk full/,
    );
    assert.equal(
      button('Save').disabled,
      false,
      'failed save restores controls for retry',
    );
    failSave = false;
    await click('Save');
    assert.deepEqual(saves, [
      { theme: 'system', palette: 'default' },
      { theme: 'system', palette: 'default' },
    ]);
    assert.equal(host.querySelector('[role="alert"]'), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('token guidance preserves a usable browser address on failure and clears the error on retry', async () => {
  const source = sourceFile('src/renderer/SetupHelp.tsx');
  for (const url of [
    'https://id.atlassian.com/manage-profile/security/api-tokens',
    'https://github.com/settings/personal-access-tokens/new',
  ]) {
    let fail = true;
    let error = '';
    const opened: string[] = [];
    const open = execute(callback(source, 'open'), {
      setError: (message: string) => {
        error = message;
      },
      window: {
        canopy: {
          openLink: async (value: string) => {
            opened.push(value);
            if (fail) throw new Error('Browser unavailable');
          },
        },
      },
    });
    await open(url);
    assert.ok(
      error.includes(url),
      'browser failure offers the exact token settings address',
    );
    fail = false;
    await open(url);
    assert.equal(error, '', 'successful retry clears failed handoff feedback');
    assert.deepEqual(opened, [url, url]);
  }
});
