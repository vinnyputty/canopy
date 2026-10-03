import { ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  managedMountLabel,
  mountedPath,
  processIdentity,
} from './appimage-observer.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (v, names) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === names.length &&
  names.every((k) => Object.hasOwn(v, k));
const id = (v) => Number.isSafeInteger(v) && v > 0 && v <= 0xffffffff;
const hex = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const refuse = () => {
  throw new Error('Mounted reader qualification refused');
};
const fields = [
  'dev',
  'ino',
  'uid',
  'gid',
  'mode',
  'nlink',
  'size',
  'mtimeMs',
  'ctimeMs',
];
const pin = (v) => Object.fromEntries(fields.map((k) => [k, v[k]]));
const validPin = (v) =>
  keys(v, fields) &&
  fields.every(
    (k) =>
      Number.isFinite(v[k]) &&
      (['mtimeMs', 'ctimeMs'].includes(k) ||
        (Number.isSafeInteger(v[k]) && v[k] >= 0)),
  ) &&
  v.ino > 0 &&
  v.nlink === 1 &&
  v.size > 0 &&
  v.size <= 256 * 1024 * 1024 &&
  (v.mode & 0o170000) === 0o100000 &&
  !(v.mode & 0o6022);
const writer = (v) =>
  keys(v, ['pid', 'birth', 'uid']) &&
  id(v.pid) &&
  typeof v.birth === 'string' &&
  /^\d+$/.test(v.birth) &&
  v.uid === 0;

// Raw kernel fields, not getgroups(): Node adds the effective primary GID.
export function readerCredentials(text, uid, gid) {
  if (
    !id(uid) ||
    !id(gid) ||
    typeof text !== 'string' ||
    Buffer.byteLength(text) > 65536
  )
    refuse();
  const one = (name) => {
    const rows = text.split('\n').filter((line) => line.startsWith(name + ':'));
    if (rows.length !== 1) refuse();
    return rows[0].slice(name.length + 1).trim();
  };
  for (const [name, value] of [
    ['Uid', uid],
    ['Gid', gid],
  ]) {
    const raw = one(name);
    if (
      !/^\d+\s+\d+\s+\d+\s+\d+$/.test(raw) ||
      raw.split(/\s+/).some((x) => Number(x) !== value)
    )
      refuse();
  }
  if (one('Groups') !== '') refuse();
  for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb'])
    if (!/^0{16}$/.test(one(name))) refuse();
  return { uid, gid, groups: [], capabilities: '0000000000000000' };
}

