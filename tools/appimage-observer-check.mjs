import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  boundedHash,
  boundedRead,
  canopyPolicyEvidence,
  childPids,
  diagnosticCommand,
  mountedEvidence,
  mountedPath,
  observeAppImageLaunch,
  processIdentity,
  recordCanopyPolicy,
  runtimeIdentity,
} from './appimage-observer.mjs';

const processStat = (parent = 50, birth = '123') =>
  `70 (name with ) parentheses) S ${parent} ${Array(17).fill('0').join(' ')} ${birth}`;
const artifact = '/release/Canopy.AppImage';
const mount = '/tmp/.mount_CanopyABC123';
const mountinfo = `25 1 0:100 / ${mount} ro,nosuid,nodev - fuse.Canopy ${artifact} ro,user_id=1001`;
const config = {
  parent: 50,
  uid: 1001,
  baseline: [],
  artifact,
  executableSha256: 'binary',
  appAsarSha256: 'asar',
};
const identity = { parent: 50, birth: '123' };
const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
const missing = Object.assign(new Error('gone'), { code: 'ENOENT' });

export async function checkAppImageObserver() {
  assert.deepEqual(processIdentity(processStat()), identity);
  assert.throws(() => processIdentity('invalid'));
  assert.deepEqual(childPids('70 71\n'), [70, 71]);
  assert.throws(() => childPids('70\nforeign'));
  assert.equal(
    mountedPath(`${mount}/canopy`, mountinfo).options,
    'ro,nosuid,nodev',
  );
  for (const [path, mounts] of [
    ['/extracted/canopy', mountinfo],
    ['/tmp/.mount_OtherABC/canopy', mountinfo],
    [`${mount}/other`, mountinfo],
    [`${mount}/canopy`, ''],
    [`${mount}/canopy`, mountinfo.replace('fuse.Canopy', 'ext4')],
  ])
    assert.throws(() => mountedPath(path, mounts));

  const runtime = {
    read: async () => processStat(),
    link: async () => artifact,
    stat: async () => ({ uid: 1001 }),
  };
  assert.deepEqual(await runtimeIdentity(70, config, runtime), identity);
  for (const [changes, effects] of [
    [{ baseline: [70] }, runtime],
    [{ parent: 999 }, runtime],
    [{ uid: 0 }, runtime],
    [{}, { ...runtime, link: async () => '/foreign.AppImage' }],
    [
      {},
      {
        ...runtime,
        read: async () => {
          throw missing;
        },
      },
    ],
  ])
    await assert.rejects(
      runtimeIdentity(70, { ...config, ...changes }, effects),
    );
  let reads = 0;
  await assert.rejects(
    runtimeIdentity(70, config, {
      ...runtime,
      read: async () => processStat(50, ++reads === 1 ? '123' : '456'),
    }),
    /identity changed/,
  );

  const calls = [];
  const mounted = {
    read: async (path) => {
      calls.push(path);
      if (path.endsWith('/stat')) return processStat();
      if (path.endsWith('/mountinfo')) return mountinfo;
      if (path.endsWith('/attr/current')) return 'unconfined\n';
      throw new Error(`Out-of-scope read: ${path}`);
    },
    link: async (path) => {
      assert.equal(path, '/proc/70/exe');
      return `${mount}/canopy`;
    },
    canonical: async (path) => path,
    hash: async (path) => (path.endsWith('/canopy') ? 'binary' : 'asar'),
    stat: async (path) => ({
      uid: path === '/proc/70/' ? 1001 : 0,
      gid: 0,
      mode: 0o755,
    }),
  };
  const sample = await mountedEvidence(70, identity, config, mounted);
  assert.equal(sample.apparmorContext, 'unconfined');
  assert.equal(sample.sandboxHelper.mode, '755');
  assert.equal(sample.mount.filesystem, 'fuse.Canopy');
  assert.equal(sample.mount.path, mount);
  assert(!calls.some((path) => /environ|cmdline/.test(path)));
  for (const effects of [
    {
      ...mounted,
      read: async () => {
        throw denied;
      },
    },
    {
      ...mounted,
      read: async () => {
        throw missing;
      },
    },
    { ...mounted, link: async () => '/foreign/canopy' },
    { ...mounted, canonical: async () => '/foreign/chrome-sandbox' },
    { ...mounted, hash: async () => 'foreign' },
    { ...mounted, stat: async () => ({ uid: 999, mode: 0o755 }) },
  ])
    await assert.rejects(mountedEvidence(70, identity, config, effects));
  reads = 0;
  await assert.rejects(
    mountedEvidence(70, identity, config, {
      ...mounted,
      read: async (path) =>
        path.endsWith('/stat')
          ? processStat(50, ++reads === 1 ? '123' : '456')
          : mounted.read(path),
    }),
    /identity changed/,
  );
  let links = 0;
  await assert.rejects(
    mountedEvidence(70, identity, config, {
      ...mounted,
      link: async () => (++links === 1 ? `${mount}/canopy` : '/foreign/canopy'),
    }),
    /Executable changed/,
  );

  const hosted = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
  };
  const policyCalls = [];
  const policy = {
    stat: async (path) => {
      policyCalls.push(path);
      throw missing;
    },
    command: async (command, args) => {
      policyCalls.push([command, args]);
      return { error: 'read denied' };
    },
  };
  assert.deepEqual(await canopyPolicyEvidence({}, policy), {
    unavailable: 'Not a disposable GitHub-hosted runner',
  });
  assert.deepEqual(
    await canopyPolicyEvidence(
      { ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' },
      policy,
    ),
    { unavailable: 'Not a disposable GitHub-hosted runner' },
  );
  assert.deepEqual(policyCalls, []);
  assert.deepEqual(await canopyPolicyEvidence(hosted, policy), {
    profile: { present: false },
    loaded: { error: 'read denied' },
  });
  assert.deepEqual(policyCalls, [
    '/etc/apparmor.d/canopy',
    [
      'sudo',
      [
        '-n',
        'timeout',
        '--signal=KILL',
        '0.4s',
        'grep',
        '-E',
        '^canopy( |$)',
        '/sys/kernel/security/apparmor/profiles',
      ],
    ],
  ]);

  const temporary = await mkdtemp(join(tmpdir(), 'canopy-observer-controls-'));
  try {
    // Official electron-v44.3.0-linux-x64.zip lists electron at 228130120 bytes.
    // The sparse fixture has independent nonzero endpoints and a precomputed
    // whole-file digest; it exercises the real reader, not effects.hash.
    const payload = join(temporary, 'supported-size-payload');
    const supportedSize = 228130120;
    const file = await open(payload, 'wx');
    try {
      await file.truncate(supportedSize);
      const beginning = Buffer.from('supported Linux-size fixture');
      await file.write(beginning, 0, beginning.length, 0);
      const ending = Buffer.from('end of supported-size payload');
      await file.write(ending, 0, ending.length, supportedSize - ending.length);
    } finally {
      await file.close();
    }
    assert.equal(
      await boundedHash(payload),
      '18c1ac4cf37374b57602a174da8659d24543b8123792bfad33bb97035eb279d1',
    );
    const oversized = await open(payload, 'r+');
    try {
      await oversized.truncate(256 * 1024 * 1024 + 1);
    } finally {
      await oversized.close();
    }
    await assert.rejects(boundedHash(payload), /hash limit/);
    await rm(payload);
    await assert.rejects(boundedHash(payload), { code: 'ENOENT' });
    await assert.rejects(boundedHash(temporary));

    // Execute the exact reader with a real file that changes immediately after
    // its first physical read. There are no timing races or mock digest results.
    const readerSource = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), 'appimage-observer.mjs'),
      'utf8',
    );
    const readerStart = readerSource.indexOf(
      'export async function boundedHash(',
    );
    const readerEnd = readerSource.indexOf('const io =', readerStart);
    assert(readerStart >= 0 && readerEnd > readerStart);
    const makeReader = new Function(
      'open',
      'createHash',
      'MAX_HASH',
      `${readerSource.slice(readerStart, readerEnd).replace('export ', '')} return boundedHash;`,
    );
    for (const change of ['grow', 'shrink']) {
      await writeFile(
        payload,
        change === 'grow' ? 'small retained payload' : Buffer.alloc(65537),
      );
      let modified = false;
      const changingReader = makeReader(
        async (...args) => {
          const handle = await open(...args);
          return {
            stat: () => handle.stat(),
            close: () => handle.close(),
            read: async (...readArgs) => {
              assert(
                readArgs[1] === 0 && readArgs[2] <= 65536,
                'Fixed streaming buffer exceeded',
              );
              const result = await handle.read(...readArgs);
              if (!modified) {
                modified = true;
                const writer = await open(payload, 'r+');
                try {
                  await writer.truncate(change === 'grow' ? 100 : 0);
                } finally {
                  await writer.close();
                }
              }
              return result;
            },
          };
        },
        createHash,
        256 * 1024 * 1024,
      );
      await assert.rejects(
        changingReader(payload),
        change === 'grow' ? /changed during/ : /disappeared during/,
      );
      assert(modified);
    }
    const path = join(temporary, 'modeled-proc-input');
    await writeFile(path, 'small retained input');
    assert.equal(await boundedRead(path), 'small retained input');
    await writeFile(path, 'x'.repeat(65537));
    await assert.rejects(boundedRead(path), /exceeds limit/);
    await rm(path);
    await assert.rejects(boundedRead(path), { code: 'ENOENT' });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  // Run the exact snapshot function with denied/failed/hanging filesystem effects.
  // Its timeout/catch must not interrupt an already-failing installer cleanup.
  const makeSnapshot = new Function(
    'dirname',
    'mkdir',
    'writeFile',
    'canopyPolicyEvidence',
    'console',
    'message',
    'setTimeout',
    'clearTimeout',
    `return (${recordCanopyPolicy.toString()});`,
  );
  for (const stage of ['mkdir', 'policy', 'write', 'timeout']) {
    const snapshotLogs = [];
    const stages = [];
    const fail = (current) => {
      stages.push(current);
      if (current === stage) throw denied;
    };
    const snapshot = makeSnapshot(
      dirname,
      async () => fail('mkdir'),
      async () => fail('write'),
      async () => {
        fail('policy');
        if (stage === 'timeout') return new Promise(() => {});
        return {};
      },
      { error: (...args) => snapshotLogs.push(args) },
      (error) => ({ error: error.message }),
      (callback) => setTimeout(callback, 10),
      clearTimeout,
    );
    await snapshot('/owned/diagnostics/policy.json', 'before DEB removal');
    assert.equal(snapshotLogs.length, 1, stage);
    assert.equal(
      snapshotLogs[0][1].error,
      stage === 'timeout' ? 'Policy snapshot timed out' : denied.message,
    );
    assert.deepEqual(
      stages,
      stage === 'mkdir'
        ? ['mkdir']
        : stage === 'write'
          ? ['mkdir', 'policy', 'write']
          : ['mkdir', 'policy'],
    );
  }
  // Exercise actual bounded reader with Node only, never native application or policy.
  const node = process.env.JS_BINARY__NODE_BINARY ?? process.execPath;
  assert.deepEqual(
    await diagnosticCommand(node, [
      '-e',
      "process.stdout.write('owned evidence')",
    ]),
    { output: 'owned evidence' },
  );
  assert.match(
    (
      await diagnosticCommand(node, [
        '-e',
        "process.stdout.write('x'.repeat(100000))",
      ])
    ).error,
    /exceeds limit/,
  );
  assert.match(
    (await diagnosticCommand(node, ['-e', 'setTimeout(() => {}, 10000)'], 25))
      .error,
    /timed out/,
  );
  assert.match(
    (await diagnosticCommand(node, ['-e', 'process.exit(1)'])).error,
    /unavailable/,
  );
  // Execute the exact production launch-selection block with Electron replaced.
  const source = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), 'packaged-smoke.mjs'),
    'utf8',
  );
  const observerSource = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), 'appimage-observer.mjs'),
    'utf8',
  );
  const workerBegin = observerSource.indexOf('async function worker(config) {');
  const workerEnd = observerSource.indexOf(
    '\nasync function startObserver',
    workerBegin,
  );
  assert(workerBegin >= 0 && workerEnd > workerBegin);
  const ipcDirectory = await mkdtemp(join(tmpdir(), 'canopy-observer-ipc-'));
  try {
    const fixture = join(ipcDirectory, 'worker.mjs');
    await writeFile(
      fixture,
      `
      import { mkdir, writeFile } from 'node:fs/promises';
      import { dirname } from 'node:path';
      const LIMIT = 10000;
      const message = error => ({error: error?.code ?? error?.message ?? String(error)});
      const io = {read: async () => {throw new Error('fixture proc unavailable')}};
      ${observerSource.slice(workerBegin, workerEnd)}
      const [mode, output] = process.argv.slice(2);
      if (mode === 'already-disconnected') process.disconnect();
      if (mode === 'ready-send-race') {
        const send = process.send.bind(process);
        process.send = (...args) => {process.disconnect(); return send(...args)};
      }
      await worker({artifact: '/fixture/Canopy.AppImage', parent: process.ppid,
        parentBirth: 'fixture', baseline: [], output, deadline: Date.now() + 2000});
    `,
    );
    for (const mode of [
      'already-disconnected',
      'parent-disconnect',
      'ready-send-race',
      'completion',
    ]) {
      const output = join(ipcDirectory, `${mode}.json`);
      const child = fork(fixture, [mode, output], {
        execPath: process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        execArgv: [],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const deadline = setTimeout(() => child.kill('SIGKILL'), 4000);
      try {
        child.on('message', (value) => {
          assert.equal(value, 'ready');
          if (mode === 'parent-disconnect') child.disconnect();
          if (mode === 'completion') child.send('stop', () => {});
        });
        const result = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code, signal) => resolve({ code, signal }));
        });
        assert.deepEqual(result, { code: 0, signal: null }, stderr);
        assert.doesNotMatch(stderr, /ERR_IPC_DISCONNECTED|Unhandled/);
        const retained = JSON.parse(await readFile(output, 'utf8'));
        assert.equal(retained.completed, true);
        assert.equal(retained.status, 'unknown');
        assert.deepEqual(retained.samples, []);
        if (mode === 'ready-send-race')
          assert(
            retained.limitations.some(
              (item) => item.error === 'ERR_IPC_CHANNEL_CLOSED',
            ),
          );
        assert.match(
          retained.kernelAudit.unavailable,
          /No retained launch identity/,
        );
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      }
    }
  } finally {
    await rm(ipcDirectory, { recursive: true, force: true });
  }
  const begin = source.indexOf('      const createApplication =');
  const end = source.indexOf('      page = await app.firstWindow();', begin);
  assert(begin >= 0 && end > begin);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const executeLaunch = new AsyncFunction(
    'dependencies',
    `const {electron, executablePath, env, identity, restart, workspace, artifact, join, observeAppImageLaunch} = dependencies; let app; ${source.slice(begin, end)} return app;`,
  );
  for (const paths of [posix, win32, { join }]) {
    for (const identity of [undefined, { ...config, appImage: artifact }]) {
      for (const restart of [false, true]) {
        let launches = 0;
        let observers = 0;
        const original = new Error('renderer exited before application handle');
        for (const failure of [false, true]) {
          launches = 0;
          observers = 0;
          const invoke = () =>
            executeLaunch({
              electron: {
                launch: async (options) => {
                  launches++;
                  assert.deepEqual(options, {
                    executablePath: artifact,
                    env: hosted,
                    chromiumSandbox: true,
                    timeout: 30000,
                  });
                  if (failure) throw original;
                  return 'production result';
                },
              },
              executablePath: artifact,
              env: hosted,
              identity,
              restart,
              workspace: '/workspace',
              artifact: 'Canopy.AppImage',
              join: paths.join,
              observeAppImageLaunch: async (options, launch) => {
                observers++;
                assert.equal(options.artifact, artifact);
                assert.equal(
                  options.output,
                  paths.join(
                    '/workspace',
                    '.cache',
                    'smoke-failure',
                    'Canopy.AppImage',
                    'mounted-launch.json',
                  ),
                );
                return observeAppImageLaunch(options, launch, {
                  env: hosted,
                  platform: 'linux',
                  start: async () => async () => {},
                });
              },
            });
          if (failure)
            await assert.rejects(invoke(), (error) => error === original);
          else assert.equal(await invoke(), 'production result');
          assert.equal(launches, 1);
          assert.equal(observers, identity && !restart ? 1 : 0);
        }
      }
    }
  }
  const primary = new Error('early native startup failure');
  const consoleError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    for (const start of [
      async () => {
        throw denied;
      },
      async () => async () => {
        throw denied;
      },
      async () => async () => {},
      async () => async () => new Promise(() => {}),
    ]) {
      let launches = 0;
      await assert.rejects(
        observeAppImageLaunch(
          config,
          async () => {
            launches++;
            throw primary;
          },
          { env: hosted, platform: 'linux', start },
        ),
        (error) => error === primary,
      );
      assert.equal(launches, 1);
      assert.equal(
        await observeAppImageLaunch(
          config,
          async () => 'ordinary launch result',
          { env: hosted, platform: 'linux', start },
        ),
        'ordinary launch result',
      );
    }
    let starts = 0;
    assert.equal(
      await observeAppImageLaunch(config, async () => 'local result', {
        env: {},
        platform: 'linux',
        start: async () => {
          starts++;
        },
      }),
      'local result',
    );
    assert.equal(starts, 0);
    assert(logs.length > 0);
  } finally {
    console.error = consoleError;
  }
}
