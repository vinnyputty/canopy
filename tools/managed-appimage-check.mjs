import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import {
  managedGuard,
  managedOperation,
  managedPaths as paths,
  managedPolicy,
  managedProfile,
  withManagedAppImage,
  acceptManagedObservation,
  noManagedOccupants,
} from './managed-appimage.mjs';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const ctx = {
  platform: 'linux',
  arch: 'x64',
  uid: 1001,
  osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' },
  env: {
    CANOPY_MANAGED_APPIMAGE: '1',
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    ImageOS: 'ubuntu24',
    ImageVersion: '20260928.1.0',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKSPACE: '/workspace',
  },
};
const text = (parent, birth) =>
  `70 (fixture) S ${parent} ${Array(17).fill('0').join(' ')} ${birth}`;
const base = {
  uid: 1001,
  run: '123',
  attempt: '1',
  parent: { pid: 50, birth: '321' },
  token: 'a'.repeat(32),
  source: '/workspace/release/Canopy-1.0.0-linux-x86_64.AppImage',
  sha256: hash('original'),
  executableSha256: hash('binary'),
  appAsarSha256: hash('asar'),
  helperSha256: hash('helper'),
  helperMode: '755',
};
function model(failure) {
  let inode = 1;
  const files = new Map(),
    calls = [];
  const make = (path, content, mode, uid = 0, directory = false) => {
    files.set(path, {
      content,
      meta: {
        dev: 1,
        ino: inode++,
        uid,
        gid: 0,
        mode: (directory ? 0o40000 : 0o100000) | mode,
        nlink: directory ? 2 : 1,
        size: content.length,
        mtimeMs: 1,
        ctimeMs: 1,
      },
      directory,
    });
  };
  for (const path of [
    '/',
    '/opt',
    '/etc',
    '/etc/apparmor.d',
    '/workspace',
    '/workspace/release',
  ])
    make(path, '', 0o755, 0, true);
  make(base.source, 'original', 0o755, 1001);
  let loaded = false,
    occupancy = false,
    unknown = false;
  const profilePath =
    '/sys/kernel/security/apparmor/policy/profiles/canopy-appimage.1';
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const io = {
    canonical: async (path) => path,
    lstat: async (path) => {
      if (path.startsWith('/proc/')) return { uid: 1001 };
      if (path === profilePath)
        return { ...files.get('/').meta, mode: 0o40755 };
      const file = files.get(path);
      if (!file) throw missing();
      return {
        ...file.meta,
        isFile: () => !file.directory,
        isDirectory: () => file.directory,
        isSymbolicLink: () => !!file.symlink,
      };
    },
    read: async (path) => {
      if (path === paths.receipt)
        return (
          files.get(path)?.content ??
          (() => {
            throw missing();
          })()
        );
      if (path === '/sys/module/apparmor/parameters/enabled') return 'Y\n';
      if (path.startsWith('/proc/sys/')) return '1\n';
      if (path === '/sys/kernel/security/apparmor/profiles')
        return loaded ? managedProfile + ' (unconfined)\n' : '';
      if (path === profilePath + '/name') return managedProfile;
      if (path === profilePath + '/attach') return paths.original;
      if (path === profilePath + '/mode') return 'unconfined';
      if (path === profilePath + '/hash') return 'd'.repeat(64);
      if (path.endsWith('/attr/current')) {
        if (unknown) throw new Error('unreadable live task');
        return occupancy ? managedProfile + ' (unconfined)' : 'unconfined';
      }
      if (path === '/proc/50/stat') return text(1, '321');
      if (path === '/proc/70/stat') return text(50, '123');
      if (path === '/proc/80/stat') return text(70, '456');
      if (files.has(path)) return files.get(path).content;
      throw missing();
    },
    hash: async (path) =>
      hash(
        files.get(path)?.content ??
          (() => {
            throw missing();
          })(),
      ),
    list: async (path) => {
      if (path === '/proc') return ['50'];
      if (path === '/proc/50/task') return ['50'];
      if (path === '/sys/kernel/security/apparmor/policy/profiles')
        return loaded ? ['canopy-appimage.1'] : [];
      return [...files.keys()]
        .filter(
          (key) =>
            key !== path &&
            key.startsWith(path + '/') &&
            !key.slice(path.length + 1).includes('/'),
        )
        .map((key) => key.slice(path.length + 1));
    },
    link: async () => '/usr/bin/node',
    mkdir: async (path, mode) => {
      assert(!files.has(path));
      calls.push('mkdir');
      make(path, '', mode, 0, true);
      if (failure === 'directory-stat')
        io.lstat = async (p) => {
          if (p === paths.directory) throw null;
          return { uid: 1001 };
        };
    },
    create: async (path, content, mode, onCreated) => {
      assert(!files.has(path));
      calls.push('create:' + path);
      make(path, '', mode);
      await onCreated(await io.lstat(path));
      if (failure === 'policy-write' && path === paths.policy) {
        files.get(path).content = 'partial';
        files.get(path).meta.size = 7;
        throw new Error('policy write');
      }
      files.get(path).content = content();
      files.get(path).meta.size = files.get(path).content.length;
      if (failure === 'receipt-write' && path === paths.receipt)
        throw new Error('receipt write');
    },
    copy: async (source, path, mode, onCreated) => {
      calls.push('copy');
      make(path, '', mode);
      await onCreated(await io.lstat(path));
      files.get(path).content =
        failure === 'partial-copy' ? 'part' : files.get(source).content;
      files.get(path).meta.size = files.get(path).content.length;
      if (failure === 'partial-copy') throw new Error('partial copy');
      if (failure === 'copy-hash') files.get(path).content = 'changed!';
    },
    receipt: async (content, expected) => {
      calls.push('receipt');
      assert.equal(files.get(paths.receipt).meta.ino, expected.ino);
      files.get(paths.receipt).content = content;
      files.get(paths.receipt).meta.size = content.length;
    },
    parser: async (operation) => {
      calls.push('parser:' + operation);
      if (operation === 'add') {
        if (failure === 'parser') throw new Error('parser failed');
        loaded = true;
        if (failure === 'load-status')
          io.read = async () => {
            throw new Error('status unreadable');
          };
      } else loaded = false;
    },
    remove: async (path, kind) => {
      calls.push('remove:' + path);
      assert(files.has(path));
      if (kind === 'directory') assert.equal((await io.list(path)).length, 0);
      files.delete(path);
    },
  };
  io.stat = io.lstat;
  return {
    io,
    files,
    calls,
    make,
    setLoaded: (value) => {
      loaded = value;
    },
    setOccupied: (value) => {
      occupancy = value;
    },
    setUnknown: (value) => {
      unknown = value;
    },
  };
}
export async function checkManagedAppImage() {
  assert.equal(
    managedPolicy,
    'abi <abi/4.0>,\ninclude <tunables/global>\nprofile canopy-appimage /opt/Canopy/Canopy.AppImage flags=(unconfined) {\n  userns,\n}\n',
  );
  for (const change of [
    { platform: 'darwin' },
    { platform: 'win32' },
    { arch: 'arm64' },
    { uid: 0 },
  ])
    assert.throws(() => managedGuard({ ...ctx, ...change }));
  for (const [key, value] of Object.entries({
    CANOPY_MANAGED_APPIMAGE: '0',
    GITHUB_ACTIONS: 'false',
    RUNNER_ENVIRONMENT: 'self-hosted',
    RUNNER_OS: 'macOS',
    RUNNER_ARCH: 'ARM64',
    ImageOS: 'ubuntu22',
    ImageVersion: 'unknown',
    GITHUB_RUN_ID: 'x',
    GITHUB_RUN_ATTEMPT: '0',
    GITHUB_WORKSPACE: 'relative',
  }))
    assert.throws(() =>
      managedGuard({ ...ctx, env: { ...ctx.env, [key]: value } }),
    );
  assert.throws(() => managedGuard({ ...ctx, env: {} }));
  const m = model();
  const installed = await managedOperation(
    { ...base, operation: 'prepare' },
    m.io,
    ctx,
  );
  assert.equal(m.files.get(paths.original).content, 'original');
  assert.equal(m.files.get(paths.original).meta.uid, 0);
  assert.equal(m.files.get(paths.original).meta.mode & 0o7777, 0o555);
  assert.equal(installed.receipt.source.sha256, base.sha256);
  assert.equal(installed.receipt.profile.content, managedPolicy);
  assert.equal(installed.receipt.resources.length, 3);
  assert.equal(m.calls.filter((call) => call === 'parser:add').length, 1);
  assert.equal(
    (await managedOperation({ ...base, operation: 'check' }, m.io, ctx))
      .receiptSha256,
    installed.receiptSha256,
  );
  const originalCalls = [...m.calls];
  const live = model();
  await managedOperation({ ...base, operation: 'prepare' }, live.io, ctx);
  const realRead = live.io.read,
    realStat = live.io.stat,
    realHash = live.io.hash;
  const mount = '/tmp/.mount_CanopyFIXTURE';
  live.io.read = async (path) =>
    path.endsWith('/attr/current')
      ? managedProfile + ' (unconfined)'
      : path.endsWith('/mountinfo')
        ? '25 1 0:100 / ' +
          mount +
          ' ro,nosuid,nodev - fuse.Canopy ' +
          paths.original +
          ' ro'
        : path === '/proc/80/status'
          ? 'NoNewPrivs: 1\nSeccomp: 2\n'
          : realRead(path);
  live.io.stat = async (path) =>
    path.endsWith('chrome-sandbox')
      ? { uid: 0, gid: 0, mode: 0o100755 }
      : realStat(path);
  live.io.hash = async (path) =>
    path === mount + '/canopy'
      ? base.executableSha256
      : path === mount + '/resources/app.asar'
        ? base.appAsarSha256
        : path === mount + '/chrome-sandbox'
          ? base.helperSha256
          : realHash(path);
  live.io.link = async () => mount + '/canopy';
  const launch = {
    pid: 70,
    mainBirth: '123',
    rootPid: 70,
    rootBirth: '123',
    rendererPid: 80,
    rendererBirth: '456',
  };
  const proof = await managedOperation(
    { ...base, operation: 'launch', launch },
    live.io,
    ctx,
  );
  assert.equal(
    proof.launch.sample.apparmorContext,
    managedProfile + ' (unconfined)',
  );
  assert.equal(proof.launch.sample.sandboxHelper.sha256, base.helperSha256);
  for (const change of [
    { rootBirth: '124' },
    { mainBirth: '124' },
    { rendererBirth: '457' },
    { rendererPid: 70 },
    { rootPid: 71 },
  ])
    await assert.rejects(
      managedOperation(
        { ...base, operation: 'launch', launch: { ...launch, ...change } },
        live.io,
        ctx,
      ),
    );
  const goodRead = live.io.read;
  live.io.read = async (path) =>
    path.endsWith('/attr/current') ? 'unconfined' : goodRead(path);
  await assert.rejects(
    managedOperation({ ...base, operation: 'launch', launch }, live.io, ctx),
  );
  live.io.read = async (path) =>
    path === '/proc/80/status' ? 'NoNewPrivs: 0\nSeccomp: 0\n' : goodRead(path);
  await assert.rejects(
    managedOperation({ ...base, operation: 'launch', launch }, live.io, ctx),
  );
  live.io.read = goodRead;
  const goodStat = live.io.stat;
  live.io.stat = async (path) =>
    path.endsWith('chrome-sandbox')
      ? { uid: 1001, gid: 0, mode: 0o100755 }
      : goodStat(path);
  await assert.rejects(
    managedOperation({ ...base, operation: 'launch', launch }, live.io, ctx),
  );
  live.io.stat = goodStat;
  live.io.hash = async (path) =>
    path.endsWith('chrome-sandbox') ? 'f'.repeat(64) : realHash(path);
  await assert.rejects(
    managedOperation({ ...base, operation: 'launch', launch }, live.io, ctx),
  );
  await assert.rejects(
    managedOperation({ ...base, operation: 'prepare' }, m.io, ctx),
  );
  assert.deepEqual(m.calls, originalCalls, 'collision must not mutate');
  for (const path of Object.values(paths)) {
    const collision = model();
    collision.make(path, 'foreign', 0o444);
    await assert.rejects(
      managedOperation({ ...base, operation: 'prepare' }, collision.io, ctx),
    );
    assert.deepEqual(collision.calls, []);
  }
  const collision = model();
  collision.setLoaded(true);
  await assert.rejects(
    managedOperation({ ...base, operation: 'prepare' }, collision.io, ctx),
  );
  assert.deepEqual(collision.calls, []);
  for (const mutation of [
    (model) => {
      model.files.get('/opt').meta.uid = 1001;
    },
    (model) => {
      model.files.get('/etc/apparmor.d').symlink = true;
    },
    (model) => {
      model.files.get('/opt').meta.mode |= 0o002;
    },
    (model) => {
      model.files.get(base.source).symlink = true;
    },
    (model) => {
      model.files.get(base.source).meta.ino = NaN;
    },
    (model) => {
      model.files.get(base.source).content = 'wrong';
    },
  ]) {
    const bad = model();
    mutation(bad);
    await assert.rejects(
      managedOperation({ ...base, operation: 'prepare' }, bad.io, ctx),
    );
    assert.deepEqual(bad.calls, []);
  }
  for (const failure of [
    'receipt-write',
    'partial-copy',
    'copy-hash',
    'policy-write',
    'parser',
  ]) {
    const partial = model(failure);
    await assert.rejects(
      managedOperation({ ...base, operation: 'prepare' }, partial.io, ctx),
    );
    await managedOperation({ ...base, operation: 'cleanup' }, partial.io, ctx);
    for (const path of Object.values(paths))
      assert(!partial.files.has(path), failure);
  }
  for (const mutation of [
    (model) => {
      model.files.get(paths.original).content = 'modified';
    },
    (model) => {
      model.files.get(paths.receipt).meta.uid = 1001;
    },
    (model) => {
      const value = JSON.parse(model.files.get(paths.receipt).content);
      value.token = 'b'.repeat(32);
      model.files.get(paths.receipt).content = JSON.stringify(value);
    },
    (model) => {
      model.files.get(paths.policy).symlink = true;
    },
    (model) => {
      model.setOccupied(true);
    },
    (model) => {
      model.setUnknown(true);
    },
    (model) => {
      model.make(paths.directory + '/foreign', 'foreign', 0o444);
    },
  ]) {
    const bad = model();
    await managedOperation({ ...base, operation: 'prepare' }, bad.io, ctx);
    mutation(bad);
    await assert.rejects(
      managedOperation({ ...base, operation: 'cleanup' }, bad.io, ctx),
    );
    assert(
      bad.files.has(paths.original) &&
        bad.files.has(paths.policy) &&
        bad.files.has(paths.receipt),
    );
    assert(!bad.calls.includes('parser:remove'));
  }
  const lateOccupant = model();
  await managedOperation(
    { ...base, operation: 'prepare' },
    lateOccupant.io,
    ctx,
  );
  let cleanupHashes = 0;
  const ownedHash = lateOccupant.io.hash;
  lateOccupant.io.hash = async (path) => {
    if (path === paths.original && ++cleanupHashes === 2)
      lateOccupant.setOccupied(true);
    return ownedHash(path);
  };
  await assert.rejects(
    managedOperation({ ...base, operation: 'cleanup' }, lateOccupant.io, ctx),
  );
  assert(!lateOccupant.calls.includes('parser:remove'));
  assert(lateOccupant.files.has(paths.original));
  const statusFailure = model('load-status');
  await assert.rejects(
    managedOperation({ ...base, operation: 'prepare' }, statusFailure.io, ctx),
  );
  await assert.rejects(
    managedOperation({ ...base, operation: 'cleanup' }, statusFailure.io, ctx),
  );
  assert(
    statusFailure.files.has(paths.original) &&
      statusFailure.files.has(paths.receipt),
  );
  assert(!statusFailure.calls.includes('parser:remove'));
  await managedOperation({ ...base, operation: 'cleanup' }, m.io, ctx);
  assert(
    m.calls.indexOf('parser:remove') <
      m.calls.indexOf('remove:' + paths.policy),
  );
  for (const path of Object.values(paths)) assert(!m.files.has(path));
  const unknown = model();
  unknown.io.read = async () => {
    throw null;
  };
  await assert.rejects(noManagedOccupants(unknown.io));

  // Exercise exact wrapper decisions, including falsy/undefined primary values.
  for (const primary of [undefined, null, false, 0, '', new Error('primary')]) {
    let caught = false,
      value,
      cleaned = false;
    try {
      await withManagedAppImage(
        base,
        async () => {
          throw primary;
        },
        {
          context: ctx,
          parent: base.parent,
          invoke: async (request) => {
            if (request.operation === 'cleanup') {
              cleaned = true;
              throw new Error('secondary');
            }
            return installed;
          },
          secondary: () => {
            throw new Error('secondary reporting failure');
          },
        },
      );
    } catch (error) {
      caught = true;
      value = error;
    }
    assert(caught && cleaned);
    assert.equal(value, primary);
  }
  await assert.rejects(
    withManagedAppImage(base, async () => true, {
      context: ctx,
      parent: base.parent,
      invoke: async (request) => {
        if (request.operation === 'cleanup') throw new Error('cleanup');
        return installed;
      },
    }),
    /cleanup/,
  );
  // Model signals at the exact wrapper boundary; no real host signals.
  for (const phase of ['prepare', 'run', 'check', 'cleanup']) {
    const signals = new EventEmitter();
    const operations = [];
    await assert.rejects(
      withManagedAppImage(
        base,
        async (_, session) => {
          if (phase === 'run' || phase === 'check') signals.emit('SIGTERM');
          if (phase === 'check') await session.check();
          return true;
        },
        {
          context: ctx,
          parent: base.parent,
          signals,
          invoke: async (request) => {
            operations.push(request.operation);
            if (request.operation === phase) signals.emit('SIGINT');
            return installed;
          },
        },
      ),
      /cancelled/,
    );
    assert.equal(operations.at(-1), 'cleanup');
    if (phase === 'prepare' || phase === 'check')
      assert.deepEqual(operations, ['prepare', 'cleanup']);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  }
  let called = false;
  await assert.rejects(
    withManagedAppImage(base, async () => true, {
      context: { ...ctx, platform: 'darwin' },
      parent: base.parent,
      invoke: async () => {
        called = true;
      },
    }),
  );
  assert(!called);

  const sample = {
    pid: 70,
    birth: '123',
    uid: 1001,
    executableSha256: base.executableSha256,
    appAsarSha256: base.appAsarSha256,
    executable: '/tmp/.mount_CanopyFIXTURE/canopy',
    mount: {
      path: '/tmp/.mount_CanopyFIXTURE',
      source: paths.original,
      filesystem: 'fuse.Canopy',
    },
    sandboxHelper: {
      path: '/tmp/.mount_CanopyFIXTURE/chrome-sandbox',
      uid: 0,
      gid: 0,
      mode: '755',
      sha256: base.helperSha256,
    },
    apparmorContext: managedProfile + ' (unconfined)',
  };
  const actual = { pid: 70, mainBirth: '123', rootPid: 70, rootBirth: '123' };
  const evidence = {
    ...installed,
    launch: { rootPid: 70, rootBirth: '123', sample },
  };
  const report = {
    completed: true,
    status: 'observed',
    finalizedAt: Date.now(),
    artifact: paths.original,
    parent: 50,
    parentBirth: '321',
    managedReceipt: base.token,
    original: installed.receipt.original,
    authority: {
      kind: 'retained-spawn',
      pid: 70,
      birth: '123',
      originalSha256: base.sha256,
      managed: true,
    },
    samples: [sample],
  };
  acceptManagedObservation(report, evidence, actual, base.parent);
  acceptManagedObservation(
    { ...report, authority: { ...report.authority, kind: 'native-original' } },
    evidence,
    actual,
    base.parent,
  );
  for (const mutation of [
    (r) => {
      r.completed = false;
    },
    (r) => {
      r.status = 'unknown';
    },
    (r) => {
      delete r.authority;
    },
    (r) => {
      r.authority.pid = 71;
    },
    (r) => {
      r.authority.originalSha256 = 'f'.repeat(64);
    },
    (r) => {
      r.managedReceipt = 'b'.repeat(32);
    },
    (r) => {
      r.samples[0].apparmorContext = 'unconfined';
    },
    (r) => {
      r.original.metadata.uid = 1001;
    },
  ]) {
    const bad = structuredClone(report);
    mutation(bad);
    assert.throws(() =>
      acceptManagedObservation(bad, evidence, actual, base.parent),
    );
  }
  assert.throws(() =>
    acceptManagedObservation(undefined, evidence, actual, base.parent),
  );
  // Source integration must consume managed evidence before app.close and upload.
  const caller = await readFile(
    new URL('./packaged-smoke.mjs', import.meta.url),
    'utf8',
  );
  const accepted = caller.indexOf(
    'acceptManagedObservation(',
    caller.indexOf('async function smoke'),
  );
  assert(accepted >= 0 && accepted < caller.indexOf('await app.close()'));
  const managedCall = caller.indexOf('await withManagedAppImage(');
  assert(managedCall >= 0 && managedCall < caller.indexOf('results.push({'));
  const smokeBegin = caller.indexOf('async function smoke('),
    smokeEnd = caller.indexOf('\nfor (const format', smokeBegin);
  assert(smokeBegin >= 0 && smokeEnd > smokeBegin);
  const smokeControl = new Function(
    'd',
    `const {process,electron,mkdir,join,workspace,writeFile,console}=d; ${caller.slice(smokeBegin, smokeEnd)} return smoke('/unused','/owned','fixture',undefined);`,
  );
  for (const primary of [undefined, null, false, 0, '', new Error('launch')]) {
    for (const closeFailure of [false, true]) {
      const secondary = new Error('secondary');
      let caught = false,
        value,
        closed = false;
      const app = {
        firstWindow: async () => {
          throw primary;
        },
        close: async () => {
          closed = true;
          throw secondary;
        },
      };
      try {
        await smokeControl({
          process: { env: {}, platform: 'darwin' },
          electron: {
            launch: async () => {
              if (!closeFailure) throw primary;
              return app;
            },
          },
          mkdir: async () => {},
          join: (...values) => values.join('/'),
          workspace: '/owned',
          writeFile: async () => {
            throw secondary;
          },
          console: { error: () => {} },
        });
      } catch (error) {
        caught = true;
        value = error;
      }
      assert(caught);
      assert.equal(value, primary);
      assert.equal(closed, closeFailure);
    }
  }
  const source = await readFile(
    new URL('./managed-appimage.mjs', import.meta.url),
    'utf8',
  );
  const begin = source.indexOf('function nativeEffects() {');
  const end = source.indexOf('\nif', begin);
  assert(begin >= 0 && end > begin);
  const commands = [];
  const native = new Function(
    'd',
    `const {managedGuard,managedPaths,process,spawnSync,fail,same,identity,boundedRead,boundedHash,lstat,realpath,readdir,open,mkdir,unlink,rmdir,constants}=d; ${source.slice(begin, end)} return nativeEffects();`,
  )({
    managedGuard,
    managedPaths: paths,
    process: {
      platform: 'linux',
      arch: 'x64',
      env: { ...ctx.env, SUDO_UID: '1001' },
      getuid: () => 0,
    },
    spawnSync: (command, args, options) => {
      commands.push({ command, args, options });
      return { status: 0 };
    },
    fail: (message) => {
      throw new Error(message);
    },
  });
  await native.parser('add');
  await native.parser('remove');
  assert.deepEqual(
    commands.map((command) => [command.command, command.args]),
    ['add', 'remove'].map((operation) => [
      '/usr/sbin/apparmor_parser',
      [
        '--config-file=/dev/null',
        '--skip-cache',
        '--' + operation,
        '--',
        paths.policy,
      ],
    ]),
  );
  assert(
    commands.every(
      (command) =>
        command.options.timeout === 5000 &&
        command.options.killSignal === 'SIGKILL',
    ),
  );
  await assert.rejects(native.parser('replace'));
  assert.equal(commands.length, 2);
  const refused = spawnSync(
    process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
    [
      fileURLToPath(new URL('./managed-appimage.mjs', import.meta.url)),
      '--managed-appimage-private',
    ],
    {
      input: '{}',
      encoding: 'utf8',
      timeout: 3000,
      env: { ...process.env, SUDO_UID: '0' },
    },
  );
  assert.equal(refused.status, 1);
  assert(refused.stderr.includes('requires explicit disposable'));
  const workflow = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  assert(workflow.includes("matrix.platform == 'linux/x64' && '1' || '0'"));
}
