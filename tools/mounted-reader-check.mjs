import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  readerCredentials,
  readerSource,
  readerProgram,
  readerScope,
  readerExecutable,
  qualifyReaderChild,
  readerTransport,
  validReaderState,
} from './mounted-reader.mjs';
import {
  managedOperation,
  managedPaths,
  managedProfile,
  validManagedResponse,
  managedInstallationSha256,
  acceptManagedObservation,
} from './managed-appimage.mjs';
const hash = (v) => createHash('sha256').update(v).digest('hex');
const status =
  'Uid: 1001 1001 1001 1001\nGid: 1002 1002 1002 1002\nGroups:\nCapInh: 0000000000000000\nCapPrm: 0000000000000000\nCapEff: 0000000000000000\nCapAmb: 0000000000000000\n';
const launch = {
  pid: 70,
  mainBirth: '123',
  rootPid: 70,
  rootBirth: '123',
  rendererPid: 80,
  rendererBirth: '456',
};
const mount = '/tmp/.mount_CanopyFIXTURE';
export async function checkMountedReader({ model, ctx, base, text }) {
  assert.deepEqual(readerCredentials(status, 1001, 1002).groups, []);
  for (const field of ['Uid', 'Gid'])
    for (let i = 0; i < 4; i++) {
      const values = Array(4).fill(field === 'Uid' ? 1001 : 1002);
      values[i] = 0;
      assert.throws(() =>
        readerCredentials(
          status.replace(
            new RegExp(`${field}:.*`),
            `${field}: ${values.join(' ')}`,
          ),
          1001,
          1002,
        ),
      );
    }
  for (const change of [
    status.replace('Groups:', 'Groups: 0'),
    status.replace('Groups:', 'Groups: 1002'),
    ...['CapInh', 'CapPrm', 'CapEff', 'CapAmb'].map((n) =>
      status.replace(`${n}: 0000000000000000`, `${n}: 0000000000000001`),
    ),
    status + 'Uid: 1001 1001 1001 1001\n',
    status.replace('CapAmb', 'Missing'),
    status.replace('Gid: 1002', 'Gid: bad'),
  ])
    assert.throws(() => readerCredentials(change, 1001, 1002));
  const fixture = async () => {
    const m = model();
    await managedOperation({ ...base, operation: 'prepare' }, m.io, ctx);
    const read = m.io.read,
      link = m.io.link,
      stat = m.io.stat,
      fileHash = m.io.hash;
    m.io.read = async (p) =>
      p.endsWith('/mountinfo')
        ? `25 1 0:100 / ${mount} ro,nosuid,nodev - fuse.Canopy.AppImage Canopy.AppImage ro,user_id=1001,group_id=1002`
        : p.endsWith('/attr/current')
          ? `${managedProfile} (unconfined)`
          : p === '/proc/80/status'
            ? 'NoNewPrivs: 1\nSeccomp: 2\n'
            : read(p);
    m.io.link = async (p) => (p.endsWith('/exe') ? mount + '/canopy' : link(p));
    m.io.stat = async (p) =>
      p.startsWith(mount + '/') ? { uid: 0, gid: 0, mode: 0o100755 } : stat(p);
    m.io.hash = async (p) =>
      p === mount + '/canopy'
        ? base.executableSha256
        : p === mount + '/resources/app.asar'
          ? base.appAsarSha256
          : p === mount + '/chrome-sandbox'
            ? base.helperSha256
            : fileHash(p);
    return m;
  };
  const request = { ...base, operation: 'launch', launch };
  const m = await fixture();
  // Root cannot read the mount. Only the modeled owner reader can; unchanged
  // payload predicates still run in production mountedEvidence.
  const reader = m.io.reader,
    canonical = m.io.canonical;
  m.io.canonical = async (p) => {
    if (p.startsWith(mount + '/'))
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return canonical(p);
  };
  m.io.reader = async (r, record) => {
    const rootCanonical = m.io.canonical;
    m.io.canonical = canonical;
    try {
      return await reader(r, record);
    } finally {
      m.io.canonical = rootCanonical;
    }
  };
  const beforeLaunch = await managedOperation(
    { ...base, operation: 'check' },
    m.io,
    ctx,
  );
  const value = await managedOperation(request, m.io, ctx);
  assert.equal(
    managedInstallationSha256(value),
    managedInstallationSha256(beforeLaunch),
  );
  const forged = await fixture();
  const retainedFiles = structuredClone([...forged.files]),
    retainedEffects = [...forged.calls];
  await assert.rejects(
    managedOperation(
      { ...request, launch: { ...launch, sample: value.launch.sample } },
      forged.io,
      ctx,
    ),
  );
  assert.deepEqual([...forged.files], retainedFiles);
  assert.deepEqual(forged.calls, retainedEffects);
  assert(validManagedResponse({ ok: true, value }, request));
  assert.equal(value.receipt.mutation.writer.pid, 90);
  assert.equal(value.receipt.reader.child.pid, 92);
  const qualified = structuredClone(value.receipt.reader);
  assert.equal(qualified.scope.mount.source, 'Canopy.AppImage');
  assert.equal(qualified.scope.mount.filesystem, 'fuse.Canopy.AppImage');
  assert.deepEqual(qualified.scope.mount, value.launch.sample.mount);
  const report = {
    completed: true,
    status: 'observed',
    finalizedAt: Date.now(),
    artifact: managedPaths.original,
    parent: base.parent.pid,
    parentBirth: base.parent.birth,
    managedReceipt: value.receipt.token,
    original: value.receipt.original,
    authority: {
      kind: 'retained-spawn',
      pid: launch.rootPid,
      birth: launch.rootBirth,
      originalSha256: base.sha256,
      managed: true,
    },
    samples: [value.launch.sample],
  };
  assert(acceptManagedObservation(report, value, launch, base.parent));
  // A plausible basename label never substitutes for retained original authority.
  for (const change of [
    (v) => {
      delete v.authority;
    },
    (v) => {
      v.artifact = '/tmp/Canopy.AppImage';
    },
    (v) => {
      v.authority.originalSha256 = 'f'.repeat(64);
    },
    (v) => {
      v.authority.birth = '999';
    },
    (v) => {
      v.authority.pid = 999;
    },
  ]) {
    const bad = structuredClone(report);
    change(bad);
    assert.throws(() =>
      acceptManagedObservation(bad, value, launch, base.parent),
    );
  }
  // Rehash and consistently forge every consumer association: foreign metadata
  // must still refuse, including the durable reader state used by cleanup.
  for (const [source, filesystem] of [
    [managedPaths.original, 'fuse.Canopy.AppImage'],
    ['/tmp/Canopy.AppImage', 'fuse.Canopy.AppImage'],
    ['Foreign.AppImage', 'fuse.Canopy.AppImage'],
    ['Canopy.AppImage.extra', 'fuse.Canopy.AppImage'],
    ['Canopy.AppImage', 'fuse.Foreign.AppImage'],
    ['Canopy.AppImage', 'fuse.Canopy'],
  ]) {
    const bad = structuredClone(value);
    for (const m of [bad.launch.sample.mount, bad.receipt.reader.scope.mount]) {
      m.source = source;
      m.filesystem = filesystem;
    }
    bad.receiptSha256 = hash(JSON.stringify(bad.receipt));
    assert(!validReaderState(bad.receipt.reader, true));
    assert(!validManagedResponse({ ok: true, value: bad }, request));
    const observation = { ...report, samples: [bad.launch.sample] };
    assert.throws(() =>
      acceptManagedObservation(observation, bad, launch, base.parent),
    );
    const kernel = await fixture();
    kernel.files.get(managedPaths.receipt).content = JSON.stringify(
      bad.receipt,
    );
    const files = structuredClone([...kernel.files]),
      effects = [...kernel.calls];
    await assert.rejects(
      managedOperation({ ...base, operation: 'cleanup' }, kernel.io, ctx),
    );
    assert.deepEqual([...kernel.files], files);
    assert.deepEqual(kernel.calls, effects);
  }
  for (const alteration of [
    (r) => {
      r.state = 'pending';
      r.proof = null;
    },
    (r) => {
      r.child = null;
    },
    (r) => {
      r.proof.closed = false;
    },
    (r) => {
      r.writer.uid = 1001;
    },
    (r) => {
      r.child.parent = 1;
    },
    (r) => {
      r.scope.gid = 1001;
    },
    (r) => {
      r.node.source.programSha256 = 'f'.repeat(64);
    },
    (r) => {
      r.proof.identity.birth = '114';
    },
  ]) {
    const bad = await fixture();
    const receipt = JSON.parse(bad.files.get(managedPaths.receipt).content);
    receipt.reader = structuredClone(qualified);
    alteration(receipt.reader);
    bad.files.get(managedPaths.receipt).content = JSON.stringify(receipt);
    const before = structuredClone([...bad.files]),
      effects = [...bad.calls];
    await assert.rejects(
      managedOperation({ ...base, operation: 'cleanup' }, bad.io, ctx),
    );
    assert.deepEqual([...bad.files], before);
    assert.deepEqual(bad.calls, effects);
    const response = structuredClone(value);
    response.receipt.reader = receipt.reader;
    response.receiptSha256 = hash(JSON.stringify(response.receipt));
    assert(!validManagedResponse({ ok: true, value: response }, request));
  }
  // Old receipt cannot authorize deletion. Source-backed orphan-reader case:
  // root writer gone and no AppImage occupant still refuses every effect.
  for (const state of [
    'missing',
    'pending-unborn',
    'pending-orphan',
    'closed-live',
    'closed-unreadable',
    'closed-reader-writer-live',
  ]) {
    const bad = await fixture(),
      receipt = JSON.parse(bad.files.get(managedPaths.receipt).content);
    receipt.reader = structuredClone(qualified);
    if (state === 'missing') delete receipt.reader;
    if (state.startsWith('pending')) {
      receipt.reader.state = 'pending';
      receipt.reader.proof = null;
      if (state.endsWith('unborn')) receipt.reader.child = null;
    }
    if (state === 'closed-reader-writer-live') {
      receipt.reader.writer = { pid: 93, birth: '114', uid: 0 };
      receipt.reader.child.parent = 93;
      receipt.reader.proof.identity.parent = 93;
      const read = bad.io.read,
        stat = bad.io.lstat;
      bad.io.read = async (p) =>
        p === '/proc/93/stat' ? text(1, '114') : read(p);
      bad.io.lstat = async (p) => (p === '/proc/93' ? { uid: 0 } : stat(p));
    }
    if (
      state !== 'closed-reader-writer-live' &&
      (state.includes('live') || state.includes('unreadable'))
    ) {
      const read = bad.io.read,
        stat = bad.io.lstat;
      bad.io.read = async (p) => {
        if (p === '/proc/92/stat') {
          if (state.includes('unreadable')) throw new Error('unreadable');
          return text(1, '113');
        }
        return read(p);
      };
      bad.io.lstat = async (p) => (p === '/proc/92' ? { uid: 1001 } : stat(p));
    }
    bad.files.get(managedPaths.receipt).content = JSON.stringify(receipt);
    const before = structuredClone([...bad.files]),
      effects = [...bad.calls];
    await assert.rejects(
      managedOperation({ ...base, operation: 'cleanup' }, bad.io, ctx),
    );
    assert.deepEqual([...bad.files], before);
    assert.deepEqual(bad.calls, effects);
  }
  for (const failure of ['lost', 'birth', 'late', 'schema', 'falsy']) {
    const bad = await fixture();
    bad.io.reader = async (r, record) => {
      assert.equal(
        JSON.parse(bad.files.get(managedPaths.receipt).content).reader.state,
        'pending',
      );
      if (failure !== 'birth')
        await record({ pid: 92, birth: '113', uid: 1001, parent: 90 });
      if (failure === 'falsy') throw false;
      if (failure !== 'schema') throw new Error(failure);
      return { proof: { closed: true }, files: [] };
    };
    let caught = false;
    try {
      await managedOperation(request, bad.io, ctx);
    } catch (e) {
      caught = true;
      if (failure === 'falsy') assert.equal(e, false);
    }
    assert(caught);
    const before = structuredClone([...bad.files]),
      effects = [...bad.calls];
    await assert.rejects(
      managedOperation({ ...base, operation: 'cleanup' }, bad.io, ctx),
    );
    assert.deepEqual([...bad.files], before);
    assert.deepEqual(bad.calls, effects);
  }
  // Mount owner and namespace association fail before a reader launch.
  for (const changed of [
    'owner-missing',
    'owner-duplicate',
    'gid-zero',
    'gid-mismatch',
    'mapping',
    'namespace',
    'source',
    'absolute-source',
    'foreign-filesystem',
    'original-hash',
    'root-birth',
    'main-parent',
    'profile',
    'saved',
  ]) {
    const bad = await fixture(),
      read = bad.io.read,
      link = bad.io.link;
    bad.io.reader = async () => assert.fail('reader must not spawn');
    bad.io.read = async (p) => {
      let v = await read(p);
      if (p.endsWith('/mountinfo')) {
        if (changed === 'owner-missing') v = v.replace(',group_id=1002', '');
        if (changed === 'owner-duplicate') v += ',group_id=1002';
        if (changed === 'gid-zero')
          v = v.replace('group_id=1002', 'group_id=0');
        if (changed === 'source')
          v = v.replace(' Canopy.AppImage ', ' Foreign.AppImage ');
        if (changed === 'absolute-source')
          v = v.replace(' Canopy.AppImage ', ` ${managedPaths.original} `);
        if (changed === 'foreign-filesystem')
          v = v.replace('fuse.Canopy.AppImage', 'fuse.Foreign.AppImage');
      }
      if (p === '/proc/70/stat' && changed === 'root-birth')
        v = text(50, '999');
      if (p === '/proc/70/stat' && changed === 'main-parent')
        v = text(999, '123');
      if (p.endsWith('/attr/current') && changed === 'profile')
        v = 'Canopy.AppImage (unconfined)';
      if (p === '/proc/70/status' && changed === 'gid-mismatch')
        v = v.replace('Gid: 1002', 'Gid: 1001');
      if (p === '/proc/70/status' && changed === 'saved')
        v = v.replace('Uid: 1001 1001 1001 1001', 'Uid: 1001 1001 0 1001');
      if (p.endsWith('/uid_map') && changed === 'mapping') v = '0 1000 1000\n';
      return v;
    };
    bad.io.link = async (p) =>
      changed === 'namespace' && p === '/proc/70/ns/user'
        ? 'user:[99]'
        : link(p);
    if (changed === 'original-hash')
      bad.files.get(managedPaths.original).content = 'foreign';
    const before = structuredClone([...bad.files]),
      effects = [...bad.calls];
    await assert.rejects(managedOperation(request, bad.io, ctx));
    assert.deepEqual([...bad.files], before);
    assert.deepEqual(bad.calls, effects);
  }
  // The fixed source label reaches subsequent owner qualification unchanged.
  const observed = await fixture();
  const observedRead = observed.io.read;
  let reachedOwner = false;
  observed.io.read = async (p) => {
    if (p === '/proc/70/status') {
      reachedOwner = true;
      return (await observedRead(p)).replace('Gid: 1002', 'Gid: 0');
    }
    return observedRead(p);
  };
  await assert.rejects(
    readerScope(observed.io, request, managedPaths.original),
  );
  assert(reachedOwner);
  await assert.rejects(
    readerScope((await fixture()).io, request, '/tmp/Canopy.AppImage'),
  );
  console.log(
    'Managed exact kernel label and independent original/retained/profile authority controls PASS (modeled)',
  );
  // Failed but confirmed closed reader remains FAIL, while independent guards
  // can authorize resource cleanup after actual child absence.
  const failed = await fixture();
  failed.io.reader = async (r, record) => {
    const child = { pid: 92, birth: '113', uid: 1001, parent: 90 };
    await record(child);
    return {
      proof: {
        spawned: true,
        closed: true,
        timedOut: false,
        pid: 92,
        birth: '113',
        identity: child,
        code: 1,
        signal: null,
        accepted: false,
      },
    };
  };
  await assert.rejects(managedOperation(request, failed.io, ctx));
  const failedRead = failed.io.read;
  failed.io.read = async (p) =>
    p.endsWith('/attr/current') ? 'unconfined' : failedRead(p);
  await managedOperation({ ...base, operation: 'cleanup' }, failed.io, ctx);
  assert(!failed.files.has(managedPaths.receipt));
  await checkChildQualification(qualified, text);
  await checkTransport(qualified);
  await checkCapsule(qualified, text);
  await checkNativeLaunch(qualified, ctx);
  // Real ordinary owned Node with fixed capsule: wrong credential contract on
  // this host exits before readiness/mount access. No identity setters execute.
  const child = spawn(
    process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
    ['--input-type=module', '--eval', readerProgram],
    {
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const output = [];
  child.stdout.on('data', (v) => output.push(v));
  child.stderr.resume();
  child.stdin.on('error', () => {}); // Early credential refusal may close the pipe before init.
  child.stdin.end(
    JSON.stringify({
      phase: 'init',
      nonce: qualified.nonce,
      uid: 1001,
      gid: 1002,
      mount,
    }) + '\n',
  );
  const terminal = await new Promise((resolve) =>
    child.once('close', (code) => resolve(code)),
  );
  assert.equal(terminal, 1);
  assert.equal(Buffer.concat(output).length, 0);
  console.log(
    'Mounted owner reader credential/provenance/gate/persistent orphan refusal and cleanup controls PASS (modeled; owned Node only)',
  );
}

async function checkChildQualification(r, text) {
  const argv = ['--input-type=module', '--eval', readerProgram];
  const child = new ChildProcess();
  Object.assign(child, {
    pid: 92,
    spawnfile: r.node.path,
    spawnargs: [r.node.path, ...argv],
  });
  const io = {
    read: async (p) =>
      p.endsWith('/stat')
        ? text(90, '113')
        : p.endsWith('/status')
          ? status
          : p.endsWith('/cmdline')
            ? [r.node.path, ...argv].join('\0') + '\0'
            : p.endsWith('/environ')
              ? 'PATH=/usr/bin:/bin\0LANG=C\0'
              : r.scope.mappings[p.split('/').at(-1)],
    link: async (p) =>
      p.endsWith('/exe')
        ? r.node.path
        : r.scope.namespaces[p.split('/').at(-1)],
    execStat: async () => r.node.identity,
    lstat: async () => ({
      ...r.node.identity,
      isFile: () => true,
      isSymbolicLink: () => false,
    }),
    hash: async (p) =>
      p === readerSource.path ? readerSource.sha256 : r.node.sha256,
    canonical: async (p) => p,
  };
  assert.deepEqual(await qualifyReaderChild(io, child, r, argv), r.child);
  assert.deepEqual(await readerExecutable(io), r.node);
  for (const name of [
    'parent',
    'birth',
    'uid',
    'gid',
    'groups',
    'caps',
    'exe',
    'inode',
    'hash',
    'source',
    'argv',
    'env',
    'namespace',
    'mapping',
    'drop',
  ]) {
    const bad = { ...io };
    bad.read = async (p) => {
      const v = await io.read(p);
      if (p.endsWith('/stat') && name === 'parent') return text(1, '113');
      if (p.endsWith('/stat') && name === 'birth') return 'malformed';
      if (p.endsWith('/status')) {
        if (name === 'uid' || name === 'drop')
          return v.replace('Uid: 1001', 'Uid: 0');
        if (name === 'gid') return v.replace('Gid: 1002', 'Gid: 0');
        if (name === 'groups') return v.replace('Groups:', 'Groups: 0');
        if (name === 'caps')
          return v.replace(
            'CapEff: 0000000000000000',
            'CapEff: 0000000000000001',
          );
      }
      if (p.endsWith('/cmdline') && name === 'argv') return v + 'foreign\0';
      if (p.endsWith('/environ') && name === 'env')
        return v + 'NODE_OPTIONS=foreign\0';
      if (p.endsWith('/uid_map') && name === 'mapping') return '0 0 1';
      return v;
    };
    if (name === 'exe' || name === 'namespace')
      bad.link = async (p) =>
        (p.endsWith('/exe') && name === 'exe') ||
        (p.endsWith('/ns/user') && name === 'namespace')
          ? '/foreign'
          : io.link(p);
    if (name === 'inode')
      bad.execStat = async () => ({ ...r.node.identity, ino: 900 });
    if (name === 'hash' || name === 'source')
      bad.hash = async (p) =>
        name === 'hash' || p === readerSource.path
          ? 'f'.repeat(64)
          : io.hash(p);
    await assert.rejects(qualifyReaderChild(bad, child, r, argv), name);
  }
}
async function checkTransport(r) {
  for (const kind of [
    'valid',
    'nonce',
    'phase',
    'identity',
    'schema',
    'duplicate',
    'lost',
    'gate-write',
    'delayed',
    'nonzero',
    'still-live',
    'terminal-nonce',
    'terminal-phase',
    'terminal-identity',
    'terminal-schema',
    'no-exit',
    'partial',
    'spawn-error',
    'pipe-error',
    'init-write',
  ]) {
    const child = new ChildProcess();
    child.pid = 92;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const writes = [];
    child.stdin.on('data', (v) => writes.push(v.toString()));
    const transport = readerTransport(child, r, {
      expires: performance.now() + 50,
      qualify: async () => {
        if (kind === 'delayed')
          await new Promise((resolve) => setTimeout(resolve, 70));
        return r.child;
      },
      record: async () => {},
    });
    // Attach rejection observer before scheduling modeled transport events.
    const outcome = transport.then(
      (v) => ({ v }),
      (e) => ({ e }),
    );
    if (kind === 'init-write')
      child.stdin.write = (_v, cb) => cb(new Error('init failed'));
    child.emit('spawn');
    if (kind === 'spawn-error') child.emit('error', new Error('spawn failed'));
    if (kind === 'pipe-error')
      child.stdout.emit('error', new Error('pipe failed'));
    if (kind !== 'lost') {
      const ready = { phase: 'ready', nonce: r.nonce, identity: r.child };
      if (kind === 'nonce') ready.nonce = 'b'.repeat(32);
      if (kind === 'phase') ready.phase = 'result';
      if (kind === 'identity') ready.identity = { ...r.child, birth: '999' };
      if (kind === 'schema') ready.extra = true;
      if (kind === 'gate-write')
        child.stdin.end = (_v, cb) => cb(new Error('write'));
      child.stdout.write(JSON.stringify(ready) + '\n');
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (
        kind === 'valid' ||
        kind === 'nonzero' ||
        kind === 'duplicate' ||
        kind === 'still-live' ||
        kind.startsWith('terminal-') ||
        kind === 'no-exit' ||
        kind === 'partial'
      ) {
        const terminal = {
          phase: 'result',
          nonce: r.nonce,
          identity: r.child,
          files: [],
        };
        if (kind === 'terminal-nonce') terminal.nonce = 'f'.repeat(32);
        if (kind === 'terminal-phase') terminal.phase = 'ready';
        if (kind === 'terminal-identity')
          terminal.identity = { ...r.child, birth: '999' };
        if (kind === 'terminal-schema') terminal.extra = true;
        const result =
          JSON.stringify(terminal) + (kind === 'partial' ? '' : '\n');
        child.stdout.write(result);
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (kind === 'duplicate') child.stdout.write(result);
      }
    }
    if (kind !== 'still-live' && kind !== 'lost' && kind !== 'delayed') {
      child.stdout.end();
      child.stderr.end();
      if (kind !== 'no-exit')
        child.emit('exit', kind === 'nonzero' ? 1 : 0, null);
      child.emit('close');
    }
    const result = await outcome;
    if (kind === 'valid' || kind === 'nonzero') {
      assert(result.v);
      assert.equal(result.v.proof.accepted, kind === 'valid');
      assert.equal(writes.length, 2);
    } else {
      assert(result.e?.managedUncertain, kind);
      if (
        ['nonce', 'phase', 'identity', 'schema', 'lost', 'delayed'].includes(
          kind,
        )
      )
        assert.equal(writes.length, 1);
    }
    for (const s of [child.stdin, child.stdout, child.stderr]) s.destroy();
  }
}

async function checkCapsule(r, text) {
  const source = await readFile(
    new URL('./mounted-reader.mjs', import.meta.url),
    'utf8',
  );
  const begin = source.indexOf('async function capsule(credentials) {');
  const end = source.indexOf('const credentialProgram', begin);
  assert(begin >= 0 && end > begin);
  const body = source
    .slice(begin, end)
    .replace("await import('node:fs/promises')", 'd.fs')
    .replace("await import('node:crypto')", 'd.crypto');
  const make = new Function(
    'd',
    `const process=d.process;${body};return capsule;`,
  );
  for (const kind of [
    'valid',
    'nonce',
    'phase',
    'identity',
    'extra',
    'no-ack',
    'groups',
    'post-gate-caps',
    'escape',
    'inode',
    'truncated',
  ]) {
    const stdin = new PassThrough(),
      outputs = [],
      effects = [];
    let statusReads = 0,
      signalReady;
    const ready = new Promise((resolve) => {
      signalReady = resolve;
    });
    const process = {
      pid: r.child.pid,
      stdin,
      stdout: {
        write: (v, cb) => {
          outputs.push(JSON.parse(v));
          cb();
          signalReady();
        },
      },
    };
    const content = Buffer.from('fixed-owned-model-payload');
    const metadata = {
      ...r.node.identity,
      uid: 0,
      gid: 0,
      ino: 610,
      size: content.length,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
    const fs = {
      readFile: async (p) => {
        if (p === '/proc/self/stat') return text(90, '113');
        assert.equal(p, '/proc/self/status');
        statusReads++;
        if (kind === 'groups') return status.replace('Groups:', 'Groups: 0');
        if (kind === 'post-gate-caps' && statusReads > 1)
          return status.replace(
            'CapEff: 0000000000000000',
            'CapEff: 0000000000000001',
          );
        return status;
      },
      realpath: async (p) => {
        effects.push('canonical:' + p);
        return kind === 'escape' ? '/foreign' : p;
      },
      lstat: async (p) => {
        effects.push('stat:' + p);
        return metadata;
      },
      open: async (p, mode) => {
        effects.push('open:' + p);
        assert.equal(mode, 'r');
        return {
          stat: async () =>
            kind === 'inode' ? { ...metadata, ino: 999 } : metadata,
          read: async (buffer, offset, length, position) => {
            if (kind === 'truncated') return { bytesRead: 0 };
            const n = Math.min(length, content.length - position);
            content.copy(buffer, offset, position, position + n);
            return { bytesRead: n };
          },
          close: async () => {
            effects.push('close:' + p);
          },
        };
      },
    };
    const capsule = make({ process, fs, crypto: { createHash } });
    const outcome = capsule(readerCredentials).then(
      () => ({ ok: true }),
      (e) => ({ e }),
    );
    stdin.write(
      JSON.stringify({
        phase: 'init',
        nonce: r.nonce,
        uid: 1001,
        gid: 1002,
        mount,
      }) + '\n',
    );
    if (kind !== 'groups') {
      await ready;
      assert.deepEqual(effects, []);
      assert.deepEqual(outputs, [
        { phase: 'ready', nonce: r.nonce, identity: r.child },
      ]);
      const ack = { phase: 'read', nonce: r.nonce, identity: r.child };
      if (kind === 'nonce') ack.nonce = 'f'.repeat(32);
      if (kind === 'phase') ack.phase = 'init';
      if (kind === 'identity') ack.identity = { ...r.child, parent: 1 };
      if (kind === 'extra') ack.extra = true;
      stdin.end(kind === 'no-ack' ? '' : JSON.stringify(ack) + '\n');
    } else stdin.end();
    const result = await outcome;
    if (kind === 'valid') {
      assert(result.ok);
      assert.equal(outputs.length, 2);
      assert.equal(outputs[1].phase, 'result');
      assert.deepEqual(
        outputs[1].files.map((f) => f.path),
        ['canopy', 'resources/app.asar', 'chrome-sandbox'].map(
          (p) => mount + '/' + p,
        ),
      );
      assert(outputs[1].files.every((f) => f.sha256 === hash(content)));
      assert.equal(effects.filter((p) => p.startsWith('close:')).length, 3);
    } else {
      assert(result.e, kind);
      if (
        [
          'nonce',
          'phase',
          'identity',
          'extra',
          'no-ack',
          'groups',
          'post-gate-caps',
        ].includes(kind)
      )
        assert.deepEqual(effects, []);
    }
    stdin.destroy();
  }
}
async function checkNativeLaunch(r, ctx) {
  const source = await readFile(
    new URL('./managed-appimage.mjs', import.meta.url),
    'utf8',
  );
  const begin = source.indexOf('function nativeEffects() {'),
    end = source.indexOf('\nif', begin);
  assert(begin >= 0 && end > begin);
  let launched = 0;
  const harmless = () => {};
  const deps = {
    managedGuard: () => {},
    managedPaths,
    process: {
      env: { ...ctx.env, SUDO_UID: '1001' },
      platform: 'linux',
      arch: 'x64',
      getuid: () => 0,
    },
    rootExpiration: performance.now() + 1000,
    readerProgram,
    stat: harmless,
    boundedRead: harmless,
    boundedHash: harmless,
    readlink: harmless,
    realpath: harmless,
    lstat: harmless,
    readdir: harmless,
    readerTransport: async (child, state, options) => {
      assert.equal(child, 'owned-model-child');
      assert.equal(state, r);
      assert(options.expires === deps.rootExpiration);
      return 'intercepted';
    },
    spawn: (path, argv, options) => {
      launched++;
      assert.equal(path, r.node.path);
      assert.deepEqual(argv, ['--input-type=module', '--eval', readerProgram]);
      assert.deepEqual(options, {
        uid: 1001,
        gid: 1002,
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return 'owned-model-child';
    },
  };
  const factory = new Function(
    'd',
    `const {${Object.keys(deps).join(',')}}=d;${source.slice(begin, end)};return nativeEffects();`,
  );
  assert.equal(await factory(deps).reader(r, async () => {}), 'intercepted');
  assert.equal(launched, 1);
}
