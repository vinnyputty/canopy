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
    const report: { logicalModels: unknown[] } = { logicalModels: [] };
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
    await callback('tree', 2001, sha(ids));
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
    await assert.rejects(callback('tree', 9000, sha(ids)));
    await assert.rejects(
      callback('tree', 2001, sha([...ids.slice(0, -1), 'wrong'])),
    );
    const banner = document.createElement('div');
    banner.className = 'error-banner';
    banner.setAttribute('role', 'status');
    banner.textContent = 'Incomplete results: cancelled';
    document.body.append(banner);
    await assert.rejects(
      callback('tree', 2001, sha(ids)),
      'full partial membership still cannot satisfy completion',
    );
    banner.remove();
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel load';
    document.body.append(cancel);
    await assert.rejects(
      callback('tree', 2001, sha(ids)),
      'pending delivery cannot satisfy completion',
    );
    cancel.remove();
    const row = document.querySelector('[data-tree-key]')!;
    row.setAttribute('data-tree-key', 'foreign');
    await assert.rejects(
      callback('tree', 2001, sha(ids)),
      'mounted members must belong to the model',
    );
    row.setAttribute('data-tree-key', ids[0]);
    row.setAttribute('aria-posinset', '0');
    await assert.rejects(
      callback('tree', 2001, sha(ids)),
      'full logical hierarchy positions are required',
    );
    row.setAttribute('aria-posinset', '1');
    await callback('tree', 2001, sha(ids));
    const retained = rootElement.querySelector(
      '[data-row-window]',
    ) as HTMLElement & { logicalRows?: unknown; rowKeys?: unknown };
    await act(async () => root.unmount());
    assert.equal(retained.logicalRows, undefined);
    assert.equal(retained.rowKeys, undefined);
    // Baseline-compatible observer reads its unchanged ordinary DOM; it never
    // injects a virtual API or copies expected backend counts into that source.
    rootElement.innerHTML =
      '<div data-tree-key="B-1"></div><div data-tree-key="B-2"></div>';
    assert.deepEqual([...window.canopyPerfUI.members('tree')], ['B-1', 'B-2']);
    await callback('tree', 2, sha(['B-1', 'B-2']));
  } finally {
    await act(async () => root.unmount());
    window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
