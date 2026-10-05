import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import {
  auditArguments,
  installSampleCopySink,
} from './fixtures/handoff-audit-boundary';
import {
  launchHandoffArguments,
  WorkHandoffQueue,
} from '../src/main/work-handoff';

const require = createRequire(import.meta.url);
let directory: string;
let workflow: any;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'canopy-handoff-source-audit-'));
  await build({
    entryPoints: ['tools/handoff-audit.mjs'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(directory, 'audit.cjs'),
  });
  workflow = require(join(directory, 'audit.cjs'));
  await build({
    entryPoints: ['tests/fixtures/handoff-main.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(directory, 'fixture.cjs'),
    plugins: [
      {
        name: 'inert-fixture-launch',
        setup(b) {
          b.onResolve(
            { filter: /^(electron|\.\.\/\.\.\/src\/main\/app)$/ },
            (x) => ({ path: x.path, namespace: 'inert' }),
          );
          b.onLoad({ filter: /.*/, namespace: 'inert' }, (x) => ({
            contents:
              x.path === 'electron'
                ? 'export const app=globalThis.handoffRecreationBoundary.app; export const clipboard=globalThis.handoffRecreationBoundary.clipboard; export const shell=globalThis.handoffRecreationBoundary.shell;'
                : 'export const launch=globalThis.handoffRecreationBoundary.launch;',
            loader: 'js',
          }));
        },
      },
    ],
  });
  await build({
    entryPoints: ['tests/fixtures/handoff-audit-recreation.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(directory, 'recreation.cjs'),
  });
});
after(() => rm(directory, { recursive: true, force: true }));

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`exact pinned Playwright argv boundary: ${platform}`, async () => {
    const core = createRequire(
      createRequire(require.resolve('@playwright/test')).resolve('playwright'),
    ).resolve('playwright-core');
    assert.equal(
      JSON.parse(await readFile(join(dirname(core), 'package.json'), 'utf8'))
        .version,
      '1.63.0',
    );
    const pinned = await readFile(
      join(dirname(core), 'lib/coreBundle.js'),
      'utf8',
    );
    const begin = pinned.indexOf('let electronArguments = ["--inspect=0"');
    const end = pinned.indexOf('let artifactsDir;', begin);
    assert(begin > 0 && end > begin);
    const command = [
      '/sample/app',
      '--canopy-demo',
      '--canopy-open',
      'canopy://handoff/view?view=triage',
    ];
    const context: any = {
      options: { args: command },
      import_os14: { default: { platform: () => platform } },
    };
    runInNewContext(
      pinned.slice(begin, end) + 'globalThis.argv=electronArguments;',
      context,
    );
    const argv = ['/electron', ...context.argv];
    assert.deepEqual(
      launchHandoffArguments(argv, false, platform),
      command.slice(2),
    );
    const normalized = auditArguments(argv, platform);
    const parsed = launchHandoffArguments(normalized, false, platform);
    assert.deepEqual(parsed, command.slice(2));
    const q = new WorkHandoffQueue();
    try {
      q.receive(parsed);
      assert.equal(q.ready(() => {}).delivery?.intent.kind, 'view');
    } finally {
      q.stop();
    }
    assert.deepEqual(auditArguments(['/electron', ...command], platform), [
      '/electron',
      ...command,
    ]);
    for (const prefix of [
      ['--inspect=1', '--remote-debugging-port=0'],
      ['--remote-debugging-port=0', '--inspect=0'],
      ['--inspect=0'],
      ['--inspect=0', '--remote-debugging-port=1'],
      ['--no-sandbox', '--inspect=0'],
    ])
      assert.throws(() =>
        auditArguments(['/electron', ...prefix, ...command], platform),
      );
    const bad = auditArguments([...argv, '--unrecognized'], platform);
    assert.deepEqual(launchHandoffArguments(bad, false, platform), [
      '--invalid-canopy-command',
    ]);
    // A repeated prefix is rejected before production normalization.
    assert.throws(() =>
      auditArguments(
        [
          '/electron',
          ...context.argv.slice(0, context.argv.length - command.length),
          ...context.argv,
        ],
        platform,
      ),
    );
  });
}

test('sample sink isolates every main clipboard API without reading original formats', () => {
  let native = 0;
  const formats = {
    plain: 'original',
    html: '<b>original</b>',
    png: 'synthetic bytes',
  };
  const clipboard = {
    writeText(_text?: string) {
      native++;
    },
    readText() {
      native++;
    },
    writeHTML() {
      native++;
    },
    writeImage() {
      native++;
    },
    clear() {
      native++;
    },
  };
  const original = Object.getOwnPropertyDescriptors(clipboard);
  const sink = installSampleCopySink(clipboard);
  try {
    clipboard.writeText.call(clipboard, 'Reviewed text');
    assert.deepEqual(sink.inspect(), { count: 1, text: 'Reviewed text' });
    for (const name of [
      'readText',
      'writeHTML',
      'writeImage',
      'clear',
    ] as const)
      assert.throws(() => clipboard[name](), /denied/);
    assert.throws(() => clipboard.writeText(), /Invalid/);
    assert.equal(native, 0);
    assert.deepEqual(formats, {
      plain: 'original',
      html: '<b>original</b>',
      png: 'synthetic bytes',
    });
  } finally {
    sink.restore();
  }
  assert.deepEqual(Object.getOwnPropertyDescriptors(clipboard), original);
  sink.restore();
});

