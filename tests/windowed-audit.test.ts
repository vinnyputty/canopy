import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import React, { act } from 'react';
import { WindowedRows } from '../src/renderer/WindowedRows';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const source = readFileSync(
  new URL('../tools/perf-desktop.mjs', import.meta.url),
  'utf8',
);
const ast = ts.createSourceFile(
  'audit.mjs',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
function initializer(name: string) {
  let result: ts.Expression | undefined;
  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name)
      result = node.initializer;
    ts.forEachChild(node, walk);
  };
  walk(ast);
  assert.ok(result, name);
  return result.getText(ast);
}
const sha = (keys: readonly string[]) =>
  createHash('sha256').update(JSON.stringify(keys)).digest('hex');

test('actual observer and driver require the complete committed member set independently of mounted DOM and loading state', async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div class="tree-scroll"><div role="tree" id="root"></div></div></body></html>',
    { pretendToBeVisual: true },
  );
  const window = dom.window,
    document = window.document;
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document,
    HTMLElement: window.HTMLElement,
    MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: window.getComputedStyle.bind(window),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  })) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const rootElement = document.querySelector('#root') as HTMLElement;
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(rootElement);
  try {
    const observer = readFileSync(
      new URL('fixtures/performance-ui.ts', import.meta.url),
      'utf8',
    );
    vm.runInNewContext(
      ts.transpileModule(observer, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        window,
        document,
        performance: { now: () => 10 },
        MutationObserver: window.MutationObserver,
        requestAnimationFrame: () => 0,
        PerformanceObserver: class {
          observe() {}
        },
      },
    );
    const ids = Array.from({ length: 2001 }, (_, i) => `A-${i}`);
    await act(async () =>
      root.render(
        React.createElement(WindowedRows, {
          ids,
          scrollSelector: '.tree-scroll',
          renderRow: (i: number) =>
            React.createElement(
              'div',
              {
                role: 'treeitem',
                'data-tree-parent': i ? ids[0] : undefined,
                'data-tree-key': ids[i],
                'aria-level': i ? 2 : 1,
                'aria-posinset': i || 1,
                'aria-setsize': i ? 2000 : 1,
              },
              ids[i],
            ),
        }),
      ),
    );
    assert.ok(document.querySelectorAll('[data-tree-key]').length < 100);
    assert.equal(window.canopyPerfUI.counts().treeLogicalRows, 2001);
    const projection = ids.map((key, i) => [
      key,
      i ? ids[0] : null,
      i ? 2 : 1,
      i || 1,
      i ? 2000 : 1,
    ]);
    const report = { label: 'candidate', logicalModels: [] as unknown[] };
    const crypto = createRequire(import.meta.url)('node:crypto').webcrypto;
    const callback = vm.runInNewContext(`(${initializer('logical')})`, {
      sample: report,
      phase: 'source-only',
      LOAD_MS: 180000,
      window,
      document,
      crypto,
      TextEncoder,
      Uint8Array,
      renderer: async (fn: Function, arg: unknown) => fn(arg),
      expect: {
        poll: (fn: () => Promise<unknown>) => ({
          toBe: async (expected: unknown) => assert.equal(await fn(), expected),
        }),
      },
    });
    await callback('tree', 2001, sha(ids), projection);
    const accepted = report.logicalModels[0] as {
      logicalCount: number;
      mountedCount: number;
      valid: boolean;
    };
    assert.equal(accepted.logicalCount, 2001);
    assert.ok(accepted.mountedCount < 100);
    assert.equal(accepted.valid, true);
    // A forged scalar count cannot replace membership or conceal wrong rows.
    rootElement
      .querySelector('[data-row-window]')!
      .setAttribute('data-logical-count', '9000');
    await assert.rejects(callback('tree', 9000, sha(ids), projection));
    await assert.rejects(
      callback('tree', 2001, sha([...ids.slice(0, -1), 'wrong']), projection),
    );
    const banner = document.createElement('div');
    banner.className = 'error-banner';
    banner.setAttribute('role', 'status');
    banner.textContent = 'Incomplete results: cancelled';
    document.body.append(banner);
    await assert.rejects(
      callback('tree', 2001, sha(ids), projection),
      'full partial membership still cannot satisfy completion',
    );
    banner.remove();
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel load';
    document.body.append(cancel);
    await assert.rejects(
      callback('tree', 2001, sha(ids), projection),
      'pending delivery cannot satisfy completion',
    );
    cancel.remove();
    const row = document.querySelector('[data-tree-key]')!;
    row.setAttribute('data-tree-key', 'foreign');
    await assert.rejects(
      callback('tree', 2001, sha(ids), projection),
      'mounted members must belong to the model',
    );
    row.setAttribute('data-tree-key', ids[0]);
    row.setAttribute('aria-posinset', '0');
    await assert.rejects(
      callback('tree', 2001, sha(ids), projection),
      'full logical hierarchy positions are required',
    );
    row.setAttribute('aria-posinset', '1');
    for (const [attribute, wrong] of [
      ['aria-level', '999'],
      ['aria-posinset', '999'],
      ['aria-setsize', '999'],
      ['data-tree-parent', 'foreign'],
      ['role', 'listitem'],
    ]) {
      const prior = row.getAttribute(attribute);
      row.setAttribute(attribute, wrong);
      await assert.rejects(
        callback('tree', 2001, sha(ids), projection),
        attribute + ' must match exact projection',
      );
      if (prior === null) row.removeAttribute(attribute);
      else row.setAttribute(attribute, prior);
    }
    const foreignOwner = document.createElement('div');
    foreignOwner.setAttribute('role', 'tree');
    row.parentElement!.insertBefore(foreignOwner, row);
    foreignOwner.append(row);
    await assert.rejects(
      callback('tree', 2001, sha(ids), projection),
      'owning tree must match',
    );
    foreignOwner.replaceWith(row);
    const wrongParent = document.createElement('div');
    wrongParent.setAttribute('role', 'treeitem');
    row.parentElement!.insertBefore(wrongParent, row);
    wrongParent.append(row);
    await assert.rejects(
      callback('tree', 2001, sha(ids), projection),
      'flat row cannot have an incorrect nested treeitem owner',
    );
    wrongParent.replaceWith(row);
    await callback('tree', 2001, sha(ids), projection);
    const retained = rootElement.querySelector(
      '[data-row-window]',
    ) as HTMLElement & { logicalRows?: unknown; rowKeys?: unknown };
    await act(async () => root.unmount());
    assert.equal(retained.logicalRows, undefined);
    assert.equal(retained.rowKeys, undefined);
    assert.equal(
      (retained as HTMLElement & { revealRow?: unknown }).revealRow,
      undefined,
    );
    // Baseline-compatible observer reads its unchanged ordinary DOM; it never
    // injects a virtual API or copies expected backend counts into that source.
    rootElement.innerHTML =
      '<div role="treeitem" data-tree-key="B-1"><div role="group"><div role="treeitem" data-tree-key="B-2"></div></div></div>';
    report.label = 'base';
    assert.deepEqual([...window.canopyPerfUI.members('tree')], ['B-1', 'B-2']);
    await callback('tree', 2, sha(['B-1', 'B-2']), [
      ['B-1', null, 1, 1, 1],
      ['B-2', 'B-1', 2, 1, 1],
    ]);
  } finally {
    await act(async () => root.unmount());
    window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('actual viewport auditor rejects wrong middle, invisible retained edges and broken ordered layout for both result kinds', async () => {
  for (const kind of ['tree', 'saved']) {
    const dom = new JSDOM(
      '<div class="tree-scroll saved-view-page"><div id="rows"></div></div>',
    );
    const { window } = dom,
      { document } = window;
    const container = document.querySelector('div') as HTMLElement;
    const host = document.querySelector('#rows') as HTMLElement;
    const keys = Array.from({ length: 1000 }, (_, i) => `A-${i}`);
    let fault = '';
    let target = keys[0];
    Object.defineProperties(container, {
      clientHeight: { value: 300 },
      clientTop: { value: 0 },
      scrollHeight: { value: 30000 },
    });
    container.getBoundingClientRect = () =>
      ({ top: 0, bottom: 300 }) as DOMRect;
    const render = () => {
      host.innerHTML = '';
      const position = keys.indexOf(target);
      const members =
        fault === 'wrong-middle' || fault === 'invisible-edge'
          ? [keys[0], keys[999]]
          : fault === 'order'
            ? [keys[Math.min(999, position + 1)], target]
            : [target];
      for (const key of members) {
        const row = document.createElement('div');
        if (kind === 'tree') {
          row.dataset.treeKey = key;
          row.innerHTML = '<div class="issue-row"></div>';
        } else {
          row.className = 'saved-view-result';
          row.innerHTML = `<strong>${key}</strong>`;
        }
        const geometry =
          kind === 'tree' ? (row.firstElementChild as HTMLElement) : row;
        geometry.getBoundingClientRect = () =>
          ({
            top: fault && key === keys[999] ? 1000 : 0,
            bottom: fault && key === keys[999] ? 1030 : 30,
            height: 30,
          }) as DOMRect;
        geometry.scrollIntoView = () => {
          target = key;
          render();
        };
        host.append(row);
      }
    };
    // A real candidate navigation surface invokes the production materializer;
    // this fault surface intentionally ignores/reorders the requested region.
    host.dataset.rowWindow = 'viewport';
    (host as HTMLElement & { revealRow: (key: string) => null }).revealRow = (
      key,
    ) => {
      target = key;
      render();
      return null;
    };
    render();
    window.canopyPerfUI = { members: () => keys } as never;
    const call = vm.runInNewContext(`(${initializer('viewport')})`, {
      window,
      document,
      spec: {
        treeMiddleKey: keys[500],
        treeLastKey: keys[999],
        savedMiddleKey: keys[500],
        savedLastKey: keys[999],
      },
      LOAD_MS: 180000,
      renderer: async (fn: Function, arg: unknown) => fn(arg),
      paint: async () => {},
      expect: {
        poll: (fn: () => Promise<unknown>) => ({
          toBe: async (expected: unknown) => assert.equal(await fn(), expected),
        }),
      },
    });
    try {
      fault = 'wrong-middle';
      render();
      await assert.rejects(call(kind), 'a wrong middle must fail');
      // Middle is correct, but a pinned invisible edge cannot satisfy end.
      fault = '';
      const reveal = (
        host as HTMLElement & { revealRow: (key: string) => null }
      ).revealRow;
      (host as HTMLElement & { revealRow: (key: string) => null }).revealRow = (
        key,
      ) => {
        fault = key === keys[999] ? 'invisible-edge' : '';
        return reveal(key);
      };
      await assert.rejects(
        call(kind),
        'an invisible pinned last member must fail',
      );
      (host as HTMLElement & { revealRow: (key: string) => null }).revealRow =
        reveal;
      fault = 'order';
      render();
      await assert.rejects(call(kind), 'reversed visible order must fail');
      fault = '';
      const accepted = await call(kind);
      assert.deepEqual(
        Array.from(accepted, (m: { target: string }) => m.target),
        [keys[500], keys[999], keys[0]],
      );
      // The unchanged baseline uses its real full DOM and native scrollIntoView.
      host.removeAttribute('data-row-window');
      delete (host as HTMLElement & { revealRow?: unknown }).revealRow;
      host.innerHTML = '';
      for (const key of keys) {
        const row = document.createElement('div');
        if (kind === 'tree') {
          row.dataset.treeKey = key;
          row.innerHTML = '<div class="issue-row"></div>';
        } else {
          row.className = 'saved-view-result';
          row.innerHTML = `<strong>${key}</strong>`;
        }
        const geometry =
          kind === 'tree' ? (row.firstElementChild as HTMLElement) : row;
        geometry.getBoundingClientRect = () => {
          const top = (keys.indexOf(key) - keys.indexOf(target)) * 30;
          return { top, bottom: top + 30, height: 30 } as DOMRect;
        };
        geometry.scrollIntoView = () => {
          target = key;
        };
        host.append(row);
      }
      await call(kind);
    } finally {
      window.close();
    }
  }
});

test('actual logical auditor requires exact saved-result positions, list ownership and roles', async () => {
  const dom = new JSDOM(
    '<div class="saved-view-list" role="list"><div class="saved-view-result" role="listitem" aria-posinset="1" aria-setsize="2"><strong>S-1</strong></div><div class="saved-view-result" role="listitem" aria-posinset="2" aria-setsize="2"><strong>S-2</strong></div></div>',
  );
  const { window } = dom,
    { document } = window,
    keys = ['S-1', 'S-2'];
  window.canopyPerfUI = {
    members: () => keys,
    counts: () => ({ savedLoading: false, savedIncomplete: false }),
  } as never;
  const call = vm.runInNewContext(`(${initializer('logical')})`, {
    window,
    document,
    sample: { label: 'candidate' },
    phase: 'saved-source',
    LOAD_MS: 180000,
    crypto: createRequire(import.meta.url)('node:crypto').webcrypto,
    TextEncoder,
    Uint8Array,
    renderer: async (fn: Function, arg: unknown) => fn(arg),
    expect: {
      poll: (fn: () => Promise<unknown>) => ({
        toBe: async (expected: unknown) => assert.equal(await fn(), expected),
      }),
    },
  });
  const projection = keys.map((key, i) => [key, null, null, i + 1, 2]),
    run = () => call('saved', 2, sha(keys), projection);
  try {
    await run();
    const row = document.querySelector('.saved-view-result')!;
    for (const [attribute, value] of [
      ['aria-posinset', '999'],
      ['aria-setsize', '999'],
      ['role', 'treeitem'],
    ]) {
      const prior = row.getAttribute(attribute)!;
      row.setAttribute(attribute, value);
      await assert.rejects(run(), attribute);
      row.setAttribute(attribute, prior);
    }
    const nested = document.createElement('div');
    nested.setAttribute('role', 'list');
    row.parentElement!.insertBefore(nested, row);
    nested.append(row);
    await assert.rejects(run(), 'nested foreign list');
    nested.replaceWith(row);
    await run();
  } finally {
    window.close();
  }
});
