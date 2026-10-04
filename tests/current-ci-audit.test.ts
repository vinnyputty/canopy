import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const playwright = createRequire(require.resolve('@playwright/test'));
const core = createRequire(playwright.resolve('playwright'));
const bundle = readFileSync(
  join(
    dirname(core.resolve('playwright-core/package.json')),
    'lib/coreBundle.js',
  ),
  'utf8',
);
const encoded = bundle
  .split('\n')
  .find((line) => line.trim().startsWith('source4 ='));
assert.ok(encoded);
const injectedSource = vm.runInNewContext(`${encoded}\nsource4;`) as string;
const smoke = ts.createSourceFile(
  'smoke.mjs',
  readFileSync(new URL('../tools/smoke.mjs', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
function find(ast: ts.SourceFile, predicate: (node: ts.Node) => boolean) {
  let result: ts.Node | undefined;
  function walk(node: ts.Node) {
    if (predicate(node)) result = node;
    ts.forEachChild(node, walk);
  }
  walk(ast);
  assert.ok(result);
  return result;
}
function js(source: string) {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

// Use pinned Playwright's actual selector engines and strict error rather than
// approximating text matching. No browser, Playwright runtime or Electron loads.
test('real smoke status assertion waits for the semantic completed field, not workflow destination labels', async () => {
  const dom = new JSDOM(
    '<div data-tree-key="CAN-111"><div class="field-cell"><div role="menu"><button role="menuitem">In Progress</button><button role="menuitem">In Progress · 2 steps<small>To Do → Done → In Progress</small></button><button role="menuitem">Done · 2 steps<small>To Do → In Progress → Done</small></button></div></div></div>',
    { runScripts: 'outside-only' },
  );
  const window = dom.window as any;
  window.module = { exports: {} };
  window.eval(injectedSource);
  const injected = new (window.module.exports.InjectedScript())(window, {
    isUnderTest: true,
    browserName: 'chromium',
    customEngines: [],
    testIdAttributeName: 'data-testid',
    stableRafCount: 1,
  });
  const root = window.document;
  const old = injected.parseSelector(
    '[data-tree-key="CAN-111"] >> internal:text="In Progress"i',
  );
  assert.equal(injected.querySelectorAll(old, root).length, 3);
  assert.throws(
    () => injected.querySelector(old, root, true),
    /strict mode violation/,
  );
  const assertion = find(
    smoke,
    (n) =>
      ts.isCallExpression(n) &&
      n.expression.getText(smoke).endsWith('.toHaveText') &&
      n.getText(smoke).includes('Edit status for CAN-111'),
  );
  let polls = 0;
  const locator = (selector: string) => ({
    getByRole: (role: string, options: { name: string; exact: boolean }) => {
      assert.equal(options.exact, true);
      return (
        selector +
        ` >> internal:role=${role}[name=${JSON.stringify(options.name)}s]`
      );
    },
  });
  const execute = (status: string) =>
    vm.runInNewContext(js(assertion.getText(smoke)), {
      issue: () => locator('[data-tree-key="CAN-111"]'),
      expect: (selector: string) => ({
        toHaveText: async (expected: string) => {
          const parsed = injected.parseSelector(selector);
          assert.equal(
            injected.querySelector(parsed, root, true),
            undefined,
            'open menu is not a completed status',
          );
          polls++;
          // Delivery closes the actual semantic field; menu/path strings alone
          // cannot satisfy the corrected assertion.
          root.querySelector('.field-cell').outerHTML =
            `<div class="field-cell" role="button" aria-label="Edit status for CAN-111"><span class="status">${status}</span></div>`;
          const result = injected.querySelector(parsed, root, true);
          assert.ok(result);
          assert.equal(result.textContent, expected);
        },
      }),
    });
  await execute('In Progress');
  assert.equal(polls, 1);
  root.querySelector('.field-cell').outerHTML =
    '<div class="field-cell"><div role="menu"><button role="menuitem">In Progress</button></div></div>';
  await assert.rejects(execute('To Do'), /To Do/);
  dom.window.close();
});

const app = ts.createSourceFile(
  'App.tsx',
  readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const demo = ts.createSourceFile(
  'demo-check.mjs',
  readFileSync(
    process.env.CANOPY_DEMO_AUDIT_SOURCE ??
      new URL('../tools/demo-check.mjs', import.meta.url),
    'utf8',
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const initializer = (name: string) =>
  (
    find(
      app,
      (n) => ts.isVariableDeclaration(n) && n.name.getText(app) === name,
    ) as ts.VariableDeclaration
  ).initializer!.getText(app);
const installCall = find(
  demo,
  (n) =>
    ts.isCallExpression(n) &&
    n.expression.getText(demo) === 'page.addInitScript' &&
    n.arguments[0]?.getText(demo) === 'installDemoHold',
) as ts.CallExpression;
const install = find(
  demo,
  (n) =>
    ts.isFunctionDeclaration(n) &&
    n.name?.getText(demo) === installCall.arguments[0].getText(demo),
).getText(demo);

for (const hold of [false, true]) {
  test(`actual demo callbacks ${hold ? 'hold step zero before audit work' : 'expose the old late-pause race'}`, async () => {
    const dom = new JSDOM(
      '<div class="demo-tour"><span class="demo-tour-progress"></span><button>Pause demo</button></div>',
      { url: 'https://sample.invalid' },
    );
    const { window } = dom;
    let tour = { step: 0, phase: 'playing' },
      now = 0;
    const seeks: unknown[] = [];
    const context = {
      document: window.document,
      sessionStorage: window.sessionStorage,
      MutationObserver: window.MutationObserver,
      performance: { now: () => now },
      setTour: (value: any) => {
        tour = typeof value === 'function' ? value(tour) : value;
        window.document.querySelector('.demo-tour-progress')!.textContent =
          tour.step === 0 ? 'Starting tour' : `Step ${tour.step} of 7`;
        window.document.querySelector('button')!.textContent =
          tour.phase === 'paused' ? 'Resume demo' : 'Pause demo';
      },
      clearHighlight: () => {},
      setProgress: () => {},
      demoTimeScale: { current: 0.1 },
      startStep: 0,
      startPaused: false,
      signal: { aborted: false },
      seekTourRef: { current: (...args: unknown[]) => seeks.push(args) },
    };
    const callbacks = vm.runInNewContext(
      js(`let finished=false,paused=false,pausedAt=0,totalPaused=0,resume=null,resumeGate=null,currentStep=0,stepElapsed=0,stepDuration=1;
      const show=${initializer('show')};const togglePause=${initializer('togglePause')};
      ({show,togglePause,paused:()=>paused});`),
      context,
    );
    window.document.querySelector('button')!.onclick = () =>
      callbacks.togglePause();
    if (hold) {
      window.sessionStorage.setItem('canopy-check-hold', 'start');
      vm.runInNewContext(js(`(${install})()`), context);
    }
    callbacks.show(0, 'start', 6000);
    await Promise.resolve();
    now = 800; // Sequential native assertions can exceed the scaled 600ms step.
    if (!callbacks.paused()) callbacks.show(1, 'expand', 6000);
    if (!hold) callbacks.togglePause();
    const next = find(
      app,
      (n) =>
        ts.isArrowFunction(n) &&
        n.getText(app).includes('seekTourRef.current?.(tour.step + 1'),
    );
    vm.runInNewContext(js(`(${next.getText(app)})()`), { ...context, tour });
    assert.deepEqual(JSON.parse(JSON.stringify(seeks)), [[hold ? 1 : 2, true]]);
    assert.equal(window.sessionStorage.getItem('canopy-check-hold'), null);
    assert.equal(tour.phase, 'paused');
    dom.window.close();
  });
}

// Execute the production ordinal callback and the actual smoke sequence against
// the three tabs created by the subtree and linked-issue audits.
test('smoke ordinal shortcut checks the second tab before selecting the linked root', async () => {
  const tabs = ['CAN-100', 'CAN-106', 'CAN-200'].map((rootKey) => ({
    rootKey,
  }));
  let active = tabs[0];
  const callback = find(
    app,
    (node) =>
      ts.isVariableDeclaration(node) &&
      node.name.getText(app) === 'selectTabAt',
  ) as ts.VariableDeclaration;
  const selectTabAt = vm.runInNewContext(
    js(`(${callback.initializer!.getText(app)})`),
    {
      useCallback: (fn: unknown) => fn,
      workspaceRef: { current: { tabs } },
      navigate: (tab: (typeof tabs)[number]) => (active = tab),
    },
  );
  const source = smoke.getFullText();
  const start = source.indexOf('  // The subtree audit opens CAN-106');
  const end = source.indexOf(
    '  await page.keyboard.press(`${modifier}+b`)',
    start,
  );
  assert.ok(start >= 0 && end > start);
  const keys: string[] = [];
  await vm.runInNewContext(
    js(`(async () => {${source.slice(start, end)}})()`),
    {
      modifier: 'Control',
      page: {
        keyboard: {
          press: async (key: string) => {
            keys.push(key);
            selectTabAt(Number(key.split('+')[1]) - 1);
          },
        },
        getByRole: (role: string, options: { name: string | RegExp }) => ({
          toBeVisible: async () => {
            assert.equal(role, 'tree');
            assert.equal(options.name, `${active.rootKey} issue tree`);
          },
          click: async () => {
            assert.equal(role, 'tab');
            const target = tabs.find((tab) =>
              (options.name as RegExp).test(tab.rootKey),
            );
            assert.ok(target);
            active = target;
          },
        }),
      },
      expect: (locator: unknown) => locator,
    },
  );
  assert.deepEqual(keys, ['Control+2']);
  assert.equal(active.rootKey, 'CAN-200');
});
