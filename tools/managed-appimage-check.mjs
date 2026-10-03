import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  readFile,
  mkdtemp,
  writeFile,
  rm,
  realpath,
  lstat,
  stat,
  readlink,
} from 'node:fs/promises';
import { boundedHash } from './appimage-observer.mjs';
import { readerSource } from './mounted-reader.mjs';
import { checkMountedReader } from './mounted-reader-check.mjs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import {
  managedNodeExecutable,
  managedGuard,
  managedOperation,
  managedPaths as paths,
  managedPolicy,
  managedProfile,
  withManagedAppImage,
  acceptManagedObservation,
  noManagedOccupants,
  waitManagedChild,
  boundedManagedClose,
  validManagedResponse,
  recordManagedProtocol,
  managedBootstrapObservation,
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
    '/var',
    '/var/lib',
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
      if (path === '/proc/90' || path === '/proc/92') throw missing();
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
      if (path === profilePath + '/sha256') return 'd'.repeat(64) + '\n';
      if (path.endsWith('/attr/current')) {
        if (unknown) throw new Error('unreadable live task');
        return occupancy ? managedProfile + ' (unconfined)' : 'unconfined';
      }
      if (path.endsWith('/uid_map') || path.endsWith('/gid_map'))
        return '         0          0 4294967295\n';
      if (path === '/proc/70/status')
        return 'Uid: 1001 1001 1001 1001\nGid: 1002 1002 1002 1002\n';
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
    link: async (path) =>
      path.endsWith('/ns/user')
        ? 'user:[1]'
        : path.endsWith('/ns/mnt')
          ? 'mnt:[2]'
          : '/usr/bin/node',
    readerExecutable: async () => ({
      path: '/usr/bin/node',
      identity: {
        dev: 1,
        ino: 600,
        uid: 1001,
        gid: 1002,
        mode: 0o100755,
        nlink: 1,
        size: 6,
        mtimeMs: 1,
        ctimeMs: 1,
      },
      sha256: hash('node'),
      source: readerSource,
    }),
    reader: async (r, record) => {
      const identity = {
        pid: 92,
        birth: '113',
        uid: r.scope.uid,
        parent: r.writer.pid,
      };
      await record(identity);
      const files = [];
      for (const suffix of ['canopy', 'resources/app.asar', 'chrome-sandbox']) {
        const path = r.scope.mount.path + '/' + suffix;
        assert.equal(await io.canonical(path), path);
        const m = suffix === 'chrome-sandbox' ? await io.stat(path) : {};
        files.push({
          path,
          identity: {
            dev: 1,
            ino: 601 + files.length,
            uid: 0,
            gid: 0,
            mode: 0o100755,
            nlink: 1,
            size: 6,
            mtimeMs: 1,
            ctimeMs: 1,
            ...m,
          },
          sha256: await io.hash(path),
        });
      }
      return {
        proof: {
          spawned: true,
          closed: true,
          timedOut: false,
          pid: 92,
          birth: '113',
          identity,
          code: 0,
          signal: null,
          accepted: true,
        },
        files,
      };
    },
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
    writer: async () => ({ pid: 90, birth: '111', uid: 0 }),
    parser: async (operation, record) => {
      calls.push('parser:' + operation);
      const identity = { pid: 91, birth: '112', uid: 0, parent: 90 };
      await record(identity);
      if (failure === 'parser-uncertain')
        throw Object.assign(new Error('parser unknown'), {
          managedUncertain: true,
        });
      if (operation === 'add' && failure !== 'parser') {
        loaded = true;
        if (failure === 'load-status')
          io.read = async () => {
            throw new Error('status unreadable');
          };
      } else if (operation === 'remove') loaded = false;
      return {
        spawned: true,
        closed: true,
        timedOut: false,
        pid: identity.pid,
        birth: identity.birth,
        identity,
        code: failure === 'parser' ? 1 : 0,
        signal: null,
        output: '',
        stderr: 'fixture parser failure',
      };
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
async function checkLoadedProfileRefusals() {
  const good = {
    attach: paths.original,
    mode: 'unconfined',
    sha256: 'd'.repeat(64) + '\n',
  };
  const secret = 'private-profile-value-🔒'.repeat(300);
  const opaque = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'then') return undefined; // Async read may check thenability.
        throw new Error('Diagnostic inspected profile object');
      },
    },
  );
  const cases = [
    { attach: '<unknown>' },
    { attach: '/opt/Canopy/Canopy.AppImage' },
    { attach: secret },
    { mode: 'enforce' },
    { mode: secret },
    ...[
      '',
      'disabled\n',
      'D'.repeat(64) + '\n',
      'd'.repeat(40) + '\n',
      'd'.repeat(64),
      'd'.repeat(64) + '\r\n',
      'd'.repeat(64) + '\n\n',
      secret,
      null,
      12,
    ].map((sha256) => ({ sha256 })),
    { attach: '<unknown>', sha256: opaque },
    { attach: '<unknown>', sha256: Symbol(secret) },
  ];
  for (const change of cases) {
    const values = { ...good, ...change };
    const m = model(),
      read = m.io.read;
    m.io.read = async (path) => {
      for (const key of Object.keys(values))
        if (path.endsWith('/' + key)) return values[key];
      return read(path);
    };
    for (const operation of ['prepare', 'cleanup']) {
      const before = [...m.calls];
      await assert.rejects(
        managedOperation({ ...base, operation }, m.io, ctx),
        (error) => {
          assert(
            error.message.startsWith(
              'Loaded profile identity unavailable; loaded ',
            ),
          );
          const detail = error.message.split('; loaded ')[1];
          assert(Buffer.byteLength(detail) <= 512);
          assert.deepEqual(JSON.parse(detail), {
            attach:
              values.attach === paths.original
                ? 'expected'
                : values.attach === '<unknown>'
                  ? 'unknown'
                  : 'different',
            attachBytes: Buffer.byteLength(values.attach),
            mode: values.mode === 'unconfined' ? 'expected' : 'different',
            modeBytes: Buffer.byteLength(values.mode),
            sha256Type: values.sha256 === null ? 'null' : typeof values.sha256,
            sha256Bytes:
              typeof values.sha256 === 'string'
                ? Buffer.byteLength(values.sha256)
                : null,
            sha256Format:
              typeof values.sha256 === 'string' &&
              /^[a-f0-9]{64}\n$/.test(values.sha256),
          });
          assert(!error.message.includes('private-profile-value'));
          assert(!error.message.includes(paths.original));
          assert(!error.message.includes(good.sha256.trim()));
          return true;
        },
      );
      assert(m.files.has(paths.receipt));
      assert(m.files.has(paths.original));
      assert(m.files.has(paths.policy));
      assert(!m.calls.includes('parser:remove'));
      if (operation === 'cleanup') assert.deepEqual(m.calls, before);
    }
  }
  const m = model();
  const installed = await managedOperation(
    { ...base, operation: 'prepare' },
    m.io,
    ctx,
  );
  const read = m.io.read;
  m.io.read = async (path) =>
    path.endsWith('/attach') ? '<unknown>' : read(path);
  for (const operation of ['check', 'cleanup']) {
    const before = [...m.calls];
    await assert.rejects(
      managedOperation({ ...base, operation }, m.io, ctx),
      /Loaded profile identity unavailable; loaded /,
    );
    assert.deepEqual(m.calls, before);
    assert(m.files.has(paths.receipt));
  }
  m.io.read = read;
  assert.equal(
    (await managedOperation({ ...base, operation: 'check' }, m.io, ctx))
      .receiptSha256,
    installed.receiptSha256,
  );
  await managedOperation({ ...base, operation: 'cleanup' }, m.io, ctx);
  assert(!m.files.has(paths.receipt));
  console.log(
    'Loaded profile bounded diagnostics and unchanged prepare/check/cleanup refusals PASS (modeled)',
  );
}
async function checkLiteralProfileIdentity() {
  assert.equal(managedProfile, paths.original);
  for (const inventory of [
    'canopy-appimage (unconfined)\n',
    'canopy-appimage//child (unconfined)\n',
    `${managedProfile} (unconfined)\ncanopy-appimage (unconfined)\n`,
    `${managedProfile}//child (unconfined)\n`,
    `${managedProfile} (enforce)\n`,
  ]) {
    const m = model(),
      read = m.io.read;
    m.io.read = async (path) =>
      path === '/sys/kernel/security/apparmor/profiles'
        ? inventory
        : read(path);
    await assert.rejects(
      managedOperation({ ...base, operation: 'prepare' }, m.io, ctx),
      /(?:Legacy managed|Unexpected managed) loaded profile/,
    );
    assert.deepEqual(m.calls, []);
    assert(!m.files.has(paths.receipt));
  }
  for (const change of [
    'legacy-loaded',
    'wrong-name',
    'old-receipt',
    'old-policy',
    'schema',
  ]) {
    const m = model();
    await managedOperation({ ...base, operation: 'prepare' }, m.io, ctx);
    const read = m.io.read;
    if (change === 'legacy-loaded' || change === 'wrong-name') {
      m.io.read = async (path) => {
        if (
          change === 'legacy-loaded' &&
          path === '/sys/kernel/security/apparmor/profiles'
        )
          return `${managedProfile} (unconfined)\ncanopy-appimage (unconfined)\n`;
        if (change === 'wrong-name' && path.endsWith('/name'))
          return 'canopy-appimage\n';
        return read(path);
      };
    } else {
      const file = m.files.get(paths.receipt),
        receipt = JSON.parse(file.content);
      if (change === 'old-receipt') receipt.profile.name = 'canopy-appimage';
      if (change === 'old-policy') {
        receipt.profile.content = managedPolicy.replace(
          `profile ${managedProfile}`,
          `profile canopy-appimage ${managedProfile}`,
        );
        receipt.profile.sha256 = hash(receipt.profile.content);
      }
      if (change === 'schema') receipt.schema = 1;
      file.content = JSON.stringify(receipt);
      file.meta.size = file.content.length;
    }
    const before = [...m.calls];
    for (const operation of ['check', 'cleanup']) {
      await assert.rejects(managedOperation({ ...base, operation }, m.io, ctx));
      assert.deepEqual(m.calls, before);
      for (const path of [paths.receipt, paths.original, paths.policy])
        assert(m.files.has(path));
    }
  }
  console.log(
    'Fixed literal profile, legacy overlap/name/receipt/policy/schema refusal and retention PASS (modeled)',
  );
}
export async function checkManagedAppImage() {
  await checkMountedReader({ model, ctx, base, text });
  await checkLiteralProfileIdentity();
  await checkLoadedProfileRefusals();
  assert.equal(
    managedPolicy,
    'abi <abi/4.0>,\ninclude <tunables/global>\nprofile /var/lib/canopy-appimage-ci/Canopy.AppImage flags=(unconfined) {\n  userns,\n}\n',
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
  // Linux semantics remain POSIX on every host; canonical/source boundaries
  // still reject foreign or escaped paths before any mutation.
  for (const source of [
    '/workspace/other/Canopy-1.0.0-linux-x86_64.AppImage',
    '/workspace/release/../Canopy-1.0.0-linux-x86_64.AppImage',
    'C:\\workspace\\release\\Canopy-1.0.0-linux-x86_64.AppImage',
  ]) {
    const rejected = model();
    await assert.rejects(
      managedOperation(
        { ...base, source, operation: 'prepare' },
        rejected.io,
        ctx,
      ),
      /Source outside/,
    );
    assert.deepEqual(rejected.calls, []);
  }
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
  assert.deepEqual(
    installed.receipt.parents.map((parent) => parent.path),
    ['/', '/var', '/var/lib', '/etc', '/etc/apparmor.d'],
  );
  assert.deepEqual(
    installed.receipt.original.parents.map((parent) => parent.path),
    ['/', '/var', '/var/lib', paths.directory],
  );
  // Every new ancestor is required before creation and pinned for later use.
  for (const path of ['/var', '/var/lib']) {
    for (const alter of [
      (m) => {
        m.files.get(path).meta.uid = 1001;
      },
      (m) => {
        m.files.get(path).meta.gid = 1001;
      },
      (m) => {
        m.files.get(path).directory = false;
      },
      (m) => {
        m.files.get(path).symlink = true;
      },
      (m) => {
        m.files.get(path).meta.mode |= 0o020;
      },
      (m) => {
        m.files.get(path).meta.mode |= 0o002;
      },
      (m) => {
        m.files.get(path).meta.mode |= 0o4000;
      },
      (m) => {
        m.files.get(path).meta.mode |= 0o2000;
      },
      (m) => {
        m.io.canonical = async (p) => (p === path ? '/foreign' : p);
      },
    ]) {
      const bad = model();
      alter(bad);
      await assert.rejects(
        managedOperation({ ...base, operation: 'prepare' }, bad.io, ctx),
      );
      assert.deepEqual(
        bad.calls,
        [],
        'unprotected ancestor must not be repaired',
      );
    }
    for (const operation of ['check', 'cleanup']) {
      const changed = model();
      await managedOperation(
        { ...base, operation: 'prepare' },
        changed.io,
        ctx,
      );
      const before = [...changed.calls];
      changed.files.get(path).meta.ino++;
      await assert.rejects(
        managedOperation({ ...base, operation }, changed.io, ctx),
      );
      assert.deepEqual(
        changed.calls,
        before,
        'changed ancestor must retain resources',
      );
    }
  }
  // Former resources supply no current authority and are never swept.
  const stale = model();
  stale.make('/opt', '', 0o777, 0, true);
  stale.make('/opt/Canopy', '', 0o755, 0, true);
  stale.make('/opt/Canopy/Canopy.AppImage', 'original', 0o555);
  stale.make(
    '/opt/.canopy-appimage-ci.json',
    JSON.stringify(installed.receipt),
    0o600,
  );
  await assert.rejects(
    managedOperation({ ...base, operation: 'check' }, stale.io, ctx),
  );
  const oldFiles = [...stale.files].filter(([path]) => path.startsWith('/opt'));
  await managedOperation({ ...base, operation: 'prepare' }, stale.io, ctx);
  await managedOperation({ ...base, operation: 'cleanup' }, stale.io, ctx);
  assert.deepEqual(
    [...stale.files].filter(([path]) => path.startsWith('/opt')),
    oldFiles,
  );
  const stalePolicy = model();
  stalePolicy.make(
    paths.policy,
    managedPolicy.replace(paths.original, '/opt/Canopy/Canopy.AppImage'),
    0o444,
  );
  await assert.rejects(
    managedOperation({ ...base, operation: 'prepare' }, stalePolicy.io, ctx),
  );
  assert.deepEqual(stalePolicy.calls, []);
  assert.equal(m.calls.filter((call) => call === 'parser:add').length, 1);
  assert.equal(
    (await managedOperation({ ...base, operation: 'check' }, m.io, ctx))
      .receiptSha256,
    installed.receiptSha256,
  );
  assert.equal(installed.receipt.loaded.sha256, 'd'.repeat(64));
  for (const value of [
    null,
    '',
    'disabled\n',
    'D'.repeat(64) + '\n',
    'd'.repeat(40) + '\n',
    'd'.repeat(64),
  ]) {
    const broken = model(),
      read = broken.io.read;
    broken.io.read = async (path) => {
      if (path.endsWith('/sha256')) {
        if (value === null)
          throw Object.assign(new Error('absent sha256'), { code: 'ENOENT' });
        return value;
      }
      assert(!path.endsWith('/hash'));
      return read(path);
    };
    await assert.rejects(
      managedOperation({ ...base, operation: 'prepare' }, broken.io, ctx),
    );
    await assert.rejects(
      managedOperation({ ...base, operation: 'cleanup' }, broken.io, ctx),
    );
    assert(broken.files.has(paths.receipt));
    assert(!broken.calls.includes('parser:remove'));
  }
  for (const changed of [
    { closed: false },
    { timedOut: true },
    { birth: 'unknown' },
    { identity: { pid: 91, birth: '112', uid: 1001, parent: 90 } },
  ]) {
    const bad = model(),
      parser = bad.io.parser;
    bad.io.parser = async (...args) => ({
      ...(await parser(...args)),
      ...changed,
    });
    await assert.rejects(
      managedOperation({ ...base, operation: 'prepare' }, bad.io, ctx),
    );
    await assert.rejects(
      managedOperation({ ...base, operation: 'cleanup' }, bad.io, ctx),
    );
    assert(bad.files.has(paths.receipt));
    assert(!bad.calls.includes('parser:remove'));
  }
  const late = model('parser-uncertain');
  await assert.rejects(
    managedOperation({ ...base, operation: 'prepare' }, late.io, ctx),
  );
  assert.equal(
    JSON.parse(late.files.get(paths.receipt).content).mutation.state,
    'pending',
  );
  await assert.rejects(
    managedOperation({ ...base, operation: 'cleanup' }, late.io, ctx),
    /in-flight/,
  );
  late.setLoaded(true); // An uncertain writer may apply later: receipt stays.
  await assert.rejects(
    managedOperation({ ...base, operation: 'cleanup' }, late.io, ctx),
    /in-flight/,
  );
  assert(Object.values(paths).every((path) => late.files.has(path)));
  for (const kind of ['live', 'unreadable']) {
    const writer = model();
    await managedOperation({ ...base, operation: 'prepare' }, writer.io, ctx);
    const read = writer.io.read;
    writer.io.read = async (path) => {
      if (path === '/proc/90/stat') {
        if (kind === 'unreadable') throw new Error('unreadable writer');
        return text(1, '111');
      }
      return read(path);
    };
    const stat = writer.io.lstat;
    writer.io.lstat = async (path) =>
      path === '/proc/90' ? { uid: 0 } : stat(path);
    await assert.rejects(
      managedOperation({ ...base, operation: 'cleanup' }, writer.io, ctx),
    );
    assert(writer.files.has(paths.receipt));
    assert(!writer.calls.includes('parser:remove'));
  }
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
          ' ro,nosuid,nodev - fuse.Canopy.AppImage Canopy.AppImage ro,user_id=1001,group_id=1002'
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
  const realLink = live.io.link;
  live.io.link = async (path) =>
    path.endsWith('/exe') ? mount + '/canopy' : realLink(path);
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
  assert(
    validManagedResponse(
      { ok: true, value: proof },
      { ...base, operation: 'launch', launch },
    ),
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
      model.files.get('/var/lib').meta.uid = 1001;
    },
    (model) => {
      model.files.get('/etc/apparmor.d').symlink = true;
    },
    (model) => {
      model.files.get('/var/lib').meta.mode |= 0o002;
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
  for (const primary of [
    undefined,
    null,
    false,
    0,
    '',
    Object.assign(new Error('primary'), {
      managedProtocol: {
        operation: 'prepare',
        reason: 'schema',
        outputBytes: 1,
        stderrBytes: 0,
        code: 0,
        signal: null,
      },
    }),
  ]) {
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
    assert(!operations.includes('check'));
    assert.equal(operations[0], 'prepare');
    assert(
      operations.every((operation) =>
        ['prepare', 'cleanup'].includes(operation),
      ),
    );
    if (phase === 'prepare' || phase === 'cleanup')
      assert.equal(operations.at(-1), 'cleanup');
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

  const sample = structuredClone(proof.launch.sample);
  const actual = launch;
  const evidence = {
    ...proof,
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
    `const {process,electron,mkdir,join,workspace,writeFile,console,managedChild}=d; ${caller.slice(smokeBegin, smokeEnd)} return smoke('/unused','/owned','fixture',undefined,d.managed);`,
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
  // Full production consumer, deliberately failing firstWindow. Managed
  // closure is the real wrapper session; renderer/IO inputs remain models.
  for (const primary of [
    undefined,
    null,
    false,
    0,
    '',
    new Error('smoke primary'),
  ]) {
    for (const phase of [
      'diagnostic-log',
      'diagnostic-format',
      'close-log',
      'close-format',
    ]) {
      for (const managed of [false, true]) {
        const formattingFault = {
          toString() {
            throw new Error('secondary formatting fault');
          },
        };
        const operations = [];
        let closes = 0,
          caught = false,
          value;
        const app = {
          firstWindow: async () => {
            throw primary;
          },
          close: async () => {
            closes++;
            if (phase.startsWith('close'))
              throw phase === 'close-format'
                ? formattingFault
                : new Error('secondary close');
          },
        };
        const run = (session) =>
          smokeControl({
            process: { env: {}, platform: 'darwin' },
            electron: { launch: async () => app },
            managed: session,
            managedChild: () => ({ pid: 70 }),
            mkdir: async () => {},
            join: (...parts) => parts.join('/'),
            workspace: '/owned',
            writeFile: async () => {
              if (phase.startsWith('diagnostic'))
                throw phase === 'diagnostic-format'
                  ? formattingFault
                  : new Error('secondary diagnostic');
            },
            console: {
              error: () => {
                throw new Error('secondary logger fault');
              },
            },
          });
        try {
          if (managed)
            await withManagedAppImage(base, (_, session) => run(session), {
              context: ctx,
              parent: base.parent,
              secondary: () => {
                throw new Error('wrapper logger fault');
              },
              invoke: async (request) => {
                operations.push(request.operation);
                return installed;
              },
            });
          else await run(undefined);
        } catch (error) {
          caught = true;
          value = error;
        }
        assert(caught);
        assert.equal(value, primary);
        assert.equal(closes, 1);
        if (managed && phase.startsWith('close'))
          assert(!operations.includes('cleanup'));
      }
    }
  }
  const source = await readFile(
    new URL('./managed-appimage.mjs', import.meta.url),
    'utf8',
  );
  // Exercise the exact protected-path implementation without privileged I/O.
  const protectedSource = source.slice(
    source.indexOf('function identity('),
    source.indexOf('async function parents('),
  );
  const protect = new Function(
    'managedPaths',
    'fail',
    `${protectedSource} return protectedPath;`,
  )(paths, (message) => {
    throw new Error(message);
  });
  const safeMetadata = {
    dev: 1,
    ino: 2,
    uid: 0,
    gid: 0,
    mode: 0o100555,
    nlink: 1,
    size: 8,
    mtimeMs: 1,
    ctimeMs: 1,
    isSymbolicLink: () => false,
    isFile: () => true,
    isDirectory: () => false,
  };
  const protectedIO = (metadata, canonical = paths.original) => ({
    lstat: async () => metadata,
    canonical: async () => canonical,
  });
  assert.equal(
    (await protect(protectedIO(safeMetadata), paths.original, false, 0o555))
      .mode,
    0o100555,
  );
  for (const [patch, canonical, expectedCanonical] of [
    [{ uid: 1001 }, paths.original, 'same'],
    [{ gid: 1001 }, paths.original, 'same'],
    [{ mode: 0o100575 }, paths.original, 'same'],
    [{ mode: 0o104555 }, paths.original, 'same'],
    [{ mode: 0o100755 }, paths.original, 'same'],
    [{ nlink: 2 }, paths.original, 'same'],
    [{ mode: 0o040555, isFile: () => false }, paths.original, 'unchecked'],
    [
      { mode: 0o120555, isSymbolicLink: () => true },
      paths.original,
      'unchecked',
    ],
    [{}, '/private/secret-canonical-target', 'different'],
  ]) {
    await assert.rejects(
      protect(
        protectedIO({ ...safeMetadata, ...patch }, canonical),
        paths.original,
        false,
        0o555,
      ),
      (error) => {
        assert(
          error.message.startsWith(
            'Managed ownership/path/mode mismatch; protected ',
          ),
        );
        const detail = JSON.parse(error.message.split('; protected ')[1]);
        assert.equal(detail.path, 'managed-original');
        assert.equal(detail.canonical, expectedCanonical);
        assert.equal(detail.uid, patch.uid ?? 0);
        assert.equal(detail.gid, patch.gid ?? 0);
        assert.equal(detail.mode, patch.mode ?? safeMetadata.mode);
        assert.equal(detail.links, patch.nlink ?? 1);
        assert.equal(detail.expectedMode, 0o555);
        assert(!error.message.includes('secret-canonical-target'));
        assert(Buffer.byteLength(error.message) < 600);
        assert.equal(error.managedUncertain, undefined);
        assert(
          managedBootstrapObservation(String(error)).includes(
            'managed-original',
          ),
        );
        return true;
      },
    );
  }
  for (const [path, label] of [
    ['/', 'root'],
    ['/var', 'var'],
    ['/var/lib', 'var-lib'],
    ['/etc', 'etc'],
    ['/etc/apparmor.d', 'apparmor-dir'],
    [paths.directory, 'managed-directory'],
    [paths.original, 'managed-original'],
    [paths.receipt, 'managed-receipt'],
    [paths.policy, 'managed-policy'],
  ]) {
    await assert.rejects(
      protect(protectedIO({ ...safeMetadata, uid: 1001 }, path), path),
      (error) => {
        assert(error.message.includes('; protected '));
        const detail = error.message.split('; protected ')[1];
        assert.equal(JSON.parse(detail).path, label);
        assert(Buffer.byteLength(detail) <= 512);
        return true;
      },
    );
  }
  await assert.rejects(
    protect(
      protectedIO({ ...safeMetadata, uid: 1001 }, '/arbitrary-secret'),
      '/arbitrary-secret',
    ),
    { message: 'Managed ownership/path/mode mismatch' },
  );
  let getterCalls = 0;
  const accessor = { ...safeMetadata, isSymbolicLink: () => true };
  Object.defineProperty(accessor, 'uid', {
    get() {
      getterCalls++;
      throw new Error('secret');
    },
  });
  await assert.rejects(
    protect(protectedIO(accessor), paths.original),
    (error) => {
      assert.equal(
        JSON.parse(error.message.split('; protected ')[1]).uid,
        null,
      );
      return true;
    },
  );
  assert.equal(getterCalls, 0);
  const broken = new Proxy(
    { ...safeMetadata, isSymbolicLink: () => true },
    {
      getOwnPropertyDescriptor() {
        throw new Error('format fault');
      },
    },
  );
  await assert.rejects(protect(protectedIO(broken), paths.original), {
    message: 'Managed ownership/path/mode mismatch',
  });
  for (const phase of ['lstat', 'canonical']) {
    for (const primary of [
      undefined,
      null,
      false,
      0,
      '',
      new Error('original I/O'),
    ]) {
      const io = protectedIO(safeMetadata);
      io[phase] = async () => {
        throw primary;
      };
      let caught = false;
      try {
        await protect(io, paths.original);
      } catch (error) {
        caught = true;
        assert.equal(error, primary);
      }
      assert(caught);
    }
  }
  const begin = source.indexOf('function nativeEffects() {');
  const end = source.indexOf('\nif', begin);
  assert(begin >= 0 && end > begin);
  const commands = [];
  const native = new Function(
    'd',
    `const {managedGuard,managedPaths,process,spawn,waitManagedChild,processIdentity,fail,same,identity,boundedRead,boundedHash,lstat,stat,realpath,readdir,open,mkdir,unlink,rmdir,constants}=d; ${source.slice(begin, end)} return nativeEffects();`,
  )({
    managedGuard,
    managedPaths: paths,
    process: {
      platform: 'linux',
      arch: 'x64',
      pid: 90,
      env: { ...ctx.env, SUDO_UID: '1001' },
      getuid: () => 0,
    },
    spawn: (command, args, options) => {
      commands.push({ command, args, options });
      return {};
    },
    waitManagedChild: async (_, options) => {
      assert(
        options.expires > performance.now() &&
          options.expires <= performance.now() + 5000,
      );
      assert.equal(options.killOwned, true);
    },
    fail: (message) => {
      throw new Error(message);
    },
  });
  await native.parser('add', async () => {});
  await native.parser('remove', async () => {});
  assert.deepEqual(
    commands.map(({ command, args }) => [command, args]),
    ['add', 'remove'].map((operation) => [
      '/usr/sbin/apparmor_parser',
      [
        '--config-file=/dev/null',
        '--skip-cache',
        '--jobs=0',
        '--' + operation,
        '--',
        paths.policy,
      ],
    ]),
  );
  await assert.rejects(native.parser('replace', async () => {}));
  assert.equal(commands.length, 2);
  let diagnosticWrites = 0;
  for (const managedProtocol of [
    {
      operation: 'prepare',
      reason: 'SECRET',
      outputBytes: 0,
      stderrBytes: 0,
      code: 0,
      signal: null,
    },
    {
      operation: 'prepare',
      reason: 'schema',
      outputBytes: 65537,
      stderrBytes: 0,
      code: 0,
      signal: null,
    },
  ])
    await recordManagedProtocol(
      '/owned/rejected.json',
      { managedProtocol },
      {
        mkdir: async () => assert.fail('no mkdir'),
        writeFile: async () => {
          diagnosticWrites++;
        },
      },
    );
  assert.equal(diagnosticWrites, 0);
  const packagedSource = await readFile(
    new URL('./packaged-smoke.mjs', import.meta.url),
    'utf8',
  );
  const catchStart = packagedSource.indexOf(
      '    } catch (error) {\n      primaryFailed = true;',
    ),
    catchEnd = packagedSource.indexOf('    } finally {', catchStart);
  assert(catchStart >= 0 && catchEnd > catchStart);
  const failureConsumer = new Function(
    'primary',
    'recordManagedProtocol',
    `return (async()=>{let primaryFailed=false;const managedAttempted=true,workspace='/owned',name='fixture';const join=(...parts)=>parts.join('/');try{throw primary;${packagedSource.slice(catchStart, catchEnd)}}})();`,
  );
  for (const primary of [
    undefined,
    null,
    false,
    0,
    '',
    Object.assign(new Error('primary'), {
      managedProtocol: {
        operation: 'prepare',
        reason: 'schema',
        outputBytes: 1,
        stderrBytes: 0,
        code: 0,
        signal: null,
      },
    }),
  ]) {
    let caught = false,
      received;
    try {
      await failureConsumer(primary, (path, error) =>
        recordManagedProtocol(path, error, {
          mkdir: async () => {
            throw new Error('secondary');
          },
          writeFile: async () => assert.fail('no write'),
        }),
      );
    } catch (error) {
      caught = true;
      received = error;
    }
    assert(caught);
    assert.equal(received, primary);
  }
  await checkBootstrapDiagnostics();
  await checkManagedLifecycle();
  await checkManagedNodeExecutable(source);
  await checkManagedTransport(source);
  checkManagedResponseSchema(installed, { ...base, operation: 'prepare' });
  checkManagedResponseSchema(installed, { ...base, operation: 'check' });
  checkManagedResponseSchema(proof, { ...base, operation: 'launch', launch });
  await checkManagedSuccessTransport(source, proof, launch);
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

// Actual owned Node processes/stdio; fixture birth is modeled on non-Linux
// hosts. This verifies terminal event/budget handling, never kernel policy.
async function checkManagedLifecycle() {
  const node = process.env.JS_BINARY__NODE_BINARY ?? process.execPath;
  const children = [];
  const launch = (source) => {
    const child = spawn(node, ['-e', source], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    return child;
  };
  const onSpawn = async (child) => ({
    pid: child.pid,
    birth: 'fixture1'.replace('fixture', ''),
  });
  const exit = (child) =>
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : once(child, 'exit');
  try {
    for (const code of [0, 7]) {
      const child = launch(
        `process.stdout.write('bounded');process.exitCode=${code}`,
      );
      const proof = await waitManagedChild(child, { deadline: 2000, onSpawn });
      assert(proof.spawned && proof.closed && !proof.timedOut);
      assert.equal(proof.code, code);
      assert.equal(proof.output, 'bounded');
    }
    for (const killOwned of [true, false]) {
      const child = launch('setTimeout(() => {}, 350)');
      const started = Date.now();
      await assert.rejects(
        waitManagedChild(child, { deadline: 100, onSpawn, killOwned }),
        (error) => error.managedUncertain === true,
      );
      assert(Date.now() - started < 1500);
      await exit(child); // The signal itself was not death proof.
      if (killOwned) assert.equal(child.signalCode, 'SIGKILL');
      else assert.equal(child.exitCode, 0); // Later exit zero cannot turn timeout into success.
    }
    const supervisor = launch(
      `const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setTimeout(()=>{},600)'],{stdio:['ignore','inherit','inherit']});`,
    );
    const started = Date.now();
    await assert.rejects(
      waitManagedChild(supervisor, { deadline: 150, onSpawn }),
      /deadline\/closure/,
    );
    await exit(supervisor);
    assert.equal(supervisor.exitCode, 0);
    assert(Date.now() - started < 1500); // No wait for inherited worker pipes.
    const transient = launch('setTimeout(() => {}, 200)');
    const pending = waitManagedChild(transient, { deadline: 500, onSpawn });
    await once(transient, 'spawn');
    transient.emit('error', new Error('fixture transient'));
    await assert.rejects(pending, (error) => error.managedUncertain === true);
    await exit(transient);
    const unproved = launch('setTimeout(() => {}, 200)');
    await assert.rejects(
      waitManagedChild(unproved, {
        deadline: 100,
        onSpawn: () => new Promise(() => {}),
      }),
      /deadline/,
    );
    await exit(unproved);

    const delayed = launch('setTimeout(() => {}, 20)');
    delayed.on('close', () => {
      const until = performance.now() + 180;
      while (performance.now() < until) {}
    });
    await assert.rejects(
      waitManagedChild(delayed, { deadline: 150, onSpawn }),
      (error) => error.managedUncertain === true,
    );
    await exit(delayed);
    await assert.rejects(
      boundedManagedClose(
        {
          close: () => {
            const until = performance.now() + 80;
            while (performance.now() < until) {}
            return Promise.resolve();
          },
        },
        { deadline: 20 },
      ),
      (error) => error.managedUncertain === true,
    );
    const readiness = launch('setTimeout(() => {}, 20)');
    await assert.rejects(
      waitManagedChild(readiness, {
        deadline: 20,
        onSpawn: async (child) => {
          const until = performance.now() + 80;
          while (performance.now() < until) {}
          return { pid: child.pid, birth: '1' };
        },
      }),
      (error) => error.managedUncertain === true,
    );
    await exit(readiness);
    const signals = new EventEmitter(),
      operations = [];
    let finish, session;
    const held = new Promise((resolve) => {
      finish = resolve;
    });
    const cancelled = withManagedAppImage(
      base,
      async (_, current) => {
        session = current;
        signals.emit('SIGTERM');
        await held;
        return true;
      },
      {
        context: ctx,
        parent: base.parent,
        signals,
        secondary: () => {},
        invoke: async (request) => {
          operations.push(request.operation);
          return {};
        },
      },
    );
    await assert.rejects(cancelled, /cancelled/);
    assert.deepEqual(operations, ['prepare']); // No deletion during held callback.
    await assert.rejects(session.check(), /cancelled|verification stopped/);
    finish();
    assert.equal(signals.listenerCount('SIGTERM'), 0);
    let releaseClose;
    await assert.rejects(
      boundedManagedClose(
        {
          close: () =>
            new Promise((resolve) => {
              releaseClose = resolve;
            }),
        },
        { deadline: 20 },
      ),
      (error) => error.managedUncertain === true,
    );
    releaseClose();
    const closeCalls = [],
      closeOperations = [];
    let caught = false,
      raw;
    try {
      await withManagedAppImage(
        base,
        async (_, session) => {
          const app = {
            close: async () => {
              closeCalls.push('close');
              throw undefined;
            },
          };
          for (let i = 0; i < 2; i++) {
            try {
              await session.close(app);
            } catch (error) {
              assert.equal(error, undefined);
            }
          }
          throw false;
        },
        {
          context: ctx,
          parent: base.parent,
          secondary: () => {},
          invoke: async (request) => {
            closeOperations.push(request.operation);
            return {};
          },
        },
      );
    } catch (error) {
      caught = true;
      raw = error;
    }
    assert(caught);
    assert.equal(raw, false);
    assert.deepEqual(closeCalls, ['close']);
    assert.deepEqual(closeOperations, ['prepare']);
    const uncertainOps = [];
    await assert.rejects(
      withManagedAppImage(base, async () => true, {
        context: ctx,
        parent: base.parent,
        secondary: () => {},
        invoke: async (request) => {
          uncertainOps.push(request.operation);
          throw Object.assign(new Error('helper deadline'), {
            managedUncertain: true,
          });
        },
      }),
      /helper deadline/,
    );
    assert.deepEqual(uncertainOps, ['prepare']); // No racing cleanup after helper timeout.
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, 'exit');
        child.kill('SIGKILL');
        await ended;
      }
    }
    // Pipe-holder worker has its own finite lifetime; never target an arbitrary
    // PID. Its inherited local pipes were detached by the actual tracker.
  }
}

async function checkBootstrapDiagnostics() {
  const observation = managedBootstrapObservation(
    '\x1b[31mError: EACCES /workspace with spaces/node\x1b[0m\n' +
      'authorization: Bearer SECRET\nurl=https://user:SECRET@example.test/path?token=SECRET\n' +
      'password: SECRET\ntoken="SECRET with spaces"\nkey=\'SECRET unfinished\n' +
      'at /tmp/SECRET/module.mjs:1:2\ncontrol\x00\x1b[2J\rtest\u202e\x1b]0;SECRET\x07',
    ['/workspace with spaces/node'],
  );
  assert.match(observation, /Error: EACCES <path>/);
  assert.doesNotMatch(observation, /SECRET|workspace|\x1b|\x00|\r|\u202e/);
  assert.equal(managedBootstrapObservation('x'.repeat(65537)), '');
  for (const text of ['é'.repeat(32000), '😀'.repeat(16000)]) {
    const result = managedBootstrapObservation(text);
    assert(Buffer.byteLength(result) <= 1024);
    assert(!result.includes('\ufffd'));
  }
  for (const raw of [
    undefined,
    null,
    false,
    0,
    '',
    {},
    {
      toString() {
        throw false;
      },
    },
  ])
    assert.equal(managedBootstrapObservation(raw), '');
  const protocol = {
    operation: 'prepare',
    reason: 'empty-response',
    outputBytes: 0,
    stderrBytes: 20,
    code: 1,
    signal: null,
  };
  for (const raw of [
    undefined,
    null,
    false,
    0,
    '',
    {
      toString() {
        throw false;
      },
    },
  ]) {
    const writes = [];
    await recordManagedProtocol(
      '/owned/managed-protocol.json',
      { managedProtocol: protocol, managedBootstrap: raw },
      {
        mkdir: async () => {},
        writeFile: async (path, text) => writes.push([path, text]),
      },
    );
    assert.equal(writes.length, 1);
    assert.equal(Object.keys(JSON.parse(writes[0][1])).length, 6);
  }
  for (const effects of [
    {
      mkdir: async () => {
        throw false;
      },
      writeFile: async () => assert.fail('no write'),
    },
    {
      mkdir: async () => {},
      writeFile: async (path) => {
        if (path.endsWith('.txt')) throw null;
      },
    },
  ])
    await recordManagedProtocol(
      '/owned/managed-protocol.json',
      { managedProtocol: protocol, managedBootstrap: 'Error: EACCES' },
      effects,
    );
  const sensitive = { managedProtocol: protocol };
  Object.defineProperty(sensitive, 'managedBootstrap', {
    get() {
      throw false;
    },
  });
  await recordManagedProtocol('/owned/managed-protocol.json', sensitive, {
    mkdir: async () => {},
    writeFile: async () => {},
  });
  // A timed-out ordinary writer is explicitly released and settled before teardown.
  let release, settled;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const done = new Promise((resolve) => {
    settled = resolve;
  });
  const started = performance.now();
  await recordManagedProtocol(
    '/owned/managed-protocol.json',
    { managedProtocol: protocol, managedBootstrap: 'Error: EACCES' },
    {
      mkdir: async () => {},
      writeFile: async (path) => {
        if (path.endsWith('.txt')) {
          await held;
          settled();
        }
      },
    },
  );
  assert(performance.now() - started >= 450);
  release();
  await done;
}

// Non-Linux proc link/stat are explicit Linux models; Windows also models
// POSIX path/mode. File hashing and harmless Node execution are real. Never invoke sudo or
// the private entry. Linux additionally exercises the actual kernel resolver.
async function checkManagedNodeExecutable(source) {
  const node = await realpath(
    process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
  );
  const proc = '/proc/self/exe';
  const windows = process.platform === 'win32';
  const path = windows ? '/toolchain/node' : node;
  const metadata = await lstat(node);
  const linuxMetadata = (value) =>
    windows
      ? {
          ...value,
          mode: 0o100755,
          isFile: () => value.isFile(),
          isSymbolicLink: () => value.isSymbolicLink(),
        }
      : value;
  const io = {
    link: async () => path,
    canonical: windows ? async () => path : realpath,
    lstat: async () => linuxMetadata(await lstat(node)),
    stat: async () => linuxMetadata(await stat(node)),
    hash: (value) =>
      boundedHash(value === proc || value === path ? node : value),
  };
  const selected = await managedNodeExecutable(performance.now() + 12000, io);
  assert.equal(selected, path);
  const clean = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' };
  const version = spawnSync(windows ? node : selected, ['--version'], {
    env: clean,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), process.version);
  if (process.platform === 'linux') {
    assert.equal(
      await managedNodeExecutable(performance.now() + 12000),
      await realpath(proc),
    );
    console.log('Actual Linux kernel executing-Node resolver PASS');
  } else
    console.log(
      'Linux proc identity modeled; actual toolchain hash/version PASS',
    );
  if (process.env.JS_BINARY__NODE_WRAPPER && process.platform !== 'win32') {
    assert.equal(process.execPath, process.env.JS_BINARY__NODE_WRAPPER);
    const old = spawnSync(process.execPath, ['--version'], {
      env: clean,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(old.status, 1);
    assert.match(old.stderr, /JS_BINARY__NODE_BINARY.*unbound variable/);
    console.log(
      'Actual Bazel wrapper clean-env FAIL; verified native Node clean-env PASS',
    );
  }
  const begin = source.indexOf('async function rootInvoke(');
  const end = source.indexOf('function nativeEffects(', begin);
  const preserved = new Function(
    `return ${source.match(/const preserved = (\[[\s\S]*?\]);/)[1]}`,
  )();
  let captured = false;
  const positive = new Function(
    'd',
    `const {managedNodeExecutable,managedHostedContext,process,spawn,preserved,ownFile,waitManagedChild,boundedRead,processIdentity,validManagedResponse}=d;${source.slice(begin, end)};return rootInvoke;`,
  )({
    managedNodeExecutable: (expires) => managedNodeExecutable(expires, io),
    managedHostedContext: async () => ctx,
    process,
    preserved,
    ownFile: '/reviewed/managed-appimage.mjs',
    waitManagedChild,
    boundedRead: async () => '',
    processIdentity: () => ({ birth: '1' }),
    validManagedResponse,
    spawn: (command, args, options) => {
      captured = true;
      assert.equal(command, '/usr/bin/sudo');
      assert.deepEqual(args, [
        '-n',
        `--preserve-env=${preserved.join(',')}`,
        '--',
        path,
        '/reviewed/managed-appimage.mjs',
        '--managed-appimage-private',
      ]);
      assert.deepEqual(options.env, {
        ...clean,
        ...Object.fromEntries(preserved.map((key) => [key, process.env[key]])),
      });
      assert.equal(options.env.NODE_OPTIONS, undefined);
      assert.equal(options.env.JS_BINARY__NODE_BINARY, undefined);
      return spawn(
        node,
        [
          '-e',
          `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({ok:false,error:'harmless owned refusal',uncertain:true}));process.exitCode=1;});`,
        ],
        { stdio: options.stdio, env: clean },
      );
    },
  });
  await assert.rejects(
    positive({ operation: 'prepare' }),
    (error) =>
      error.message === 'harmless owned refusal' &&
      error.managedUncertain === true,
  );
  assert.equal(captured, true);
  console.log(
    'Actual resolver + production sudo argv/clean env + owned child transport PASS',
  );
  let spawned = 0;
  const invoke = (resolver) =>
    new Function(
      'd',
      `const {managedNodeExecutable,managedHostedContext,process,spawn}=d;${source.slice(begin, end)};return rootInvoke;`,
    )({
      managedNodeExecutable: resolver,
      managedHostedContext: async () => ctx,
      process,
      spawn: () => {
        spawned++;
        throw new Error('Unexpected privileged spawn');
      },
    });
  const pinnedMetadata = linuxMetadata(metadata);
  for (const [name, change] of [
    ['relative', { link: async () => 'node' }],
    ['deleted', { link: async () => path + ' (deleted)' }],
    ['control-character', { link: async () => path + '\n' }],
    [
      'unreadable',
      {
        link: async () => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        },
      },
    ],
    ['noncanonical', { canonical: async () => '/different' }],
    [
      'symlink',
      {
        lstat: async () => ({
          ...pinnedMetadata,
          isFile: () => true,
          isSymbolicLink: () => true,
        }),
      },
    ],
    [
      'nonexecutable',
      {
        lstat: async () => ({
          ...pinnedMetadata,
          mode: pinnedMetadata.mode & ~0o111,
          isFile: () => true,
          isSymbolicLink: () => false,
        }),
      },
    ],
    [
      'writable',
      {
        lstat: async () => ({
          ...pinnedMetadata,
          mode: pinnedMetadata.mode | 0o002,
          isFile: () => true,
          isSymbolicLink: () => false,
        }),
      },
    ],
    [
      'foreign-owner',
      {
        lstat: async () => ({
          ...pinnedMetadata,
          uid: 987654,
          isFile: () => true,
          isSymbolicLink: () => false,
        }),
      },
    ],
    [
      'inode-mismatch',
      {
        stat: async () => ({ ...pinnedMetadata, ino: pinnedMetadata.ino + 1 }),
      },
    ],
    ['content-mismatch', { hash: async (path) => hash(path) }],
    ['invalid-hash', { hash: async () => 'bad' }],
    [
      'changed-link',
      {
        link: (() => {
          let reads = 0;
          return async () => (++reads === 1 ? path : '/changed');
        })(),
      },
    ],
    [
      'changed-file',
      {
        lstat: (() => {
          let reads = 0;
          return async () =>
            ++reads === 1
              ? pinnedMetadata
              : { ...pinnedMetadata, ino: pinnedMetadata.ino + 1 };
        })(),
      },
    ],
  ]) {
    await assert.rejects(
      invoke((expires) => managedNodeExecutable(expires, { ...io, ...change }))(
        { operation: 'prepare' },
      ),
      (error) => error.managedUncertain === true,
      name,
    );
    assert.equal(spawned, 0, name);
  }
  await assert.rejects(
    managedNodeExecutable(performance.now() - 1, io),
    (e) => e.managedUncertain === true,
  );
  // The original transport expiration includes resolution. Use a short model
  // budget and settle the outstanding read-only work before leaving the test.
  let release, done;
  const reading = new Promise((resolve) => {
    release = resolve;
  });
  const finished = new Promise((resolve) => {
    done = resolve;
  });
  const delayed = {
    ...io,
    hash: async () => {
      await reading;
      done();
      return hash('node');
    },
  };
  const shortBody = source
    .slice(begin, end)
    .replace('performance.now() + 12000', 'performance.now() + 30');
  const shortInvoke = new Function(
    'd',
    `const {managedNodeExecutable,managedHostedContext,process,spawn}=d;${shortBody};return rootInvoke;`,
  )({
    managedNodeExecutable: (expires) => managedNodeExecutable(expires, delayed),
    managedHostedContext: async () => ctx,
    process,
    spawn: () => {
      spawned++;
      throw new Error('Unexpected privileged spawn');
    },
  });
  try {
    await assert.rejects(
      shortInvoke({ operation: 'prepare' }),
      (e) => e.managedUncertain === true && /deadline/.test(e.message),
    );
    assert.equal(spawned, 0);
  } finally {
    release();
    await finished;
  }
  console.log(
    'Executing Node provenance refusals and shared setup deadline PASS',
  );
}

// Exact private transport body with sudo/proc replaced by owned Node/model IO.
// No parser/root entry is executed. Both transport and real wrapper participate.
async function checkManagedTransport(source) {
  const begin = source.indexOf('async function rootInvoke(');
  const end = source.indexOf('function nativeEffects(', begin);
  assert(begin >= 0 && end > begin);
  const node = process.env.JS_BINARY__NODE_BINARY ?? process.execPath;
  const children = [];
  const closures = [];
  const directory = await mkdtemp(
    join(tmpdir(), 'canopy-transport-bootstrap-'),
  );
  const bootstrap = join(directory, 'managed-appimage.mjs');
  // Actual private source fails during import, before any native entry/effect.
  // Omit its observer dependency deliberately; this is not the hosted cause.
  await writeFile(bootstrap, source);
  const signatures = {
    'empty-response': 'unknown fixture stderr /secret/path request=SECRET',
    'node-module-error':
      'Error [ERR_MODULE_NOT_FOUND]: /secret/path token=SECRET',
    'sudo-authentication': 'sudo: a password is required\n',
    'sudo-environment':
      'sudo: sorry, you are not allowed to preserve the environment\n',
    'nonempty-json': 'Error [ERR_MODULE_NOT_FOUND]: /secret/path token=SECRET',
    'coherent-failure-stderr':
      'Error [ERR_MODULE_NOT_FOUND]: /secret/path token=SECRET',
  };
  try {
    for (const [name, envelope, expectedUncertain] of [
      ['actual-bootstrap-module', '', true],
      ['actual-bootstrap-system', '', true],
      ['empty-response', '', true],
      ['node-module-error', '', true],
      ['sudo-authentication', '', true],
      ['sudo-environment', '', true],
      ['nonempty-json', '', true],
      [
        'coherent-failure-stderr',
        { ok: false, error: 'fixture failure', uncertain: false },
        false,
      ],
      ['invalid-json', '{', true],
      ['null', null, true],
      ['array', [], true],
      ['missing-ok', {}, true],
      ['string-ok', { ok: 'true', value: {} }, true],
      ['missing-failure-uncertainty', { ok: false, error: 'failure' }, true],
      [
        'string-uncertainty',
        { ok: false, error: 'failure', uncertain: 'false' },
        true,
      ],
      ['missing-error', { ok: false, uncertain: false }, true],
      ['number-error', { ok: false, error: 0, uncertain: false }, true],
      [
        'large-error',
        { ok: false, error: 'x'.repeat(4097), uncertain: false },
        true,
      ],
      ['missing-success', { ok: true }, true],
      ['null-success', { ok: true, value: null }, true],
      ['incomplete-success', { ok: true, value: {} }, true],
      [
        'known-failure',
        { ok: false, error: 'fixture known failure', uncertain: false },
        false,
      ],
      [
        'uncertain-failure',
        { ok: false, error: 'fixture uncertain failure', uncertain: true },
        true,
      ],
      ['valid-success', undefined, false],
      ['stdin-error', undefined, true],
      ['write-throw', undefined, true],
      ['write-callback-fault', undefined, true],
      ['serialization-throw', undefined, true],
    ]) {
      const operations = [],
        kernel = model();
      let current;
      const invoke = new Function(
        'd',
        `const {managedNodeExecutable,managedHostedContext,process,spawn,preserved,ownFile,waitManagedChild,boundedRead,processIdentity,validManagedResponse,managedBootstrapObservation,dirname}=d; ${source.slice(begin, end)};return rootInvoke;`,
      )({
        managedNodeExecutable: async () => node,
        managedBootstrapObservation,
        dirname: posix.dirname,
        managedHostedContext: async () => ctx,
        process,
        preserved: [],
        ownFile: '/unused',
        boundedRead: async () => '',
        processIdentity: () => ({ birth: '1' }),
        validManagedResponse,
        waitManagedChild,
        spawn: (command, args, options) => {
          assert.equal(command, '/usr/bin/sudo');
          assert.deepEqual(args, [
            '-n',
            '--preserve-env=',
            '--',
            node,
            '/unused',
            '--managed-appimage-private',
          ]);
          assert.deepEqual(options.env, {
            PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
            LANG: 'C',
          });
          let reply,
            code = 0;
          if (current.operation === 'cleanup')
            reply = { ok: true, value: current.cleaned };
          else if (envelope === undefined)
            reply = { ok: true, value: current.prepared };
          else {
            reply = envelope;
            code =
              typeof envelope === 'object' && envelope?.ok === true ? 0 : 1;
          }
          const text =
            name === 'invalid-json' || name === 'nonempty-json'
              ? '{'
              : Object.hasOwn(signatures, name) &&
                  name !== 'coherent-failure-stderr'
                ? ''
                : JSON.stringify(reply);
          const child = spawn(
            node,
            name.startsWith('actual-bootstrap-')
              ? name === 'actual-bootstrap-module'
                ? [bootstrap, '--managed-appimage-private']
                : [
                    '-e',
                    `try { require('node:fs').openSync(${JSON.stringify(join(directory, 'absent'))}, 'r'); } catch(error) { console.error(error); process.exitCode=1; }`,
                  ]
              : [
                  '-e',
                  `const timer=setTimeout(()=>process.exit(0),500);process.stdin.resume();process.stdin.on('end',()=>{clearTimeout(timer);process.stdout.write(${JSON.stringify(text)});process.stderr.write(${JSON.stringify(signatures[name] ?? '')});process.exitCode=${code};});`,
                ],
            { stdio: ['pipe', 'pipe', 'pipe'] },
          );
          children.push(child);
          closures.push(new Promise((resolve) => child.once('close', resolve)));
          if (current.operation === 'prepare' && name === 'stdin-error') {
            const end = child.stdin.end;
            child.stdin.end = function (...args) {
              this.emit('error', new Error('fixture input fault'));
              return end.apply(this, args);
            };
          }
          if (
            current.operation === 'prepare' &&
            name === 'write-callback-fault'
          ) {
            const end = child.stdin.end;
            child.stdin.end = function (text, callback) {
              callback(new Error('fixture write callback fault'));
              return end.call(this, text);
            };
          }
          if (current.operation === 'prepare' && name === 'write-throw')
            child.stdin.end = () => {
              throw new Error('fixture write fault');
            };
          return child;
        },
      });
      let caught = false,
        failure;
      try {
        await withManagedAppImage(base, async () => true, {
          context: ctx,
          parent: base.parent,
          secondary: () => {},
          invoke: async (request) => {
            operations.push(request.operation);
            current = { ...request };
            if (request.operation === 'cleanup')
              current.cleaned = await managedOperation(request, kernel.io, ctx);
            if (request.operation === 'prepare' && envelope === undefined)
              current.prepared = await managedOperation(
                request,
                kernel.io,
                ctx,
              );
            // The actual request serializes only core fields, not the modeled reply.
            if (
              name === 'serialization-throw' &&
              request.operation === 'prepare'
            )
              request.toJSON = () => {
                throw new Error('fixture serialization fault');
              };
            return invoke(request);
          },
        });
      } catch (error) {
        caught = true;
        failure = error;
      }
      if (name === 'valid-success') assert(!caught);
      else {
        assert(caught, name);
        assert.equal(
          failure.managedUncertain === true,
          expectedUncertain,
          name,
        );
      }
      if (expectedUncertain) {
        const writes = [],
          observations = [];
        await recordManagedProtocol('/owned/protocol.json', failure, {
          mkdir: async () => {},
          writeFile: async (path, text) => {
            if (path.endsWith('.json')) writes.push(JSON.parse(text));
            else {
              observations.push(text);
              assert(path.endsWith('managed-bootstrap.txt'));
              assert(Buffer.byteLength(text) <= 1024);
              assert.doesNotMatch(
                text,
                /SECRET|secret|canopy-transport-bootstrap/,
              );
            }
          },
        });
        assert.equal(writes.length, 1, name);
        if (name.startsWith('actual-bootstrap-')) {
          assert.equal(observations.length, 1, name);
          assert.match(
            observations[0],
            name === 'actual-bootstrap-system'
              ? /ENOENT/
              : /ERR_MODULE_NOT_FOUND/,
          );
        }
        assert(['prepare'].includes(writes[0].operation));
        assert(!JSON.stringify(writes[0]).includes('fixture known failure'));
        assert.equal(Object.keys(writes[0]).length, 6);
        if (
          Object.hasOwn(signatures, name) ||
          name.startsWith('actual-bootstrap-')
        ) {
          assert.equal(
            writes[0].reason,
            name === 'actual-bootstrap-system'
              ? 'empty-response'
              : name === 'actual-bootstrap-module'
                ? 'node-module-error'
                : name === 'nonempty-json'
                  ? 'json'
                  : name,
          );
          assert.doesNotMatch(
            JSON.stringify(writes[0]),
            /SECRET|secret|Canopy|managed-appimage\.mjs/,
          );
          assert.deepEqual(operations, ['prepare']);
        }
        // Reporting failure never replaces the exact transport exception.
        await recordManagedProtocol('/owned/protocol.json', failure, {
          mkdir: async () => {
            throw false;
          },
          writeFile: async () => assert.fail('no write'),
        });
      }
      assert.equal(operations.includes('cleanup'), !expectedUncertain, name);
      if (name === 'coherent-failure-stderr')
        assert.equal(failure.managedProtocol.reason, 'helper-failure');
    }
    // Successful reply shape is operation-specific; malformed cleanup/launch
    // cannot borrow a valid preparation state as a terminal success.
    const kernel = model();
    const prepared = await managedOperation(
      { ...base, operation: 'prepare' },
      kernel.io,
      ctx,
    );
    assert(
      validManagedResponse(
        { ok: true, value: prepared },
        { ...base, operation: 'check' },
      ),
    );
    for (const value of [
      null,
      {},
      { removed: 'true' },
      { empty: 1 },
      { removed: true, empty: true },
      prepared,
    ])
      assert(
        !validManagedResponse(
          { ok: true, value },
          { ...base, operation: 'cleanup' },
        ),
      );
    assert(
      validManagedResponse(
        { ok: true, value: { removed: true } },
        { ...base, operation: 'cleanup' },
      ),
    );
    assert(
      !validManagedResponse(
        { ok: true, value: prepared },
        { ...base, operation: 'launch' },
      ),
    );
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, 'exit');
        child.kill('SIGKILL');
        await ended;
      }
    }
    await Promise.all(closures);
    await rm(directory, { recursive: true, force: true });
  }
}

// Complete success transport controls use source-produced values and actual
// owned Node IPC. Kernel/file/process identities remain models, never native proof.
function checkManagedResponseSchema(value, request) {
  const response = { ok: true, value };
  assert(validManagedResponse(response, request));
  const fields = [];
  const visit = (object, path = []) => {
    if (object === null || typeof object !== 'object') return;
    for (const key of Object.keys(object)) {
      const current = [...path, key];
      fields.push([current, object[key]]);
      visit(object[key], current);
    }
  };
  visit(response);
  let omissions = 0,
    numbers = 0;
  const reject = (path, mutate) => {
    const changed = structuredClone(response);
    const parent = path
      .slice(0, -1)
      .reduce((object, key) => object[key], changed);
    mutate(parent, path.at(-1));
    // Rehash mutated receipts so hash mismatch cannot mask schema refusal.
    if (
      changed.value?.receipt &&
      path.join('.') !== 'value.receiptSha256' &&
      Object.hasOwn(changed.value, 'receiptSha256')
    )
      changed.value.receiptSha256 = hash(JSON.stringify(changed.value.receipt));
    assert(!validManagedResponse(changed, request), path.join('.'));
  };
  for (const [path, value] of fields) {
    reject(path, (parent, key) => {
      delete parent[key];
    });
    omissions++;
    if (typeof value === 'number')
      for (const invalid of [null, undefined, '0', NaN, Infinity, -Infinity]) {
        reject(path, (parent, key) => {
          parent[key] = invalid;
        });
        numbers++;
      }
  }
  for (const index of [1, 2]) {
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode'])
      for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
        reject(
          ['value', 'receipt', 'parents', String(index), 'identity', key],
          (parent, key) => {
            parent[key] = invalid;
          },
        );
    for (const [key, invalid] of [
      ['uid', 1001],
      ['gid', 1001],
      ['mode', 0o40777],
      ['mode', 0o44755],
      ['mode', 0o42755],
      ['mode', 0o100755],
      ['ino', 0],
      ['nlink', 2],
    ])
      reject(
        ['value', 'receipt', 'parents', String(index), 'identity', key],
        (parent, key) => {
          parent[key] = invalid;
        },
      );
    reject(
      ['value', 'receipt', 'parents', String(index), 'path'],
      (parent, key) => {
        parent[key] = '/opt';
      },
    );
    reject(
      ['value', 'receipt', 'original', 'parents', String(index), 'ino'],
      (parent, key) => {
        parent[key]++;
      },
    );
  }
  reject(['value', 'receipt', 'parents'], (parent, key) => {
    parent[key].splice(2, 1);
  });
  reject(['value', 'receipt', 'original', 'parents'], (parent, key) => {
    parent[key].splice(2, 1);
  });
  reject(['value', 'receipt', 'resources', '1', 'path'], (parent, key) => {
    parent[key] = '/opt/Canopy/Canopy.AppImage';
  });
  reject(['value', 'receipt', 'profile', 'content'], (parent, key) => {
    parent[key] = managedPolicy.replace(
      paths.original,
      '/opt/Canopy/Canopy.AppImage',
    );
  });
  console.log(
    `Managed ${request.operation} schema: ${omissions} omissions, ${numbers} numeric refusals PASS (modeled)`,
  );
}

async function checkManagedSuccessTransport(source, launchProof, launchInput) {
  const begin = source.indexOf('async function rootInvoke('),
    end = source.indexOf('function nativeEffects(', begin);
  assert(begin >= 0 && end > begin);
  const node = process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
    children = [];
  const mutations = [
    [
      'missing-parser-identity',
      (r) => {
        delete r.mutation.child;
        for (const key of ['pid', 'birth', 'identity', 'code', 'signal'])
          delete r.mutation.proof[key];
      },
    ],
    [
      'null-resource-identities',
      (r) => {
        r.resources = [null, null, null];
        r.parents = [null, null, null, null, null];
        r.self = {};
        r.source.identity = {};
        r.loaded.identity = {};
        r.original.metadata = {};
        r.original.parents = [];
      },
    ],
    [
      'missing-global-state',
      (r) => {
        delete r.global;
        delete r.loadAttempted;
      },
    ],
    [
      'numeric-writer-birth',
      (r) => {
        r.writer.birth = 123;
      },
    ],
    [
      'missing-mutation-operation-writer',
      (r) => {
        delete r.mutation.operation;
        delete r.mutation.writer;
      },
    ],
    [
      'source-mode',
      (r) => {
        r.source.identity.mode = 0o100777;
      },
    ],
    [
      'resource-mode',
      (r) => {
        r.resources[1].identity.mode = 0o100755;
      },
    ],
    [
      'foreign-parent',
      (r) => {
        r.parents[1].path = '/tmp';
      },
    ],
    [
      'foreign-resource',
      (r) => {
        r.resources[2].path = '/tmp/policy';
      },
    ],
    [
      'global-value',
      (r) => {
        r.global['/proc/sys/kernel/unprivileged_userns_clone'] = '0\n';
      },
    ],
    [
      'loaded-hash-type',
      (r) => {
        r.loaded.sha256 = 0;
      },
    ],
    [
      'original-size-type',
      (r) => {
        r.original.metadata.size = '8';
      },
    ],
    [
      'parser-code',
      (r) => {
        r.mutation.proof.code = 1;
      },
    ],
    [
      'parser-signal',
      (r) => {
        r.mutation.proof.signal = 'SIGTERM';
      },
    ],
    [
      'parser-parent',
      (r) => {
        r.mutation.child.parent = 999;
        r.mutation.proof.identity.parent = 999;
      },
    ],
    [
      'parser-birth-type',
      (r) => {
        r.mutation.child.birth = 112;
        r.mutation.proof.birth = 112;
        r.mutation.proof.identity.birth = 112;
      },
    ],
  ];
  const cases = [];
  for (const operation of ['prepare', 'check']) {
    cases.push([operation, 'valid', undefined]);
    for (const [name, change] of mutations)
      cases.push([
        operation,
        name,
        (value) => {
          change(value.receipt);
          value.receiptSha256 = hash(JSON.stringify(value.receipt));
        },
      ]);
    cases.push([
      operation,
      'receipt-hash',
      (value) => {
        value.receiptSha256 = 'f'.repeat(64);
      },
    ]);
  }
  cases.push(['launch', 'valid', undefined]);
  for (const [name, change] of [
    [
      'helper-owner',
      (v) => {
        v.launch.sample.sandboxHelper.uid = 1001;
      },
    ],
    [
      'helper-mode',
      (v) => {
        v.launch.sample.sandboxHelper.mode = 755;
      },
    ],
    [
      'missing-mount-options',
      (v) => {
        delete v.launch.sample.mount.options;
      },
    ],
    [
      'foreign-mount-source',
      (v) => {
        v.launch.sample.mount.source = '/tmp/other';
      },
    ],
    [
      'renderer-type',
      (v) => {
        v.launch.rendererPid = '80';
      },
    ],
    [
      'main-birth-type',
      (v) => {
        v.launch.sample.birth = 123;
      },
    ],
    [
      'payload-hash',
      (v) => {
        v.launch.sample.appAsarSha256 = 'f'.repeat(64);
      },
    ],
  ])
    cases.push(['launch', name, change]);
  // Both success and legitimate known failure must be uncertain if their
  // validation consumes the same expiration. Scale only this extracted fixture.
  cases.push(
    ['prepare', 'late-success', undefined],
    ['prepare', 'late-known-failure', undefined],
  );
  try {
    for (const [phase, name, change] of cases) {
      const kernel = model(),
        operations = [];
      let current,
        runEntered = false;
      const late = name.startsWith('late-');
      const body = source
        .slice(begin, end)
        .replace(
          'performance.now() + 12000',
          late ? 'performance.now() + 150' : 'performance.now() + 12000',
        );
      const invoke = new Function(
        'd',
        `const {managedNodeExecutable,managedHostedContext,process,spawn,preserved,ownFile,waitManagedChild,boundedRead,processIdentity,validManagedResponse,managedBootstrapObservation,dirname}=d;${body};return rootInvoke;`,
      )({
        managedNodeExecutable: async () => node,
        managedBootstrapObservation,
        dirname: posix.dirname,
        managedHostedContext: async () => ctx,
        process,
        preserved: [],
        ownFile: '/unused',
        waitManagedChild,
        boundedRead: async () => '',
        processIdentity: () => ({ birth: '1' }),
        validManagedResponse: (response, request, refused) => {
          const result = validManagedResponse(response, request, refused);
          if (late && request.operation === phase) {
            const until = performance.now() + 180;
            while (performance.now() < until) {}
          }
          return result;
        },
        spawn: () => {
          const text = JSON.stringify(current),
            code = current.ok ? 0 : 1;
          const child = spawn(
            node,
            [
              '-e',
              `const timer=setTimeout(()=>process.exit(1),1000);process.stdin.resume();process.stdin.on('end',()=>{clearTimeout(timer);process.stdout.write(${JSON.stringify(text)});process.exitCode=${code};});`,
            ],
            { stdio: ['pipe', 'pipe', 'pipe'] },
          );
          children.push(child);
          return child;
        },
      });
      let failed = false,
        failure;
      try {
        await withManagedAppImage(
          base,
          async (_, session) => {
            runEntered = true;
            if (phase === 'check') await session.check();
            if (phase === 'launch') await session.verify(launchInput);
            return true;
          },
          {
            context: ctx,
            parent: base.parent,
            secondary: () => {},
            invoke: async (request) => {
              operations.push(request.operation);
              let value =
                request.operation === 'launch'
                  ? {
                      ...(await managedOperation(
                        { ...request, operation: 'check' },
                        kernel.io,
                        ctx,
                      )),
                      launch: structuredClone(launchProof.launch),
                    }
                  : await managedOperation(request, kernel.io, ctx);
              if (request.operation === 'launch') {
                value.receipt.reader = structuredClone(
                  launchProof.receipt.reader,
                );
                value.receiptSha256 = hash(JSON.stringify(value.receipt));
              }
              if (request.operation === phase && change) change(value);
              current =
                name === 'late-known-failure' && request.operation === phase
                  ? {
                      ok: false,
                      error: 'fixture known failure',
                      uncertain: false,
                    }
                  : { ok: true, value };
              return invoke(request);
            },
          },
        );
      } catch (error) {
        failed = true;
        failure = error;
      }
      if (name === 'valid') {
        assert(!failed, phase);
        assert(operations.includes('cleanup'));
      } else {
        assert(failed, `${phase}/${name}`);
        assert.equal(failure.managedUncertain, true, `${phase}/${name}`);
        assert(!operations.includes('cleanup'), `${phase}/${name}`);
        if (phase === 'prepare') assert(!runEntered);
      }
    }
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, 'exit');
        child.kill('SIGKILL');
        await ended;
      }
  }
}