export async function readerScope(io, request, original) {
  const { pid, mainBirth, rootPid, rootBirth } = request.launch;
  const main = processIdentity(await io.read(`/proc/${pid}/stat`));
  const root = processIdentity(await io.read(`/proc/${rootPid}/stat`));
  if (
    main.birth !== mainBirth ||
    root.birth !== rootBirth ||
    (pid !== rootPid && main.parent !== rootPid) ||
    root.parent !== request.parent.pid
  )
    refuse();
  const executable = await io.link(`/proc/${pid}/exe`);
  const mount = mountedPath(
    executable,
    await io.read(`/proc/${pid}/mountinfo`),
  );
  if (
    original !== '/var/lib/canopy-appimage-ci/Canopy.AppImage' ||
    !managedMountLabel(mount)
  )
    refuse();
  const owner = (name) => {
    const values = `${mount.options},${mount.superOptions}`
      .split(',')
      .filter((s) => s.startsWith(name + '='));
    if (
      values.length !== 1 ||
      !new RegExp(`^${name}=[1-9]\\d*$`).test(values[0])
    )
      refuse();
    const value = Number(values[0].split('=')[1]);
    if (!id(value)) refuse();
    return value;
  };
  const uid = owner('user_id'),
    gid = owner('group_id');
  if (uid !== request.uid) refuse();
  // Require the actual mount/root/main/reader namespace and complete ID mappings
  // to be identical. No UID/GID inference or cross-namespace translation.
  const namespaces = {};
  for (const name of ['user', 'mnt']) {
    const value = await io.link(`/proc/${pid}/ns/${name}`);
    if (
      !new RegExp(`^${name}:\\[\\d+\\]$`).test(value) ||
      value !== (await io.link(`/proc/${rootPid}/ns/${name}`)) ||
      value !== (await io.link(`/proc/self/ns/${name}`))
    )
      refuse();
    namespaces[name] = value;
  }
  const mappings = {};
  for (const name of ['uid_map', 'gid_map']) {
    const value = await io.read(`/proc/${pid}/${name}`);
    if (
      !/^\s*0\s+0\s+4294967295\s*$/.test(value) ||
      value !== (await io.read(`/proc/${rootPid}/${name}`)) ||
      value !== (await io.read(`/proc/self/${name}`))
    )
      refuse();
    mappings[name] = value;
  }
  for (const procPid of new Set([pid, rootPid])) {
    const status = await io.read(`/proc/${procPid}/status`);
    for (const [name, expected] of [
      ['Uid', uid],
      ['Gid', gid],
    ]) {
      const rows = status.split('\n').filter((s) => s.startsWith(name + ':'));
      if (
        rows.length !== 1 ||
        !new RegExp(`^${name}:\\s+\\d+\\s+\\d+\\s+\\d+\\s+\\d+\\s*$`).test(
          rows[0],
        ) ||
        rows[0]
          .split(/\s+/)
          .slice(1)
          .filter(Boolean)
          .some((s) => Number(s) !== expected)
      )
        refuse();
    }
  }
  return {
    launch: request.launch,
    mount,
    executable,
    uid,
    gid,
    namespaces,
    mappings,
  };
}

// This function is a closed capsule. Only builtins and fixed derived paths;
// caller data is JSON, never code or a module/path callback. Its loaded bytes
// are passed directly to the qualified executing Node, not reopened by child.
async function capsule(credentials) {
  const { open, lstat, realpath, readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const check = (value) => {
    if (!value) throw new Error('reader refused');
  };
  const lines = async function* () {
    let text = '';
    for await (const chunk of process.stdin) {
      text += chunk;
      check(Buffer.byteLength(text) <= 16384);
      while (text.includes('\n')) {
        const end = text.indexOf('\n');
        const line = text.slice(0, end);
        text = text.slice(end + 1);
        yield JSON.parse(line);
      }
    }
    check(text === '');
  };
  const send = (v) =>
    new Promise((resolve, reject) =>
      process.stdout.write(JSON.stringify(v) + '\n', (e) =>
        e ? reject(e) : resolve(),
      ),
    );
  const input = lines();
  const first = await input.next();
  const c = first.value;
  check(
    !first.done &&
      c?.phase === 'init' &&
      /^[a-f0-9]{32}$/.test(c.nonce) &&
      /^\/tmp\/\.mount_Canopy[a-zA-Z0-9]+$/.test(c.mount),
  );
  credentials(await readFile('/proc/self/status', 'utf8'), c.uid, c.gid);
  const raw = await readFile('/proc/self/stat', 'utf8');
  const parts = raw
    .slice(raw.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  const identity = {
    pid: process.pid,
    birth: parts[19],
    uid: c.uid,
    parent: Number(parts[1]),
  };
  check(/^\d+$/.test(identity.birth));
  await send({ phase: 'ready', nonce: c.nonce, identity });
  const ack = await input.next();
  check(
    !ack.done &&
      JSON.stringify(ack.value) ===
        JSON.stringify({ phase: 'read', nonce: c.nonce, identity }),
  );
  // Parent closes stdin with this exact gate. EOF failure precedes mounted IO.
  check((await input.next()).done);
  credentials(await readFile('/proc/self/status', 'utf8'), c.uid, c.gid);
  const results = [];
  for (const suffix of ['canopy', 'resources/app.asar', 'chrome-sandbox']) {
    const path = c.mount + '/' + suffix;
    check((await realpath(path)) === path);
    const before = await lstat(path);
    check(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.nlink === 1 &&
        !(before.mode & 0o022),
    );
    const handle = await open(path, 'r');
    let sha256;
    const fields = [
      'dev',
      'ino',
      'uid',
      'gid',
      'mode',
      'nlink',
      'size',
      'mtimeMs',
      'ctimeMs',
    ];
    const pin = (m) => Object.fromEntries(fields.map((k) => [k, m[k]]));
    try {
      const meta = await handle.stat();
      check(
        JSON.stringify(pin(meta)) === JSON.stringify(pin(before)) &&
          Number.isSafeInteger(meta.size) &&
          meta.size > 0 &&
          meta.size <= 256 * 1024 * 1024,
      );
      const hash = createHash('sha256'),
        buffer = Buffer.alloc(65536);
      for (let offset = 0; offset < meta.size;) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, meta.size - offset),
          offset,
        );
        check(bytesRead > 0);
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      check(
        JSON.stringify(pin(await handle.stat())) ===
          JSON.stringify(pin(before)),
      );
      sha256 = hash.digest('hex');
    } finally {
      await handle.close();
    }
    check(
      (await realpath(path)) === path &&
        JSON.stringify(pin(await lstat(path))) === JSON.stringify(pin(before)),
    );
    results.push({ path, identity: pin(before), sha256 });
  }
  credentials(await readFile('/proc/self/status', 'utf8'), c.uid, c.gid);
  await send({ phase: 'result', nonce: c.nonce, identity, files: results });
}
const credentialProgram = readerCredentials.toString();
// credential function dependencies are fixed reviewed source, not caller input.
export const readerProgram = `const id=${id.toString()};const refuse=${refuse.toString()};(${capsule.toString()})(${credentialProgram}).catch(()=>{process.stderr.write('reader refused\\n');process.exitCode=1;});`;
const sourcePath = fileURLToPath(import.meta.url);
const loadedSourceHash = hash(readFileSync(sourcePath));
export const readerSource = Object.freeze({
  path: sourcePath,
  sha256: loadedSourceHash,
  programSha256: hash(readerProgram),
});

