import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const uiSource = readFileSync(
  new URL('fixtures/performance-ui.ts', import.meta.url),
  'utf8',
);
const driverSource = readFileSync(
  new URL('../tools/perf-desktop.mjs', import.meta.url),
  'utf8',
);
function expression(name: string, source = driverSource) {
  const ast = ts.createSourceFile(
    'audit.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let result: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name)
      result = node.initializer;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      result = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(result, name);
  return result.getText(ast).replace(/^export /, '');
}
function ui(kind: 'tree' | 'saved' = 'tree') {
  const dom = new JSDOM(
    kind === 'tree'
      ? '<!doctype html><div role="tree"><div data-row-window="all"></div></div>'
      : '<!doctype html><div role="list" class="saved-view-list"><div data-row-window="all"></div></div>',
  );
  const document = dom.window.document;
  const model = document.querySelector('[data-row-window]');
  let keys = ['A', 'B', 'C'],
    now = 0,
    notify = () => {};
  const frames: ((at: number) => void)[] = [];
  model.rowKeys = () => keys;
  const render = () => {
    model.innerHTML = keys
      .map((key, i) =>
        kind === 'saved'
          ? `<div role="listitem" class="saved-view-result" aria-posinset="${i + 1}" aria-setsize="${keys.length}"><strong>${key}</strong></div>`
          : `<div role="treeitem" data-tree-key="${key}" ${i ? 'data-tree-parent="A"' : ''} aria-level="${i ? 2 : 1}" aria-posinset="${i || 1}" aria-setsize="${i ? 2 : 1}"></div>`,
      )
      .join('');
  };
  render();
  // Actual DOM/model reads; only frame delivery and the monotonic clock are controlled.
  const elements = document.getElementsByTagName.bind(document);
  document.getElementsByTagName = (tag: string) => {
    now += 5;
    return elements(tag);
  };
  vm.runInNewContext(
    ts.transpileModule(uiSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      window: dom.window,
      document,
      performance: { now: () => now, timeOrigin: 10000 },
      requestAnimationFrame: (callback: (at: number) => void) =>
        frames.push(callback),
      MutationObserver: class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe() {}
      },
      PerformanceObserver: class {
        observe() {}
      },
    },
  );
  return {
    window: dom.window,
    document,
    model,
    api: dom.window.canopyPerfUI,
    clock: () => now,
    replaceMembers: (next: string[]) => {
      keys = next;
    },
    commit: (at: number, partial = false) => {
      now = at;
      keys = partial ? ['A'] : ['A', 'B', 'C'];
      render();
      document
        .querySelectorAll('button,.error-banner')
        .forEach((element: HTMLElement) => element.remove());
      if (partial) {
        document.body.insertAdjacentHTML(
          'beforeend',
          '<button>Cancel load</button><div class="error-banner" role="status">Incomplete results:</div>',
        );
      }
      notify();
    },
    frame: (raw: number, observed: number) => {
      now = observed;
      frames.splice(0).forEach((callback) => callback(raw));
    },
    close: () => dom.window.close(),
  };
}
function selection(state: ReturnType<typeof ui>, ipcOrigin = 10000) {
  const context: Record<string, unknown> = {
    initial: {
      ui: state.api.events(),
      ipc: { timeOrigin: ipcOrigin },
      counts: state.api.counts(),
    },
    spec: { expandedRows: 3 },
    full: { at: 1047 },
    progress: { at: 180 },
  };
  for (const name of [
    'fullCommit',
    'fullPaint',
    'partialCommit',
    'partialPaint',
  ])
    context[name] = vm.runInNewContext(expression(name), context);
  return context;
}

test('shared frame timestamps cannot replace actual callback observation chronology', async () => {
  const state = ui();
  try {
    state.commit(197, true);
    state.frame(190.9, 204);
    state.commit(1258.5);
    state.frame(1158.5, 1270);
    const events = state.api.events().events;
    const commit = events.find(
      (e: Record<string, unknown>) =>
        e.event === 'dom-commit' && e.treeLogicalRows === 3,
    );
    const opportunity = events.find(
      (e: Record<string, unknown>) =>
        e.event === 'paint-opportunity' && e.treeLogicalRows === 3,
    );
    assert.equal(
      opportunity.at,
      state.clock(),
      'clock read follows actual DOM counting',
    );
    assert.ok(opportunity.at >= commit.at);
    assert.equal(opportunity.frameAt, 1158.5);
    // Full qualification requires the explicit settled model capture, not this incidental callback.
    const pending = state.api.paintOpportunity({
      kind: 'tree',
      members: ['A', 'B', 'C'],
    });
    state.frame(1280, 1281);
    state.frame(1290, 1291);
    await pending;
    const selected = selection(state);
    assert.ok(selected.fullPaint);
    assert.ok(selected.partialPaint);
    assert.equal(
      selection(state, 20000).fullCommit,
      undefined,
      'full IPC origin must be normalized',
    );
  } finally {
    state.close();
  }
});