test('unsafe isolation fails before mutation and foreign replacement retains ownership', () => {
  const unsafe = Object.defineProperty({}, 'writeText', {
    value() {
      throw Error('native');
    },
    configurable: false,
  });
  assert.throws(() => installSampleCopySink(unsafe), /cannot be isolated/);
  const clipboard = { writeText() {}, readText() {} };
  const originalRead = clipboard.readText;
  const sink = installSampleCopySink(clipboard);
  const foreign = () => {};
  clipboard.writeText = foreign;
  assert.throws(() => sink.inspect(), /changed/);
  assert.throws(() => sink.restore(), /ownership changed/);
  assert.equal(clipboard.writeText, foreign);
  assert.equal(clipboard.readText, originalRead);
});

for (const primary of [undefined, null, false, 0, '', new Error('PRIMARY')]) {
  test(`exact primary presence survives secondary cleanup: ${String(primary)}`, async () => {
    const calls: string[] = [];
    const cleanup = new Error('CLEANUP');
    const transport = {
      deadline: async (fn: () => unknown) => fn(),
      owner: () => ({
        open: async () => {
          calls.push('open');
          throw primary;
        },
        shutdown: async () => {
          calls.push('shutdown');
          return { terminated: false, errors: [cleanup] };
        },
      }),
    };
    let caught = false;
    try {
      await workflow.runSampleAudit({
        transport,
        options: {},
        writeEvidence: async (e: any) => {
          assert.equal(e.profileRetained, true);
          assert.equal(e.confirmedOwnedAbsence, false);
          calls.push('evidence');
        },
      });
    } catch (error: any) {
      caught = true;
      assert(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.equal(error.errors[0], primary);
      assert(error.errors.includes(cleanup));
    }
    assert(caught);
    assert.deepEqual(calls, ['open', 'shutdown', 'evidence']);
  });
}

test('sample copy primary survives cleanup failure without touching original formats', async () => {
  for (const closeFails of [false, true]) {
    const primary = new Error('PRIMARY_FAILURE');
    const cleanup = new Error('CLEANUP_FAILURE');
    const formats = {
      plain: 'ORIGINAL',
      html: '<b>ORIGINAL</b>',
      png: 'SYNTHETIC_BYTES',
    };
    let nativeCalls = 0;
    const clipboard = {
      writeText(_text?: string) {
        nativeCalls++;
        formats.plain = 'LOST';
      },
      readText() {
        nativeCalls++;
        return formats.plain;
      },
    };
    const descriptors = Object.getOwnPropertyDescriptors(clipboard);
    const sink = installSampleCopySink(clipboard);
    const dialog = {
      getByLabel: () => ({ selectOption: async () => {} }),
      locator: () => ({ textContent: async () => 'COPIED' }),
      getByRole: () => ({
        click: async () => {
          clipboard.writeText('COPIED');
          throw primary;
        },
      }),
    };
    const page = {
      locator: () => ({ press: async () => {} }),
      getByRole: (role: string) =>
        role === 'dialog' ? dialog : { click: async () => {} },
    };
    let evals = 0;
    const transport = {
      deadline: async (fn: () => unknown) => fn(),
      owner: () => ({
        open: async () => ({
          firstWindow: async () => page,
          evaluate: async () => (++evals === 2 ? undefined : sink.inspect()),
        }),
        duplicate: async () => {},
        shutdown: async () => {
          sink.restore();
          return { terminated: true, errors: closeFails ? [cleanup] : [] };
        },
      }),
    };
    const expect = Object.assign(() => ({ toHaveAttribute: async () => {} }), {
      poll: () => ({ toBe: async () => {} }),
    });
    let caught: any;
    try {
      await workflow.runSampleAudit({
        transport,
        options: {},
        expect,
        writeEvidence: async () => {},
      });
    } catch (error) {
      caught = error;
    } finally {
      sink.restore();
    }
    if (closeFails) {
      assert(caught instanceof AggregateError);
      assert.equal(caught.cause, primary);
      assert.equal(caught.errors[0], primary);
      assert(caught.errors.includes(cleanup));
    } else assert.equal(caught, primary);
    assert.equal(nativeCalls, 0);
    assert.deepEqual(formats, {
      plain: 'ORIGINAL',
      html: '<b>ORIGINAL</b>',
      png: 'SYNTHETIC_BYTES',
    });
    assert.deepEqual(Object.getOwnPropertyDescriptors(clipboard), descriptors);
  }
});

// Model the shared transport boundary, never launch or signal an OS process.
for (const failure of [
  'none',
  'startup',
  'startup-timeout',
  'window',
  'duplicate',
  'duplicate-timeout',
  'copy',
  'shutdown',
  'shutdown-timeout',
  'unconfirmed-descendant',
  'evidence',
]) {
  test(`sample workflow ownership/failure matrix: ${failure}`, async () => {
    const sentinel = new Error(failure);
    const events: string[] = [];
    const clipboard = {
      writeText(_text?: unknown) {
        throw Error('Native clipboard forbidden');
      },
      readText() {
        throw Error('Native read forbidden');
      },
    };
    const original = Object.getOwnPropertyDescriptors(clipboard);
    const sink = installSampleCopySink(clipboard);
    const button = {
      click: async () => {
        clipboard.writeText('Reviewed');
        if (failure === 'copy') throw sentinel;
      },
    };
    const dialog = {
      getByLabel: () => ({ selectOption: async () => {} }),
      locator: () => ({ textContent: async () => 'Reviewed' }),
      getByRole: () => button,
    };
    const page = {
      locator: () => ({ press: async () => {} }),
      getByRole: (role: string) =>
        role === 'dialog' ? dialog : { click: async () => {} },
    };
    let evals = 0;
    const session = {
      firstWindow: async () => {
        if (failure === 'window') throw sentinel;
        return page;
      },
      evaluate: async () => (++evals === 2 ? undefined : sink.inspect()),
    };
    let owned = 0;
    const transport = {
      deadline: async (fn: () => unknown, ms: number, label: string) => {
        assert(ms > 0 && ms <= 90_000);
        events.push(label);
        if (
          (failure === 'startup-timeout' && label === 'Sample startup') ||
          (failure === 'duplicate-timeout' && label === 'Duplicate sample') ||
          (failure === 'shutdown-timeout' && label === 'Owned sample shutdown')
        ) {
          await fn();
          throw sentinel;
        }
        return fn();
      },
      owner: () => {
        const id = ++owned;
        events.push(`own-${id}`);
        return {
          open: async () => {
            events.push('open');
            if (failure === 'startup') throw sentinel;
            return session;
          },
          duplicate: async () => {
            events.push('duplicate');
            if (failure === 'duplicate') throw sentinel;
          },
          shutdown: async () => {
            events.push(`shutdown-${id}`);
            if (failure === 'shutdown') throw sentinel;
            sink.restore();
            return {
              terminated: failure !== 'unconfirmed-descendant',
              errors: [],
            };
          },
        };
      },
    };
    const expect = Object.assign(() => ({ toHaveAttribute: async () => {} }), {
      poll: () => ({ toBe: async () => {} }),
    });
    let thrown: any;
    try {
      await workflow.runSampleAudit({
        transport,
        options: {},
        expect,
        writeEvidence: async (e: any) => {
          assert.equal(e.systemClipboard, 'NOT RUN');
          assert.equal(e.profileRetained, true);
          if (failure === 'evidence') throw sentinel;
        },
      });
    } catch (e) {
      thrown = e;
    } finally {
      sink.restore();
    }
    assert.equal(!!thrown, failure !== 'none');
    if (
      [
        'startup',
        'startup-timeout',
        'window',
        'duplicate',
        'duplicate-timeout',
        'copy',
      ].includes(failure)
    )
      assert.equal(thrown, sentinel);
    assert.deepEqual(Object.getOwnPropertyDescriptors(clipboard), original);
    assert(events.indexOf('own-1') < events.indexOf('open'));
    if (events.includes('duplicate'))
      assert(events.indexOf('own-2') < events.indexOf('duplicate'));
    for (let i = 1; i <= owned; i++) assert(events.includes(`shutdown-${i}`));
  });
}

test('native entry and desktop launcher stop before staging, launch, profile or clipboard access', async () => {
  for (const entry of ['tools/handoff-check.mjs', 'tools/desktop.mjs']) {
    const cwd = await mkdtemp(join(directory, 'gate-'));
    const result = spawnSync(
      process.execPath,
      [resolve(entry), 'handoff-check'],
      { cwd, encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Pass one freshly reviewed exact head/);
    assert.deepEqual(await readdir(cwd), []);
  }
});

for (const scenario of [
  'error',
  'undefined',
  'null',
  'false',
  'zero',
  'empty',
  'foreign',
  'inspection-data',
  'inspection-accessor',
  'inspection-fixed',
]) {
  test(`actual live fixture recreation preserves sink: ${scenario}`, async (t) => {
    const profile = await mkdtemp(
      join(tmpdir(), 'canopy-handoff-audit-recreation-'),
    );
    t.after(() => rm(profile, { recursive: true, force: true }));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(profile, 'handoff-audit.json'),
      JSON.stringify({
        kind: 'canopy-handoff-audit',
        reviewedHead: 'e0fd9e018f25594577ae0dd43df406eddf060af7',
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        join(directory, 'recreation.cjs'),
        join(directory, 'fixture.cjs'),
        profile,
        scenario,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    if (scenario.startsWith('inspection-'))
      assert.match(
        result.stdout,
        /PASS foreign inspection descriptor retained before UI/,
      );
    else assert.match(result.stdout, /"resetFailureIsolated":true/);
    if (
      !['error', 'foreign'].includes(scenario) &&
      !scenario.startsWith('inspection-')
    )
      assert.match(result.stdout, /PASS natural Node exit restoration/);
  });
}