export async function readerExecutable(io) {
  const path = await io.link('/proc/self/exe');
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.length > 4096 ||
    /[\p{Cc}\p{Cf}]/u.test(path) ||
    path.endsWith(' (deleted)') ||
    (await io.canonical(path)) !== path
  )
    refuse();
  const metadata = await io.lstat(path),
    identity = pin(metadata);
  // The root's already-executing bootstrap is authority. File owner rules of
  // managedNodeExecutable remain intact; no newly selected toolchain path.
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !validPin(identity) ||
    !(identity.mode & 0o111) ||
    !same(identity, pin(await io.execStat('/proc/self/exe')))
  )
    refuse();
  const sha256 = await io.hash('/proc/self/exe');
  if (
    !hex(sha256) ||
    sha256 !== (await io.hash(path)) ||
    !same(identity, pin(await io.lstat(path))) ||
    (await io.link('/proc/self/exe')) !== path ||
    !same(identity, pin(await io.execStat('/proc/self/exe')))
  )
    refuse();
  if ((await io.hash(readerSource.path)) !== readerSource.sha256) refuse();
  return { path, identity, sha256, source: readerSource };
}

export function validReaderState(r, settled = false) {
  if (r === null) return !settled;
  if (
    !keys(r, ['state', 'nonce', 'writer', 'scope', 'node', 'child', 'proof']) ||
    !['pending', 'closed'].includes(r.state) ||
    typeof r.nonce !== 'string' ||
    !/^[a-f0-9]{32}$/.test(r.nonce) ||
    !writer(r.writer)
  )
    return false;
  const s = r.scope,
    n = r.node;
  if (
    !keys(s, [
      'launch',
      'mount',
      'executable',
      'uid',
      'gid',
      'namespaces',
      'mappings',
    ]) ||
    !id(s.uid) ||
    !id(s.gid) ||
    !keys(s.launch, [
      'pid',
      'mainBirth',
      'rootPid',
      'rootBirth',
      'rendererPid',
      'rendererBirth',
    ]) ||
    !['pid', 'rootPid', 'rendererPid'].every((k) => id(s.launch[k])) ||
    !['mainBirth', 'rootBirth', 'rendererBirth'].every(
      (k) => typeof s.launch[k] === 'string' && /^\d+$/.test(s.launch[k]),
    ) ||
    !keys(s.mount, [
      'path',
      'options',
      'filesystem',
      'source',
      'superOptions',
    ]) ||
    !/^\/tmp\/\.mount_Canopy[a-zA-Z0-9]+$/.test(s.mount.path) ||
    !managedMountLabel(s.mount) ||
    s.executable !== s.mount.path + '/canopy' ||
    !keys(s.namespaces, ['user', 'mnt']) ||
    !['user', 'mnt'].every((k) =>
      new RegExp(`^${k}:\\[\\d+\\]$`).test(s.namespaces[k]),
    ) ||
    !keys(s.mappings, ['uid_map', 'gid_map']) ||
    !Object.values(s.mappings).every(
      (v) => typeof v === 'string' && /^\s*0\s+0\s+4294967295\s*$/.test(v),
    )
  )
    return false;
  for (const [name, v] of [
    ['user_id', s.uid],
    ['group_id', s.gid],
  ]) {
    if (
      typeof s.mount.options !== 'string' ||
      typeof s.mount.superOptions !== 'string' ||
      s.mount.options.length > 4096 ||
      s.mount.superOptions.length > 4096
    )
      return false;
    const values = `${s.mount.options},${s.mount.superOptions}`
      .split(',')
      .filter((x) => x.startsWith(name + '='));
    if (values.length !== 1 || values[0] !== `${name}=${v}`) return false;
  }
  if (
    !keys(n, ['path', 'identity', 'sha256', 'source']) ||
    typeof n.path !== 'string' ||
    !n.path.startsWith('/') ||
    n.path.length > 4096 ||
    /[\p{Cc}\p{Cf}]/u.test(n.path) ||
    !validPin(n.identity) ||
    ![0, s.uid].includes(n.identity.uid) ||
    !(n.identity.mode & 0o111) ||
    !hex(n.sha256) ||
    !keys(n.source, ['path', 'sha256', 'programSha256']) ||
    !same(n.source, readerSource)
  )
    return false;
  const c = r.child;
  if (
    c !== null &&
    (!keys(c, ['pid', 'birth', 'uid', 'parent']) ||
      !id(c.pid) ||
      typeof c.birth !== 'string' ||
      !/^\d+$/.test(c.birth) ||
      c.uid !== s.uid ||
      c.parent !== r.writer.pid ||
      c.pid === r.writer.pid)
  )
    return false;
  if (r.state === 'pending') return !settled && r.proof === null;
  const p = r.proof;
  return (
    c !== null &&
    keys(p, [
      'spawned',
      'closed',
      'timedOut',
      'pid',
      'birth',
      'identity',
      'code',
      'signal',
      'accepted',
    ]) &&
    p.spawned === true &&
    p.closed === true &&
    p.timedOut === false &&
    p.pid === c.pid &&
    p.birth === c.birth &&
    same(p.identity, c) &&
    Number.isInteger(p.code) &&
    p.code >= 0 &&
    p.code <= 255 &&
    p.signal === null &&
    typeof p.accepted === 'boolean' &&
    (!p.accepted || p.code === 0)
  );
}

