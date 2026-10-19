import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { paletteReturn } from '../src/renderer/palette-return';
import {
  callback,
  declaration,
  execute,
  findNode,
  sourceFile,
} from './source-probe';

const source = sourceFile(
  process.env.CANOPY_PALETTE_SOURCE ??
    new URL('../src/renderer/App.tsx', import.meta.url),
);
const picker = declaration(source, 'OpenIssueDialog');
const submitSource = callback(picker, 'submit');

for (const mode of [
  'no-match',
  'short-query',
  'key',
  'selected',
  'explicit',
  'no-connection',
]) {
  test(`deliberate picker Enter: ${mode}`, () => {
    const opened: unknown[] = [];
    const calls: string[] = [];
    const submit = execute(submitSource, {
      directKey: mode === 'key' || mode === 'explicit' ? 'CAN-1' : null,
      selected:
        mode === 'selected' || mode === 'explicit'
          ? { key: 'CAN-2' }
          : undefined,
      explicitSelection: mode === 'explicit',
      connectionId: mode === 'no-connection' ? '' : 'fixture',
      onOpen: (...args: unknown[]) => opened.push(args),
      setError: () => calls.push('error'),
      deliberate: true,
      query: mode === 'short-query' ? 'x' : 'missing phrase',
      project: 'CAN',
      search: {
        start: () => calls.push('remote-start'),
        load: () => calls.push('provider-load'),
      },
    });
    submit();
    assert.deepEqual(
      calls,
      mode === 'no-connection' ? ['error'] : [],
      'Enter must never request remote search',
    );
    assert.deepEqual(
      opened,
      ['key', 'selected', 'explicit'].includes(mode)
        ? [['fixture', mode === 'key' ? 'CAN-1' : 'CAN-2']]
        : [],
    );
  });
}

test('explicit Search issues button invokes the production provider handoff', async () => {
  const button = findNode(
    picker,
    (node): node is ts.JsxElement =>
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText() === 'button' &&
      node.children.some(
        (child) => ts.isJsxText(child) && child.text.includes('Search issues'),
      ),
  );
  const handler = findNode(
    button.openingElement,
    (node): node is ts.JsxAttribute =>
      ts.isJsxAttribute(node) && node.name.getText() === 'onClick',
  );
  assert.ok(
    handler.initializer &&
      ts.isJsxExpression(handler.initializer) &&
      handler.initializer.expression,
  );
  const calls: unknown[] = [];
  const click = execute(handler.initializer.expression.getText(), {
    connectionId: 'fixture',
    query: ' missing phrase ',
    project: 'CAN',
    inputRef: { current: { focus: () => calls.push('focus') } },
    search: {
      start: (...args: unknown[]) => calls.push(args),
      load: async () => {
        calls.push('provider-load');
      },
    },
  });
  click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    ['fixture', 'missing phrase', 'CAN', false],
    'provider-load',
    'focus',
  ]);
});

for (const dismissal of ['Escape', 'Cancel', 'Save', 'backdrop']) {
  test(`shortcuts transition focuses the dialog and restores origin on ${dismissal}`, () => {
    const container = {
      isConnected: true,
      scrollTop: 230,
      scrollLeft: 17,
      parentElement: null,
    };
    let active: unknown;
    class ElementFixture {}
    const origin = Object.assign(new ElementFixture(), {
      isConnected: true,
      parentElement: container,
      focus: () => {
        active = origin;
      },
    });
    active = 'palette input';
    let nextDialog;
    const shortcutCommand = findNode(
      declaration(source, 'App'),
      (node): node is ts.ObjectLiteralExpression =>
        ts.isObjectLiteralExpression(node) &&
        node.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText() === 'id' &&
            property.initializer.getText() === "'shortcuts'",
        ),
    );
    const command = execute(shortcutCommand.getText(), {
      Keyboard: 'icon',
      setDialog: (value: unknown) => {
        nextDialog = value;
      },
    });
    const restore = { current: true };
    const run = execute(callback(declaration(source, 'CommandDialog'), 'run'), {
      commands: [command],
      restore,
      returnToPrevious: paletteReturn(
        origin as unknown as HTMLElement,
        container as unknown as HTMLElement,
      ),
      onClose: () => {
        throw new Error('shortcuts transition must replace the palette');
      },
      setRemote: () => {
        throw new Error('shortcuts is a local action');
      },
    });
    run({ target: { type: 'Action', actionId: 'shortcuts' } });
    assert.equal(nextDialog, 'shortcuts');
    assert.equal(active, origin);
    assert.equal(restore.current, false);
    let cleanup: (() => void) | undefined;
    let keydown: ((event: unknown) => void) | undefined;
    let closed = false;
    let saved = false;
    const jsx = (
      type: unknown,
      props: Record<string, any> | null,
      ...children: any[]
    ) => ({ type, props: props ?? {}, children });
    const context = {
      __jsx: jsx,
      useState: (value: any) => [
        typeof value === 'function' ? value() : value,
        () => {},
      ],
      useLayoutEffect: (effect: () => () => void) => {
        cleanup = effect();
      },
      useEffect: (effect: () => void) => {
        effect();
      },
      paletteReturn,
      document: { activeElement: origin },
      shortcutCollisions: () => new Map(),
      SHORTCUT_LABELS: { shortcuts: 'Keyboard shortcuts' },
      shortcutDisplay: (value: string) => value,
      defaultShortcuts: () => ({}),
      cx: (...values: unknown[]) => values.filter(Boolean).join(' '),
      Dialog: 'Dialog',
      AlertCircle: 'icon',
      eventShortcut: () => '',
    };
    const shortcuts = execute(
      declaration(source, 'ShortcutsDialog').getText(),
      context,
    );
    const output = shortcuts({
      shortcuts: { shortcuts: 'Meta+/' },
      initialFocus: false,
      onClose: () => {
        closed = true;
      },
      onChange: () => {
        saved = true;
      },
    });
    // Exercise the production Dialog's actual autoFocus and Escape/backdrop handlers.
    const dialog = execute(declaration(source, 'Dialog').getText(), {
      __jsx: jsx,
      HTMLElement: ElementFixture,
      requestAnimationFrame: (callback: () => void) => callback(),
      useRef: (value: unknown) => ({ current: value }),
      useLayoutEffect: (effect: () => () => void) => effect(),
      useEffect: (effect: () => void) => effect(),
      window: {
        addEventListener: (_: string, listener: typeof keydown) => {
          keydown = listener;
        },
        removeEventListener: () => {},
      },
      document: { activeElement: origin },
      cx: context.cx,
      X: 'icon',
    })(output.props);
    const closeButton = dialog.children[0].children[0].children[1];
    assert.equal(
      closeButton.props.autoFocus,
      true,
      'initial focus must enter shortcuts reached from the palette',
    );
    active = closeButton;
    container.scrollTop = 900;
    if (dismissal === 'Escape') keydown!({ key: 'Escape' });
    else if (dismissal === 'backdrop') {
      const backdrop = {};
      dialog.props.onMouseDown({
        target: backdrop,
        currentTarget: backdrop,
        preventDefault: () => {},
      });
    } else {
      const footer = output.children.at(-1);
      const button = footer.children.find(
        (child: any) =>
          child?.type === 'button' && child.children.includes(dismissal),
      );
      button.props.onClick();
    }
    assert.equal(closed, true);
    assert.equal(saved, dismissal === 'Save');
    cleanup?.();
    assert.equal(active, origin);
    assert.equal(container.scrollTop, 230);
    assert.equal(container.scrollLeft, 17);
  });
}
