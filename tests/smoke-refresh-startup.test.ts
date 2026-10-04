import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

let source: string;
before(async () => {
  const result = await build({
    entryPoints: ['tools/smoke-refresh.mjs'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [
      {
        name: 'inert-expect',
        setup(b) {
          b.onResolve({ filter: /^@playwright\/test$/ }, () => ({
            path: 'expect',
            namespace: 'inert',
          }));
          b.onLoad({ filter: /.*/, namespace: 'inert' }, () => ({
            contents: 'export const expect=globalThis.expect;',
            loader: 'js',
          }));
        },
      },
    ],
  });
  source = result.outputFiles[0].text;
});

for (const restored of ['CAN-100', 'CAN-200']) {
  test(`refresh audit selects its tree after restoring ${restored}`, async () => {
    let active = restored;
    let reloaded = false;
    const paused = new Error('Startup verified before refresh scenarios');
    const context = {
      module: {
        exports: {} as { auditRefresh: (...args: unknown[]) => Promise<void> },
      },
      expect: (locator: { visible?: () => boolean }) => ({
        toBeVisible: async () => assert.equal(locator.visible?.(), true),
        toBeHidden: async () => {},
        toHaveCount: async () => {},
      }),
    };
    runInNewContext(source, context);
    const page = {
      clock: {
        install: async () => {},
        pauseAt: async () => {
          throw paused;
        },
      },
      reload: async () => {
        reloaded = true;
        active = restored;
      },
      getByRole: (role: string, options: { name?: string | RegExp }) => ({
        click: async () => {
          assert(reloaded);
          assert.equal(role, 'tab');
          assert.equal(String(options.name), '/CAN-200/');
          active = 'CAN-200';
        },
        visible: () =>
          role === 'tree' && options.name === `${active} issue tree`,
      }),
      getByText: () => ({}),
      locator: () => ({}),
    };
    await assert.rejects(
      context.module.exports.auditRefresh({}, page, () => {}),
      (error) => error === paused,
    );
    assert.equal(active, 'CAN-200');
  });
}