export function readerFileEffects(r, files) {
  if (
    !validReaderState(r, true) ||
    !r.proof.accepted ||
    !Array.isArray(files) ||
    files.length !== 3
  )
    refuse();
  const paths = ['canopy', 'resources/app.asar', 'chrome-sandbox'].map(
    (s) => r.scope.mount.path + '/' + s,
  );
  for (let i = 0; i < 3; i++) {
    const f = files[i];
    if (
      !keys(f, ['path', 'identity', 'sha256']) ||
      f.path !== paths[i] ||
      !hex(f.sha256) ||
      !validPin({ ...f.identity, mode: f.identity?.mode & ~0o6000 }) ||
      !keys(f.identity, fields)
    )
      refuse();
    if (i < 2 && f.identity.mode & 0o6000) refuse();
  }
  const get = (path) => files.find((f) => f.path === path) ?? refuse();
  return {
    canonical: async (path) => get(path).path,
    hash: async (path) => get(path).sha256,
    stat: async (path) => get(path).identity,
  };
}

export async function qualifyReaderChild(io, actual, r, argv) {
  if (
    !(actual instanceof ChildProcess) ||
    !id(actual.pid) ||
    actual.exitCode !== null ||
    actual.signalCode !== null ||
    actual.spawnfile !== r.node.path ||
    !same(actual.spawnargs, [r.node.path, ...argv])
  )
    refuse();
  const path = `/proc/${actual.pid}`;
  const before = processIdentity(await io.read(path + '/stat'));
  if (before.parent !== r.writer.pid || !/^\d+$/.test(before.birth)) refuse();
  readerCredentials(await io.read(path + '/status'), r.scope.uid, r.scope.gid);
  if (
    (await io.link(path + '/exe')) !== r.node.path ||
    (await io.canonical(r.node.path)) !== r.node.path ||
    !same(pin(await io.execStat(path + '/exe')), r.node.identity) ||
    (await io.hash(path + '/exe')) !== r.node.sha256 ||
    (await io.hash(r.node.path)) !== r.node.sha256 ||
    !same(pin(await io.lstat(r.node.path)), r.node.identity) ||
    (await io.hash(readerSource.path)) !== readerSource.sha256
  )
    refuse();
  if (
    (await io.read(path + '/cmdline')) !==
    [r.node.path, ...argv].join('\0') + '\0'
  )
    refuse();
  const environment = (await io.read(path + '/environ'))
    .split('\0')
    .filter(Boolean)
    .sort();
  if (!same(environment, ['LANG=C', 'PATH=/usr/bin:/bin'])) refuse();
  for (const name of ['user', 'mnt'])
    if ((await io.link(path + '/ns/' + name)) !== r.scope.namespaces[name])
      refuse();
  for (const name of ['uid_map', 'gid_map'])
    if ((await io.read(path + '/' + name)) !== r.scope.mappings[name]) refuse();
  if (!same(before, processIdentity(await io.read(path + '/stat')))) refuse();
  return {
    pid: actual.pid,
    birth: before.birth,
    uid: r.scope.uid,
    parent: before.parent,
  };
}

