import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { WorkHandoffQueue } from '../src/main/work-handoff';

const require = createRequire(import.meta.url);
const handoff = ['--canopy-open', 'canopy://handoff/view?view=triage'];
let entrypoint: string;
let playwrightPrefix: string;
before(async () => {
  const bundled = await build({
    entryPoints: ['src/main/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [
      {
        name: 'inert-startup',
        setup(b) {
          b.onResolve({ filter: /^(electron|\.\/app|\.\/demo)$/ }, (x) => ({
            path: x.path,
            namespace: 'inert',
          }));
          b.onLoad({ filter: /.*/, namespace: 'inert' }, (x) => ({
            contents:
              x.path === 'electron'
                ? 'export const app=globalThis.app;'
                : x.path === './app'
                  ? 'export const launch=(...args)=>globalThis.launched=args;'
                  : 'export const createDemoFixture=()=>{};',
            loader: 'js',
          }));
        },
      },
    ],
  });
  entrypoint = bundled.outputFiles[0].text;
  const core = createRequire(
    createRequire(require.resolve('@playwright/test')).resolve('playwright'),
  ).resolve('playwright-core');
  const pinned = await readFile(
    join(dirname(core), 'lib/coreBundle.js'),
    'utf8',
  );
  const begin = pinned.indexOf('let electronArguments = ["--inspect=0"');
  const end = pinned.indexOf('let artifactsDir;', begin);
  assert(begin > 0 && end > begin);
  playwrightPrefix = pinned.slice(begin, end);
});

function startup(argv: string[], packaged: boolean, platform: string) {
  const context: any = {
    app: { isPackaged: packaged },
    process: { argv, platform },
    require,
  };
  runInNewContext(entrypoint, context);
  const [fixture, demo, args] = context.launched;
  assert.equal(typeof fixture === 'function', demo);
  // The real queue/parser validates the entrypoint's lock payload.
  const queue = new WorkHandoffQueue();
  try {
    queue.receive(args);
    return { demo, state: queue.ready(() => {}), args: Array.from(args) };
  } finally {
    queue.stop();
  }
}

for (const platform of ['darwin', 'linux', 'win32']) {
  for (const packaged of [false, true]) {
    test(`real entrypoint handles pinned Playwright and direct startup: ${platform}, packaged=${packaged}`, () => {
      for (const debug of [false, true]) {
        for (const demo of [false, true]) {
          for (const command of [[], handoff]) {
            const appArgs = [
              ...(packaged ? [] : ['/sample/app']),
              ...(demo ? ['--canopy-demo'] : []),
              ...command,
            ];
            const context: any = {
              options: { args: appArgs },
              import_os14: { default: { platform: () => platform } },
            };
            runInNewContext(
              playwrightPrefix + 'globalThis.argv=electronArguments;',
              context,
            );
            const launched = startup(
              ['/electron', ...(debug ? context.argv : appArgs)],
              packaged,
              platform,
            );
            assert.equal(launched.demo, demo);
            assert.deepEqual(launched.args, command);
            assert.equal(launched.state.rejected, undefined);
            assert.equal(
              launched.state.delivery?.intent.kind,
              command.length ? 'view' : undefined,
            );
          }
        }
      }
    });

    test(`real entrypoint refuses malformed application/runtime arguments: ${platform}, packaged=${packaged}`, () => {
      const appPath = packaged ? [] : ['/sample/app'];
      for (const command of [
        [...handoff, '--canopy-demo'],
        ['--canopy-open', '--canopy-demo'],
        ['--unknown', '--canopy-demo'],
        ['--canopy-demo', '--canopy-demo', ...handoff],
        ['--canopy-demo', ...handoff, '--extra'],
        ['--canopy-demo', '--canopy-open', 'x'.repeat(2049)],
        ['--canopy-demo', ...handoff, '--no-sandbox', '--extra'],
      ]) {
        const launched = startup(
          ['/electron', ...appPath, ...command],
          packaged,
          platform,
        );
        assert.equal(launched.demo, command[0] === '--canopy-demo');
        assert.equal(launched.state.rejected, true);
        assert.equal(launched.state.delivery, undefined);
        assert(launched.args.length <= 2);
      }
      for (const prefix of [
        ['--inspect=1', '--remote-debugging-port=0'],
        ['--remote-debugging-port=0', '--inspect=0'],
        ['--inspect=0'],
        ['--inspect=0', '--remote-debugging-port=1'],
      ]) {
        const launched = startup(
          ['/electron', ...prefix, ...appPath, '--canopy-demo', ...handoff],
          packaged,
          platform,
        );
        assert.equal(launched.demo, false);
        assert.equal(launched.state.rejected, true);
        assert.equal(launched.state.delivery, undefined);
      }
      const suffix = startup(
        ['/electron', ...appPath, '--canopy-demo', ...handoff, '--no-sandbox'],
        packaged,
        platform,
      );
      assert.equal(suffix.demo, true);
      assert.equal(
        suffix.state.rejected,
        platform === 'linux' ? undefined : true,
      );
      assert.equal(
        suffix.state.delivery?.intent.kind,
        platform === 'linux' ? 'view' : undefined,
      );
    });
  }
}