test('quiet DOM capture waits for the second real callback and binds current ordered members', async () => {
  const state = ui();
  try {
    let resolved = false;
    const pending = state.api
      .paintOpportunity({ kind: 'tree', members: ['A', 'B', 'C'] })
      .then((event: Record<string, unknown>) => {
        resolved = true;
        return event;
      });
    state.frame(10, 15);
    await Promise.resolve();
    assert.equal(resolved, false, 'first RAF cannot fulfill the opportunity');
    state.replaceMembers(['A', 'C', 'B']);
    state.frame(20, 25);
    const event = await pending;
    assert.equal(event.at, state.clock());
    assert.equal(event.frameAt, 20);
    assert.equal(event.treeLogicalRows, 3);
    assert.equal(event.membersValid, false);
    assert.equal(event.modelKind, 'tree');
    assert.ok(
      state.api
        .events()
        .events.some(
          (record: Record<string, unknown>) =>
            record.event === 'paint-opportunity' &&
            record.at === event.at &&
            record.frameAt === event.frameAt &&
            record.membersValid === false,
        ),
    );
  } finally {
    state.close();
  }
});

function logical(
  state: ReturnType<typeof ui>,
  mutate: () => void,
  retry = false,
  kind: 'tree' | 'saved' = 'tree',
) {
  const attempts: boolean[] = [],
    report = { label: 'candidate', logicalModels: [] as unknown[] };
  const fn = vm.runInNewContext(`(${expression('logical')})`, {
    sample: report,
    phase: 'initial-load',
    LOAD_MS: 180000,
    window: state.window,
    document: state.document,
    TextEncoder,
    Uint8Array,
    crypto: {
      subtle: {
        digest: async (...args: Parameters<typeof webcrypto.subtle.digest>) => {
          const value = await webcrypto.subtle.digest(...args);
          mutate();
          return value;
        },
      },
    },
    renderer: async (callback: Function, args: unknown) => callback(args),
    expect: {
      poll: (
        callback: () => Promise<boolean>,
        options: { timeout: number },
      ) => {
        assert.equal(options.timeout, 180000);
        return {
          toBe: async (expected: boolean) => {
            attempts.push(await callback());
            if (retry && attempts[0] === false) {
              state.replaceMembers(['A', 'B', 'C']);
              attempts.push(await callback());
            }
            assert.equal(attempts.at(-1), expected);
          },
        };
      },
    },
  });
  const members = ['A', 'B', 'C'];
  return {
    run: (settled = false) =>
      fn(
        kind,
        3,
        createHash('sha256').update(JSON.stringify(members)).digest('hex'),
        kind === 'tree'
          ? [
              ['A', null, 1, 1, 1],
              ['B', 'A', 2, 1, 2],
              ['C', 'A', 2, 2, 2],
            ]
          : members.map((key, i) => [key, null, null, i + 1, 3]),
        settled,
      ),
    attempts,
    report,
  };
}

test('digest completion revalidates same-count members, live state and mounted ownership', async () => {
  for (const change of [
    'members',
    'order',
    'loading',
    'incomplete',
    'count',
    'container',
    'mounted',
    'aria',
  ]) {
    const state = ui();
    try {
      const check = logical(state, () => {
        if (change === 'members') state.replaceMembers(['A', 'B', 'X']);
        if (change === 'order') state.replaceMembers(['A', 'C', 'B']);
        if (change === 'count') state.replaceMembers(['A', 'B']);
        if (change === 'loading')
          state.document.body.insertAdjacentHTML(
            'beforeend',
            '<button>Cancel load</button>',
          );
        if (change === 'incomplete')
          state.document.body.insertAdjacentHTML(
            'beforeend',
            '<div class="error-banner" role="status">Incomplete results:</div>',
          );
        if (change === 'container') {
          const root = state.document.querySelector('[role="tree"]');
          root.replaceWith(root.cloneNode(true));
        }
        if (change === 'mounted') {
          const row = state.document.querySelector('[data-tree-key="B"]');
          row.replaceWith(row.cloneNode(true));
        }
        if (change === 'aria')
          state.document
            .querySelector('[data-tree-key="B"]')
            .setAttribute('aria-posinset', '2');
      });
      await assert.rejects(check.run(), { code: 'ERR_ASSERTION' }, change);
      assert.equal(check.report.logicalModels.length, 0);
    } finally {
      state.close();
    }
  }
});

test('a fresh coherent poll can recover after an asynchronous model replacement', async () => {
  const state = ui();
  let calls = 0;
  try {
    const check = logical(
      state,
      () => {
        state.replaceMembers(++calls === 1 ? ['A', 'B', 'X'] : ['A', 'B', 'C']);
      },
      true,
    );
    await check.run();
    assert.deepEqual(check.attempts, [false, true]);
    assert.equal(check.report.logicalModels.length, 1);
  } finally {
    state.close();
  }
});

test('settled validation refuses a same-count projection changed during the two-frame capture', async () => {
  const state = ui();
  try {
    let signal = () => {};
    const started = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const capture = state.api.paintOpportunity;
    state.api.paintOpportunity = (expected: unknown) => {
      const result = capture(expected);
      signal();
      return result;
    };
    const check = logical(state, () => {});
    const pending = check.run(true);
    await started;
    state.frame(10, 15);
    state.replaceMembers(['A', 'B', 'X']);
    state.frame(20, 25);
    await assert.rejects(pending);
    assert.equal(check.report.logicalModels.length, 0);
  } finally {
    state.close();
  }
});