// Actual ChildProcess association plus readiness gate and drained terminal pipes.
// Timeout/transport failure never records closure; durable pending survives root.
export function readerTransport(child, r, { expires, qualify, record }) {
  return new Promise((resolve, reject) => {
    let spawned = false,
      identity,
      gated = false,
      initWritten = false,
      gateWritten = false,
      result,
      exited = false,
      closed = false,
      stdoutEOF = false,
      stderrEOF = false,
      code,
      signal,
      text = '',
      bytes = 0,
      settled = false,
      busy = false;
    const fault = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const s of [child.stdin, child.stdout, child.stderr]) s?.destroy();
      reject(
        Object.assign(new Error('Mounted reader transport/closure unproved'), {
          managedUncertain: true,
        }),
      );
    };
    const time = () => Number.isFinite(expires) && performance.now() < expires;
    const finish = () => {
      if (settled) return;
      if (!time()) return fault();
      if (
        !closed ||
        !exited ||
        busy ||
        !identity ||
        !stdoutEOF ||
        !stderrEOF ||
        !initWritten ||
        (gated && !gateWritten)
      )
        return;
      if (!spawned || !Number.isInteger(code) || signal !== null || text !== '')
        return fault();
      settled = true;
      clearTimeout(timer);
      resolve({
        proof: {
          spawned: true,
          closed: true,
          timedOut: false,
          pid: identity.pid,
          birth: identity.birth,
          identity,
          code,
          signal,
          accepted: gated && !!result && code === 0,
        },
        files: result?.files,
      });
    };
    const timer = setTimeout(fault, Math.max(0, expires - performance.now()));
    const consume = async (line) => {
      if (settled || !time() || !spawned) return fault();
      busy = true;
      try {
        const v = JSON.parse(line);
        if (!gated) {
          if (
            !keys(v, ['phase', 'nonce', 'identity']) ||
            v.phase !== 'ready' ||
            v.nonce !== r.nonce
          )
            refuse();
          identity = await qualify(child);
          if (settled || !time() || !same(v.identity, identity)) refuse();
          await record(identity);
          if (settled || !time()) refuse();
          // Recheck raw identity/source after the durable write, before the gate.
          if (!same(identity, await qualify(child))) refuse();
          if (settled || !time()) refuse();
          gated = true;
          child.stdin.end(
            JSON.stringify({ phase: 'read', nonce: r.nonce, identity }) + '\n',
            (e) => {
              if (e || !time()) fault();
              else {
                gateWritten = true;
                finish();
              }
            },
          );
        } else {
          if (
            result ||
            !keys(v, ['phase', 'nonce', 'identity', 'files']) ||
            v.phase !== 'result' ||
            v.nonce !== r.nonce ||
            !same(v.identity, identity)
          )
            refuse();
          result = v;
        }
      } catch {
        fault();
      } finally {
        busy = false;
        finish();
      }
    };
    child.once('spawn', () => {
      spawned = true;
      if (!time()) return fault();
      child.stdin.write(
        JSON.stringify({
          phase: 'init',
          nonce: r.nonce,
          uid: r.scope.uid,
          gid: r.scope.gid,
          mount: r.scope.mount.path,
        }) + '\n',
        (e) => {
          if (e || !time()) fault();
          else {
            initWritten = true;
            finish();
          }
        },
      );
    });
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (!time() || bytes > 65536 || busy) return fault();
      text += chunk;
      if (text.includes('\n')) {
        const end = text.indexOf('\n'),
          line = text.slice(0, end);
        text = text.slice(end + 1);
        if (text !== '') return fault();
        void consume(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length;
      if (!time() || bytes > 65536) fault();
    });
    child.stdout.once('end', () => {
      stdoutEOF = true;
      finish();
    });
    child.stderr.once('end', () => {
      stderrEOF = true;
      finish();
    });
    for (const stream of [child.stdin, child.stdout, child.stderr])
      stream.once('error', fault);
    child.once('error', fault);
    child.once('exit', (c, s) => {
      exited = true;
      code = c;
      signal = s;
      finish();
    });
    child.once('close', () => {
      closed = true;
      finish();
    });
  });
}

export async function mountedReader(
  io,
  receipt,
  request,
  save,
  original,
  revalidate,
) {
  const scope = await readerScope(io, request, original);
  const node = await io.readerExecutable();
  const r = {
    state: 'pending',
    nonce: randomBytes(16).toString('hex'),
    writer: await io.writer(),
    scope,
    node,
    child: null,
    proof: null,
  };
  if (!validReaderState(r)) refuse();
  receipt.reader = r;
  await save(); // Durable before spawn, independent of parser writer/proof.
  const terminal = await io.reader(r, async (child) => {
    r.child = child;
    await save();
  });
  r.state = 'closed';
  r.proof = terminal.proof;
  if (!validReaderState(r, true)) {
    r.state = 'pending';
    r.proof = null;
    refuse();
  }
  let effects,
    failed = false,
    primary;
  try {
    if (!r.proof.accepted) refuse();
    effects = readerFileEffects(r, terminal.files);
    if (
      !same(scope, await readerScope(io, request, original)) ||
      !same(node, await io.readerExecutable())
    )
      refuse();
    await revalidate();
  } catch (error) {
    failed = true;
    primary = error;
    r.proof.accepted = false;
  }
  await save();
  if (failed) throw primary;
  return effects;
}
