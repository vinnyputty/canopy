import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';
import { execute, findNode, sourceFile } from './source-probe';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const renderer = sourceFile(
  process.env.CANOPY_DEMO_FOCUS_SOURCE ??
    new URL('../src/renderer/App.tsx', import.meta.url),
);
const focusEffect = findNode(
  renderer,
  (node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    node.expression.getText() === 'useEffect' &&
    node.getText().includes('pendingTourFocus.current') &&
    node.getText().includes('window.requestAnimationFrame'),
).arguments[0].getText();

function fixture(phase: string | null = 'playing', pending = true) {
  const dom = new JSDOM(
    '<button data-tour-playback>Pause demo</button><input id="other">',
  );
  const document = dom.window.document as Document;
  const frames = new Map<number, () => void>();
  let sequence = 0;
  const pendingTourFocus = { current: pending };
  const run = () =>
    execute(focusEffect, {
      pendingTourFocus,
      tour: phase === null ? null : { phase, step: 0 },
      document,
      window: {
        requestAnimationFrame: (callback: () => void) => {
          frames.set(++sequence, callback);
          return sequence;
        },
        cancelAnimationFrame: (id: number) => frames.delete(id),
      },
    })() as (() => void) | undefined;
  const flush = () => {
    for (const [id, callback] of frames) {
      frames.delete(id);
      callback();
    }
  };
  return { dom, document, frames, pendingTourFocus, run, flush };
}

for (const phase of ['playing', 'paused'])
  test(`a replayed ${phase} tour restores keyboard focus once`, () => {
    const f = fixture(phase);
    try {
      f.run();
      assert.equal(f.frames.size, 1);
      f.flush();
      assert.equal(
        f.document.activeElement,
        f.document.querySelector('[data-tour-playback]'),
      );
      assert.equal(f.pendingTourFocus.current, false);
      f.document.querySelector<HTMLInputElement>('#other')!.focus();
      f.run();
      f.flush();
      assert.equal(f.document.activeElement?.id, 'other');
      assert.equal(f.frames.size, 0);
    } finally {
      f.dom.window.close();
    }
  });

for (const phase of [
  'playing',
  'paused',
  'stopped',
  'complete',
  'failed',
  null,
])
  test(`an ordinary ${phase} tour does not request keyboard focus`, () => {
    const f = fixture(phase, false);
    try {
      f.run();
      assert.equal(f.frames.size, 0);
      assert.equal(f.document.activeElement, f.document.body);
    } finally {
      f.dom.window.close();
    }
  });

for (const phase of ['stopped', 'complete', 'failed', null])
  test(`a pending replay does not focus controls during ${phase}`, () => {
    const f = fixture(phase);
    try {
      f.run();
      assert.equal(f.frames.size, 0);
      assert.equal(f.document.activeElement, f.document.body);
    } finally {
      f.dom.window.close();
    }
  });

for (const timing of ['before render', 'before frame'])
  test(`replay does not steal focus acquired ${timing}`, () => {
    const f = fixture();
    try {
      const other = f.document.querySelector<HTMLInputElement>('#other')!;
      if (timing === 'before render') other.focus();
      f.run();
      other.focus();
      f.flush();
      assert.equal(f.document.activeElement, other);
      assert.equal(f.pendingTourFocus.current, false);
    } finally {
      f.dom.window.close();
    }
  });

test('missing playback controls leave focus alone and consume the replay request', () => {
  const f = fixture();
  try {
    f.document.querySelector('[data-tour-playback]')!.remove();
    f.run();
    f.flush();
    assert.equal(f.document.activeElement, f.document.body);
    assert.equal(f.pendingTourFocus.current, false);
  } finally {
    f.dom.window.close();
  }
});

test('tour cleanup cancels focus restoration without moving focus', () => {
  const f = fixture();
  try {
    const cleanup = f.run();
    assert.equal(f.frames.size, 1);
    cleanup!();
    assert.equal(f.frames.size, 0);
    f.flush();
    assert.equal(f.document.activeElement, f.document.body);
  } finally {
    f.dom.window.close();
  }
});

test('a phase replacement can restore focus after canceling the old frame', () => {
  const f = fixture();
  try {
    f.run()!();
    assert.equal(f.pendingTourFocus.current, true);
    f.run();
    f.flush();
    assert.equal(
      f.document.activeElement,
      f.document.querySelector('[data-tour-playback]'),
    );
    assert.equal(f.pendingTourFocus.current, false);
  } finally {
    f.dom.window.close();
  }
});

for (const step of [null, '0', '4', '7'])
  test(`only an explicit replay/navigation arms focus: ${step}`, () => {
    const assignment = findNode(
      renderer,
      (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) &&
        node.left.getText() === 'pendingTourFocus.current' &&
        node.right.getText().includes('sessionStorage.getItem'),
    );
    const pendingTourFocus = { current: false };
    execute(`() => { ${assignment.getText()}; }`, {
      pendingTourFocus,
      sessionStorage: { getItem: () => step },
    })();
    assert.equal(pendingTourFocus.current, step !== null);
  });

test('tour teardown clears any outstanding replay focus request', () => {
  const cleanup = findNode(
    renderer,
    (node): node is ts.ReturnStatement =>
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      ts.isArrowFunction(node.expression) &&
      node.getText().includes('controller.abort()') &&
      node.getText().includes('seekTourRef.current = null'),
  ).expression!.getText();
  const pendingTourFocus = { current: true };
  let aborted = false;
  const removed: string[] = [];
  execute(cleanup, {
    controller: {
      abort: () => {
        aborted = true;
      },
    },
    pendingTourFocus,
    stopTourRef: { current: () => {} },
    seekTourRef: { current: () => {} },
    toggleTourPauseRef: { current: () => {} },
    clearHighlight: () => {},
    document: { removeEventListener: (name: string) => removed.push(name) },
    manual: () => {},
  })();
  assert.equal(aborted, true);
  assert.equal(pendingTourFocus.current, false);
  assert.deepEqual(removed, ['pointerdown', 'keydown', 'wheel', 'touchstart']);
});