test('actual opportunity driver bounds a held or torn renderer and clears its timer', async () => {
  const lifecycle = readFileSync(
    new URL('../tools/audit-lifecycle.mjs', import.meta.url),
    'utf8',
  );
  for (const torn of [false, true]) {
    let expire = () => {},
      cleared = 0;
    const error = new Error('Renderer context destroyed');
    const deadline = vm.runInNewContext(
      `(${expression('deadline', lifecycle)})`,
      {
        setTimeout: (callback: () => void, ms: number) => {
          assert.equal(ms, 180000);
          expire = callback;
          return 7;
        },
        clearTimeout: (id: number) => {
          assert.equal(id, 7);
          cleared++;
        },
      },
    );
    const paint = vm.runInNewContext(`(${expression('paint')})`, {
      deadline,
      LOAD_MS: 180000,
      renderer: () => (torn ? Promise.reject(error) : new Promise(() => {})),
    });
    const pending = paint();
    await Promise.resolve();
    if (!torn) expire();
    await assert.rejects(pending, (value: unknown) =>
      torn
        ? value === error
        : /Paint opportunities timed out/.test(String(value)),
    );
    assert.equal(cleared, 1);
  }
});

function refusal(message: string, context: Record<string, unknown>) {
  const ast = ts.createSourceFile(
    'driver.mjs',
    driverSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let condition: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isIfStatement(node) &&
      node.thenStatement.getText(ast).includes(message)
    )
      condition = node.expression;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(condition);
  return vm.runInNewContext(condition.getText(ast), context);
}

test('actual initial-load gates reject latest state changes and missing earlier partial opportunity', async () => {
  const state = ui();
  try {
    state.commit(197, true);
    state.frame(190.9, 204);
    state.commit(1258.5);
    const captured = state.api.paintOpportunity({
      kind: 'tree',
      members: ['A', 'B', 'C'],
    });
    state.frame(1280, 1281);
    state.frame(1290, 1291);
    await captured;
    const fullMessage =
      'Complete renderer commit/paint-opportunity evidence missing.';
    const partialMessage =
      'Partial renderer paint opportunity before full completion missing.';
    const accepted = selection(state);
    assert.equal(refusal(fullMessage, accepted), false);
    assert.equal(Boolean(refusal(partialMessage, accepted)), false);
    for (const change of [
      'loading',
      'incomplete',
      'count',
      'truncated',
      'no-full-paint',
      'no-full-commit',
    ]) {
      const current = selection(state);
      const initial = current.initial as {
        counts: Record<string, unknown>;
        ui: { truncated: boolean };
      };
      if (change === 'loading') initial.counts.treeLoading = true;
      if (change === 'incomplete') initial.counts.treeIncomplete = true;
      if (change === 'count') initial.counts.treeLogicalRows = 2;
      if (change === 'truncated') initial.ui.truncated = true;
      if (change === 'no-full-paint') current.fullPaint = undefined;
      if (change === 'no-full-commit') current.fullCommit = undefined;
      assert.equal(Boolean(refusal(fullMessage, current)), true, change);
    }
    for (const change of [
      'no-partial-paint',
      'no-partial-commit',
      'after-full',
    ]) {
      const current = selection(state);
      if (change === 'no-partial-paint') current.partialPaint = undefined;
      if (change === 'no-partial-commit') current.partialCommit = undefined;
      if (change === 'after-full')
        current.partialPaint = {
          at: (current.fullCommit as { at: number }).at + 1,
        };
      assert.equal(Boolean(refusal(partialMessage, current)), true, change);
    }
  } finally {
    state.close();
  }
});

test('the actual driver captures quiet DOM through its existing two-frame paint boundary', async () => {
  const state = ui();
  try {
    const paint = vm.runInNewContext(`(${expression('paint')})`, {
      LOAD_MS: 180000,
      deadline: (operation: () => unknown, ms: number) => {
        assert.equal(ms, 180000);
        return operation();
      },
      renderer: async (callback: Function) => callback(),
      window: state.window,
    });
    let resolved = false;
    const pending = paint().then(() => {
      resolved = true;
    });
    state.frame(10, 15);
    await Promise.resolve();
    assert.equal(resolved, false);
    state.frame(20, 25);
    await pending;
    assert.equal(
      state.api
        .events()
        .events.filter(
          (event: Record<string, unknown>) =>
            event.event === 'paint-opportunity',
        ).length,
      1,
    );
  } finally {
    state.close();
  }
});

test('saved-result digest validation also rejects same-count membership replacement', async () => {
  const state = ui('saved');
  try {
    const check = logical(
      state,
      () => state.replaceMembers(['A', 'B', 'X']),
      false,
      'saved',
    );
    await assert.rejects(check.run(), { code: 'ERR_ASSERTION' });
    assert.equal(check.report.logicalModels.length, 0);
  } finally {
    state.close();
  }
});
