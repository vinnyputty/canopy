import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { transformSync } from 'esbuild';
import type {
  AuthoringAction,
  AuthoringOptions,
  AuthoringResult,
} from '../../src/shared/authoring';

// Execute the actual component and imported draft module with deterministic hook
// lifetimes. This tests renderer closures without launching a DOM or desktop.
export function richAuthoringFixture() {
  type Element = { type: string; props: Record<string, any>; children: any[] };
  type Hook = {
    index: number;
    slots: any[];
    effects: (() => void)[];
    tree?: Element;
  };
  let active: Hook;
  const storage = new Map<string, string>();
  let storageFailure = false;
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (storageFailure) throw new Error('Fixture storage unavailable');
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
  const react = {
    createElement: (
      type: string,
      props: Record<string, any>,
      ...children: any[]
    ) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment',
    useState(initial: any) {
      const hook = active,
        index = hook.index++;
      if (!(index in hook.slots))
        hook.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        hook.slots[index],
        (value: any) => {
          hook.slots[index] =
            typeof value === 'function' ? value(hook.slots[index]) : value;
        },
      ];
    },
    useRef(initial: any) {
      const hook = active,
        index = hook.index++;
      if (!(index in hook.slots)) hook.slots[index] = { current: initial };
      return hook.slots[index];
    },
    useEffect(fn: () => any, deps: any[]) {
      const hook = active,
        index = hook.index++,
        old = hook.slots[index];
      if (!old || deps.some((value, i) => value !== old.deps[i]))
        hook.effects.push(() => {
          old?.cleanup?.();
          hook.slots[index] = { deps, cleanup: fn() };
        });
    },
  };
  const options: AuthoringOptions = {
    description: { editable: true, value: 'Original', revision: '"Original"' },
    comment: { allowed: true },
    parent: { allowed: false },
    createChild: true,
    fields: [],
    attachments: [],
    handoffs: [],
  };
  const requests: {
    connectionId: string;
    key: string;
    action: AuthoringAction;
    settle: (result: AuthoringResult) => void;
  }[] = [];
  const window = {
    canopy: {
      authoringOptions: async () => structuredClone(options),
      author: (connectionId: string, key: string, action: AuthoringAction) =>
        new Promise<AuthoringResult>((settle) =>
          requests.push({ connectionId, key, action, settle }),
        ),
    },
  };
  const context = createContext({
    localStorage,
    window,
    crypto: { randomUUID },
    structuredClone,
    console,
  });
  const cache = new Map<string, any>();
  function load(path: string): any {
    if (cache.has(path)) return cache.get(path);
    const code = transformSync(readFileSync(path, 'utf8'), {
      loader: path.endsWith('tsx') ? 'tsx' : 'ts',
      format: 'cjs',
      jsx: 'transform',
    }).code;
    const module = { exports: {} };
    cache.set(path, module.exports);
    runInContext(`(function(require,module,exports){${code}\n})`, context)(
      (name: string) =>
        name === 'react' ? react : load(resolve(dirname(path), `${name}.ts`)),
      module,
      module.exports,
    );
    cache.set(path, module.exports);
    return module.exports;
  }
  const { RichAuthoring } = load(
    resolve(import.meta.dirname, '../../src/renderer/RichAuthoring.tsx'),
  );
  function nodes(value: any): Element[] {
    if (!value) return [];
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (typeof value !== 'object') return [];
    return [value, ...nodes(value.children)];
  }
  function text(value: any): string {
    if (!value) return '';
    if (Array.isArray(value)) return value.map(text).join('');
    return typeof value === 'object' ? text(value.children) : String(value);
  }
  function mount(
    connectionId = 'account',
    issueKey = 'team/a#1',
    provider: 'github' | 'jira' = 'github',
  ) {
    const hook: Hook = { index: 0, slots: [], effects: [] };
    const pane = {
      render() {
        active = hook;
        hook.index = 0;
        hook.tree = RichAuthoring({
          connectionId,
          issueKey,
          provider,
          onRefresh() {},
          onPreview() {},
          onBrowser() {},
        });
        while (hook.effects.length) hook.effects.shift()!();
      },
      unmount() {
        for (const slot of hook.slots) slot?.cleanup?.();
      },
      text() {
        return text(hook.tree);
      },
      button(name: string) {
        const node = nodes(hook.tree).find(
          (node) => node.type === 'button' && text(node) === name,
        );
        if (!node) throw new Error(`Missing button ${name}`);
        return node.props;
      },
      input(label: string) {
        const node = nodes(hook.tree).find(
          (node) => node.props['aria-label'] === label,
        );
        if (!node) throw new Error(`Missing input ${label}`);
        return node.props;
      },
      acknowledge() {
        const checkbox = nodes(hook.tree).find(
          (node) => node.type === 'input' && node.props.type === 'checkbox',
        );
        if (!checkbox) throw new Error('Missing recovery checkbox');
        checkbox.props.onChange({ target: { checked: true } });
        pane.render();
      },
      async open() {
        pane.render();
        pane.render();
        pane.button('Edit and discuss').onClick();
        pane.render();
        await flush();
        pane.render();
      },
      change(label: string, value: string) {
        pane.input(label).onChange({ target: { value } });
        pane.render();
      },
    };
    return pane;
  }
  async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
  const key = (connectionId = 'account', issueKey = 'team/a#1') =>
    `canopy-authoring:${JSON.stringify([connectionId, issueKey])}`;
  return {
    mount,
    options,
    requests,
    flush,
    storage,
    key,
    failStorage: () => {
      storageFailure = true;
    },
  };
}
