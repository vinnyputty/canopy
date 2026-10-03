import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import {
  mkdir,
  open,
  lstat,
  realpath,
  readdir,
  unlink,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename as hostBasename, posix } from 'node:path';
const { dirname, join, basename } = posix;
import { fileURLToPath } from 'node:url';
import {
  boundedRead,
  boundedHash,
  processIdentity,
  mountedEvidence,
  originalArtifact,
} from './appimage-observer.mjs';

export const managedPaths = Object.freeze({
  directory: '/opt/Canopy',
  original: '/opt/Canopy/Canopy.AppImage',
  receipt: '/opt/.canopy-appimage-ci.json',
  policy: '/etc/apparmor.d/canopy-appimage',
});
export const managedProfile = 'canopy-appimage';
export const managedPolicy = `abi <abi/4.0>,\ninclude <tunables/global>\nprofile canopy-appimage /opt/Canopy/Canopy.AppImage flags=(unconfined) {\n  userns,\n}\n`;
const digest = (text) => createHash('sha256').update(text).digest('hex');
const ownFile = fileURLToPath(import.meta.url);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hex = (value) => /^[a-f0-9]{64}$/.test(value ?? '');
const fail = (message) => {
  throw new Error(message);
};
const preserved = [
  'CANOPY_MANAGED_APPIMAGE',
  'GITHUB_ACTIONS',
  'RUNNER_ENVIRONMENT',
  'RUNNER_OS',
  'RUNNER_ARCH',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_WORKSPACE',
  'ImageOS',
  'ImageVersion',
];

export function managedGuard(context) {
  const { env, platform, arch, uid } = context;
  if (
    platform !== 'linux' ||
    arch !== 'x64' ||
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    env.CANOPY_MANAGED_APPIMAGE !== '1' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    env.RUNNER_OS !== 'Linux' ||
    env.RUNNER_ARCH !== 'X64' ||
    env.ImageOS !== 'ubuntu24' ||
    !/^\d+(?:\.\d+)+$/.test(env.ImageVersion ?? '') ||
    !/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9]\d{0,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
    !env.GITHUB_WORKSPACE?.startsWith('/')
  )
    fail(
      'Managed AppImage requires explicit disposable Ubuntu hosted CI opt-in',
    );
  return { run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, uid };
}
export async function managedHostedContext() {
  const context = {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    uid: process.getuid?.(),
  };
  managedGuard(context);
  context.osRelease = release(await boundedRead('/etc/os-release'));
  if (
    context.osRelease.ID !== 'ubuntu' ||
    context.osRelease.VERSION_ID !== '24.04'
  )
    fail('Managed opt-in requires actual Ubuntu 24.04');
  return context;
}
function release(text) {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => /^(ID|VERSION_ID)=/.test(line))
      .map((line) => {
        const [key, ...parts] = line.split('=');
        return [key, parts.join('=').replace(/^"|"$/g, '')];
      }),
  );
}
function identity(metadata, stable = false) {
  const keys = stable
    ? ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink']
    : [
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
  if (keys.some((key) => !Number.isFinite(metadata[key])))
    fail('Finite managed file identity required');
  return Object.fromEntries(keys.map((key) => [key, metadata[key]]));
}
async function protectedPath(io, path, directory = false, mode) {
  const m = await io.lstat(path);
  if (
    m.isSymbolicLink() ||
    (directory ? !m.isDirectory() : !m.isFile()) ||
    (await io.canonical(path)) !== path ||
    m.uid !== 0 ||
    m.gid !== 0 ||
    m.mode & 0o022 ||
    m.mode & 0o6000 ||
    (!directory && m.nlink !== 1) ||
    (mode !== undefined && (m.mode & 0o7777) !== mode)
  )
    fail('Managed ownership/path/mode mismatch');
  const pin = identity(m, directory);
  if (directory) delete pin.nlink; // Directory links change with our own creation/removal.
  return pin;
}
async function parents(io) {
  const result = [];
  for (const path of ['/', '/opt', '/etc', '/etc/apparmor.d'])
    result.push({ path, identity: await protectedPath(io, path, true) });
  return result;
}
async function absent(io, path) {
  try {
    await io.lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  fail('Existing managed destination, receipt or policy');
}
const globalFiles = [
  '/sys/module/apparmor/parameters/enabled',
  '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
  '/proc/sys/kernel/unprivileged_userns_clone',
];
async function globalState(io) {
  const values = await Promise.all(globalFiles.map((path) => io.read(path)));
  if (values.map((value) => value.trim()).join(',') !== 'Y,1,1')
    fail('Expected restricted AppArmor/user namespace state unavailable');
  return Object.fromEntries(
    globalFiles.map((path, index) => [path, values[index]]),
  );
}
async function loadedProfile(io) {
  const lines = (await io.read('/sys/kernel/security/apparmor/profiles'))
    .trim()
    .split('\n');
  const matches = lines.filter((line) =>
    /^canopy-appimage(?:\s|\/\/|$)/.test(line),
  );
  if (!matches.length) return null;
  if (matches.length !== 1 || matches[0] !== `${managedProfile} (unconfined)`)
    fail('Unexpected managed loaded profile');
  const base = '/sys/kernel/security/apparmor/policy/profiles';
  const entries = await io.list(base);
  if (entries.length > 4096) fail('Profile inventory exceeds bound');
  const found = [];
  for (const name of entries) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) fail('Unknown profile inventory path');
    const path = join(base, name);
    if ((await io.read(join(path, 'name'))).trim() === managedProfile) {
      const attach = (await io.read(join(path, 'attach'))).trim();
      const mode = (await io.read(join(path, 'mode'))).trim();
      const sha256 = await io.read(join(path, 'sha256'));
      if (
        attach !== managedPaths.original ||
        mode !== 'unconfined' ||
        !/^[a-f0-9]{64}\n$/.test(sha256)
      )
        fail('Loaded profile identity unavailable');
      found.push({
        path,
        attach,
        mode,
        sha256: sha256.trim(),
        identity: identity(await io.lstat(path), true),
      });
    }
  }
  if (found.length !== 1) fail('Ambiguous loaded profile identity');
  return found[0];
}
async function previousWriterAbsent(io, receipt) {
  const writer = receipt.writer;
  if (
    !Number.isSafeInteger(writer?.pid) ||
    writer.pid <= 0 ||
    !/^\d+$/.test(writer.birth ?? '') ||
    writer.uid !== 0
  )
    fail('Unknown managed writer identity; retain resources');
  const mutation = receipt.mutation;
  if (mutation) {
    const proof = mutation.proof;
    if (
      mutation.state !== 'closed' ||
      !['add', 'remove'].includes(mutation.operation) ||
      !proof?.spawned ||
      !proof.closed ||
      proof.timedOut ||
      !Number.isSafeInteger(proof.pid) ||
      proof.pid <= 0 ||
      !/^\d+$/.test(proof.birth ?? '') ||
      !same(proof.identity, mutation.child) ||
      proof.identity.uid !== 0 ||
      proof.identity.parent !== mutation.writer?.pid ||
      proof.identity.pid !== proof.pid ||
      proof.identity.birth !== proof.birth ||
      (!Number.isInteger(proof.code) && !proof.signal)
    )
      fail('Uncertain in-flight policy mutation; retain resources');
  }
  try {
    const current = processIdentity(await io.read(`/proc/${writer.pid}/stat`));
    if (current.birth === writer.birth)
      fail('Prior managed writer remains live; retain resources');
    if (!/^\d+$/.test(current.birth)) fail('Unknown managed writer state');
  } catch (error) {
    try {
      await io.lstat(`/proc/${writer.pid}`);
    } catch (gone) {
      if (gone?.code === 'ENOENT') return;
      throw gone;
    }
    throw error;
  }
}
async function mutatePolicy(io, receipt, save, operation) {
  // Persist uncertainty BEFORE any child can read or apply the policy. Failure
  // to persist its actual terminal proof keeps independent cleanup blocked.
  receipt.mutation = {
    operation,
    state: 'pending',
    writer: receipt.writer,
    child: null,
  };
  await save();
  const proof = await io.parser(operation, async (child) => {
    receipt.mutation.child = child;
    await save();
  });
  if (
    !proof?.spawned ||
    !proof.closed ||
    proof.timedOut ||
    !Number.isSafeInteger(proof.pid) ||
    !/^\d+$/.test(proof.birth ?? '') ||
    !same(proof.identity, receipt.mutation.child)
  )
    fail('Policy command termination unproved; retain resources');
  const terminal = Object.fromEntries(
    [
      'spawned',
      'closed',
      'timedOut',
      'pid',
      'birth',
      'identity',
      'code',
      'signal',
    ].map((key) => [key, proof[key]]),
  );
  receipt.mutation = { ...receipt.mutation, state: 'closed', proof: terminal };
  await save();
  if (proof.code !== 0 || proof.signal)
    fail(
      `App-specific parser ${operation} failed: ${proof.stderr.slice(0, 1000)}`,
    );
}

async function parentIdentity(io, request) {
  const value = processIdentity(
    await io.read(`/proc/${request.parent.pid}/stat`),
  );
  if (
    value.birth !== request.parent.birth ||
    (await io.lstat(`/proc/${request.parent.pid}`)).uid !== request.uid
  )
    fail('Managed audit parent changed');
}
async function fileResource(io, path, mode) {
  const before = await protectedPath(io, path, false, mode);
  const sha256 = await io.hash(path);
  const after = await protectedPath(io, path, false, mode);
  if (!same(before, after)) fail('Managed file changed during hashing');
  return { path, kind: 'file', mode, identity: after, sha256 };
}
async function receiptState(io, request) {
  await parents(io);
  const self = await protectedPath(io, managedPaths.receipt, false, 0o600);
  const text = await io.read(managedPaths.receipt);
  const receipt = JSON.parse(text);
  if (
    receipt.schema !== 1 ||
    receipt.token !== request.token ||
    receipt.run !== request.run ||
    receipt.attempt !== request.attempt ||
    receipt.uid !== request.uid ||
    !same(receipt.parent, request.parent) ||
    receipt.source.path !== request.source ||
    receipt.source.sha256 !== request.sha256 ||
    receipt.profile.name !== managedProfile ||
    receipt.profile.content !== managedPolicy ||
    receipt.profile.sha256 !== digest(managedPolicy) ||
    !same(identity(self, true), receipt.self) ||
    !Array.isArray(receipt.resources) ||
    receipt.resources.length > 3 ||
    !same(receipt.parents, await parents(io))
  )
    fail('Managed receipt ownership/content mismatch');
  if (
    !same(receipt.expected, {
      executableSha256: request.executableSha256,
      appAsarSha256: request.appAsarSha256,
      helperSha256: request.helperSha256,
      helperMode: request.helperMode,
    })
  )
    fail('Receipt payload expectations changed');
  const allowed = [
    managedPaths.directory,
    managedPaths.original,
    managedPaths.policy,
  ];
  if (
    new Set(receipt.resources.map((item) => item.path)).size !==
      receipt.resources.length ||
    receipt.resources.some((item) => !allowed.includes(item.path))
  )
    fail('Unknown receipt resource');
  if (!same(receipt.global, await globalState(io)))
    fail('Global namespace policy changed');
  for (const item of receipt.resources) {
    if (item.kind === 'directory') {
      if (
        item.path !== managedPaths.directory ||
        !same(item.identity, await protectedPath(io, item.path, true, 0o755))
      )
        fail('Managed directory identity changed');
      const expected = receipt.resources
        .filter((r) => dirname(r.path) === item.path)
        .map((r) => basename(r.path))
        .sort();
      if (!same((await io.list(item.path)).sort(), expected))
        fail('Unowned installation directory entry');
    } else {
      if (
        item.kind !== 'file' ||
        ![managedPaths.original, managedPaths.policy].includes(item.path) ||
        item.mode !== (item.path === managedPaths.original ? 0o555 : 0o444) ||
        !same(item, await fileResource(io, item.path, item.mode))
      )
        fail('Managed resource identity/content changed');
    }
  }
  for (const path of allowed)
    if (!receipt.resources.some((item) => item.path === path))
      await absent(io, path);
  return { receipt, receiptSha256: digest(text) };
}
export async function noManagedOccupants(io) {
  const pids = (await io.list('/proc')).filter((value) => /^\d+$/.test(value));
  if (pids.length > 4096) fail('Process inventory exceeds cleanup bound');
  let threads = 0;
  for (const pid of pids) {
    const path = `/proc/${pid}`;
    try {
      const before = processIdentity(await io.read(`${path}/stat`));
      let executable;
      try {
        executable = await io.link(`${path}/exe`);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (
        executable === managedPaths.original ||
        executable === `${managedPaths.original} (deleted)`
      )
        fail('Managed original remains live');
      const tids = await io.list(`${path}/task`);
      if (
        tids.some((tid) => !/^\d+$/.test(tid)) ||
        (threads += tids.length) > 8192
      )
        fail('Unknown or oversized task inventory');
      for (const tid of tids) {
        const label = (
          await io.read(`${path}/task/${tid}/attr/current`)
        ).trim();
        if (
          !(
            label === 'unconfined' ||
            /^[^\n]+ \((?:enforce|complain|unconfined)\)$/.test(label)
          ) ||
          label.includes(managedProfile)
        )
          fail('Managed label live or unknown');
      }
      if (!same(before, processIdentity(await io.read(`${path}/stat`))))
        fail('Process changed during cleanup inventory');
    } catch (error) {
      // A vanished proc directory establishes absence, unlike an unreadable live task.
      try {
        await io.lstat(path);
      } catch (gone) {
        if (gone?.code === 'ENOENT') continue;
        throw gone;
      }
      throw error;
    }
  }
}
function validateRequest(request, host) {
  if (
    !['prepare', 'check', 'launch', 'cleanup'].includes(request.operation) ||
    request.uid !== host.uid ||
    request.run !== host.run ||
    request.attempt !== host.attempt ||
    !/^[a-f0-9]{32}$/.test(request.token ?? '') ||
    !hex(request.sha256) ||
    !Number.isSafeInteger(request.parent?.pid) ||
    request.parent.pid <= 0 ||
    !/^\d+$/.test(request.parent.birth ?? '') ||
    !hex(request.executableSha256) ||
    !hex(request.appAsarSha256) ||
    !hex(request.helperSha256) ||
    !/^(?:755|4755)$/.test(request.helperMode ?? '')
  )
    fail('Invalid scoped managed request');
}
// The effect interface exercises exact decisions in Node-only controls. Native
// effects are private and reached only through the separately guarded root entry.
export async function managedOperation(request, io, context) {
  const host = managedGuard(context);
  validateRequest(request, host);
  if (
    context.osRelease?.ID !== 'ubuntu' ||
    context.osRelease?.VERSION_ID !== '24.04'
  )
    fail('Managed installation requires actual Ubuntu 24.04');
  if (
    (await io.canonical(context.env.GITHUB_WORKSPACE)) !==
      context.env.GITHUB_WORKSPACE ||
    dirname(request.source) !== join(context.env.GITHUB_WORKSPACE, 'release') ||
    !/^Canopy-[a-zA-Z0-9.+-]+-linux-x86_64\.AppImage$/.test(
      basename(request.source),
    )
  )
    fail('Source outside hosted release artifacts');
  await parentIdentity(io, request);
  if (request.operation === 'prepare') {
    const pins = await parents(io);
    for (const path of Object.values(managedPaths)) await absent(io, path);
    if (await loadedProfile(io)) fail('Existing loaded managed profile');
    const sourceBefore = await io.lstat(request.source);
    if (
      sourceBefore.isSymbolicLink() ||
      !sourceBefore.isFile() ||
      sourceBefore.uid !== request.uid ||
      sourceBefore.nlink !== 1 ||
      sourceBefore.mode & 0o6022 ||
      !(sourceBefore.mode & 0o111) ||
      (await io.canonical(request.source)) !== request.source ||
      (await io.hash(request.source)) !== request.sha256 ||
      !same(identity(sourceBefore), identity(await io.lstat(request.source)))
    )
      fail('Original source provenance changed');
    const receipt = {
      schema: 1,
      token: request.token,
      ...host,
      parent: request.parent,
      source: {
        path: request.source,
        sha256: request.sha256,
        identity: identity(sourceBefore),
      },
      expected: {
        executableSha256: request.executableSha256,
        appAsarSha256: request.appAsarSha256,
        helperSha256: request.helperSha256,
        helperMode: request.helperMode,
      },
      profile: {
        name: managedProfile,
        content: managedPolicy,
        sha256: digest(managedPolicy),
      },
      parents: pins,
      global: await globalState(io),
      resources: [],
      loaded: null,
      loadAttempted: false,
      writer: await io.writer(),
      mutation: null,
    };
    const save = () => io.receipt(JSON.stringify(receipt), receipt.self);
    try {
      await io.create(
        managedPaths.receipt,
        () => JSON.stringify(receipt),
        0o600,
        async (meta) => {
          receipt.self = identity(meta, true);
        },
      );
      await io.mkdir(managedPaths.directory, 0o755);
      receipt.resources.push({
        path: managedPaths.directory,
        kind: 'directory',
        identity: await protectedPath(io, managedPaths.directory, true, 0o755),
      });
      await save();
      const record = async (path, mode, meta) => {
        receipt.resources.push({
          path,
          kind: 'file',
          mode,
          identity: identity(meta),
          sha256: null,
        });
        await save();
      };
      await io.copy(request.source, managedPaths.original, 0o555, (meta) =>
        record(managedPaths.original, 0o555, meta),
      );
      receipt.resources[1] = await fileResource(
        io,
        managedPaths.original,
        0o555,
      );
      if (
        receipt.resources[1].sha256 !== request.sha256 ||
        !same(identity(sourceBefore), identity(await io.lstat(request.source)))
      )
        fail('Original copied bytes/identity changed');
      receipt.original = await originalArtifact(
        {
          artifact: managedPaths.original,
          artifactSha256: request.sha256,
          uid: request.uid,
        },
        io,
      );
      await save();
      await io.create(
        managedPaths.policy,
        () => managedPolicy,
        0o444,
        (meta) => record(managedPaths.policy, 0o444, meta),
      );
      receipt.resources[2] = await fileResource(io, managedPaths.policy, 0o444);
      if (receipt.resources[2].sha256 !== digest(managedPolicy))
        fail('Policy bytes changed');
      receipt.loadAttempted = true;
      await save();
      await mutatePolicy(io, receipt, save, 'add');
      receipt.loaded = await loadedProfile(io);
      if (!receipt.loaded) fail('Managed profile load not verified');
      await save();
      return await validateInstallation(io, request);
    } catch (primary) {
      // Capture only files whose exclusive creation was recorded. Unknown or
      // failed receipt repair retains resources for disposable-runner evidence.
      try {
        for (let index = 0; index < receipt.resources.length; index++) {
          const item = receipt.resources[index];
          if (item.kind === 'file' && item.sha256 === null) {
            const now = await fileResource(io, item.path, item.mode);
            if (
              !same(identity(item.identity, true), identity(now.identity, true))
            )
              fail('Partial resource inode changed');
            receipt.resources[index] = now;
          }
        }
        if (receipt.self) await save();
      } catch (secondary) {
        console.error(
          'Managed partial receipt unavailable:',
          String(secondary),
        );
      }
      throw primary;
    }
  }
  if (request.operation === 'cleanup') {
    try {
      await io.lstat(managedPaths.receipt);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      for (const path of [managedPaths.directory, managedPaths.policy])
        await absent(io, path);
      if (await loadedProfile(io))
        fail('Profile without owned receipt retained');
      return { empty: true };
    }
    const { receipt } = await receiptState(io, request);
    await previousWriterAbsent(io, receipt);
    const loaded = await loadedProfile(io);
    if (loaded && (!receipt.loaded || !same(loaded, receipt.loaded)))
      fail('Unknown loaded policy ownership; retain resources');
    // Finish slow file/hash validation before the required live-task inventory.
    await receiptState(io, request);
    if (!same(await loadedProfile(io), loaded))
      fail('Policy changed before absence check');
    await noManagedOccupants(io);
    await parentIdentity(io, request);
    receipt.writer = await io.writer();
    const save = () => io.receipt(JSON.stringify(receipt), receipt.self);
    await save();
    if (loaded) {
      await mutatePolicy(io, receipt, save, 'remove');
      if (await loadedProfile(io)) fail('Managed profile remains loaded');
    }
    for (const item of [...receipt.resources].reverse())
      await io.remove(item.path, item.kind);
    if (!same(receipt.global, await globalState(io)))
      fail('Global policy changed during cleanup');
    await io.remove(managedPaths.receipt, 'file');
    return { removed: true };
  }
  const installed = await validateInstallation(io, request);
  await previousWriterAbsent(io, installed.receipt);
  if (request.operation === 'check') return installed;
  const launch = await liveLaunch(io, request);
  if (
    !same(installed.receipt.global, await globalState(io)) ||
    !same(installed.receipt.loaded, await loadedProfile(io))
  )
    fail('Managed policy changed during live verification');
  for (const [pid, birth] of [
    [launch.rootPid, launch.rootBirth],
    [launch.sample.pid, launch.sample.birth],
    [request.launch.rendererPid, request.launch.rendererBirth],
  ]) {
    if (
      processIdentity(await io.read(`/proc/${pid}/stat`)).birth !== birth ||
      (await io.lstat(`/proc/${pid}`)).uid !== request.uid ||
      (await io.read(`/proc/${pid}/attr/current`)).trim() !==
        `${managedProfile} (unconfined)`
    )
      fail('Managed process changed after policy verification');
  }
  return { ...installed, launch };
}
async function validateInstallation(io, request) {
  const state = await receiptState(io, request);
  if (
    state.receipt.resources.length !== 3 ||
    state.receipt.resources[1].sha256 !== request.sha256 ||
    state.receipt.resources[2].sha256 !== digest(managedPolicy) ||
    !state.receipt.loaded ||
    !same(state.receipt.loaded, await loadedProfile(io))
  )
    fail('Incomplete or changed managed installation');
  if (
    !same(
      state.receipt.original,
      await originalArtifact(
        {
          artifact: managedPaths.original,
          artifactSha256: request.sha256,
          uid: request.uid,
        },
        io,
      ),
    )
  )
    fail('Managed original snapshot changed');
  await parentIdentity(io, request);
  return state;
}
async function liveLaunch(io, request) {
  const { pid, mainBirth, rootPid, rootBirth, rendererPid, rendererBirth } =
    request.launch ?? {};
  if (
    [pid, rootPid, rendererPid].some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    ) ||
    !/^\d+$/.test(rootBirth ?? '') ||
    !/^\d+$/.test(mainBirth ?? '') ||
    !/^\d+$/.test(rendererBirth ?? '') ||
    rendererPid === pid
  )
    fail('Invalid actual launch identity');
  const root = processIdentity(await io.read(`/proc/${rootPid}/stat`));
  if (
    root.parent !== request.parent.pid ||
    root.birth !== rootBirth ||
    (await io.lstat(`/proc/${rootPid}`)).uid !== request.uid ||
    (await io.read(`/proc/${rootPid}/attr/current`)).trim() !==
      `${managedProfile} (unconfined)`
  )
    fail('Actual launcher identity/label mismatch');
  const main = processIdentity(await io.read(`/proc/${pid}/stat`));
  if (main.birth !== mainBirth || (pid !== rootPid && main.parent !== rootPid))
    fail('Mounted main is outside actual launcher');
  const sample = await mountedEvidence(
    pid,
    main,
    {
      uid: request.uid,
      executableSha256: request.executableSha256,
      appAsarSha256: request.appAsarSha256,
      helperSha256: request.helperSha256,
    },
    io,
  );
  if (
    sample.apparmorContext !== `${managedProfile} (unconfined)` ||
    sample.mount.source !== managedPaths.original ||
    sample.sandboxHelper.uid !== 0 ||
    sample.sandboxHelper.gid !== 0 ||
    sample.sandboxHelper.mode !== request.helperMode
  )
    fail('Mounted managed identity/helper/label mismatch');
  let ancestor = rendererPid;
  const seen = new Set();
  for (let depth = 0; ancestor !== pid && depth < 16; depth++) {
    if (
      seen.has(ancestor) ||
      (await io.lstat(`/proc/${ancestor}`)).uid !== request.uid
    )
      fail('Renderer ancestry unavailable');
    seen.add(ancestor);
    ancestor = processIdentity(await io.read(`/proc/${ancestor}/stat`)).parent;
  }
  if (
    ancestor !== pid ||
    (await io.read(`/proc/${rendererPid}/attr/current`)).trim() !==
      `${managedProfile} (unconfined)`
  )
    fail('Renderer effective profile mismatch');
  const rendererIdentity = processIdentity(
    await io.read(`/proc/${rendererPid}/stat`),
  );
  if (rendererIdentity.birth !== rendererBirth) fail('Renderer birth changed');
  const renderer = await io.read(`/proc/${rendererPid}/status`);
  if (!/^NoNewPrivs:\s+1$/m.test(renderer) || !/^Seccomp:\s+2$/m.test(renderer))
    fail('Managed renderer sandbox unavailable');
  for (const [checkedPid, expected] of [
    [rootPid, root],
    [pid, main],
    [rendererPid, rendererIdentity],
  ]) {
    if (
      !same(
        expected,
        processIdentity(await io.read(`/proc/${checkedPid}/stat`)),
      ) ||
      (await io.lstat(`/proc/${checkedPid}`)).uid !== request.uid ||
      (await io.read(`/proc/${checkedPid}/attr/current`)).trim() !==
        `${managedProfile} (unconfined)`
    )
      fail('Managed process/label changed during verification');
  }
  await parentIdentity(io, request);
  if (!same(root, processIdentity(await io.read(`/proc/${rootPid}/stat`))))
    fail('Launcher changed during verification');
  return { rootPid, rootBirth, sample, rendererPid, profile: managedProfile };
}
export function managedChild(app) {
  const child = app.process();
  if (
    !(child instanceof ChildProcess) ||
    !Number.isSafeInteger(child.pid) ||
    child.pid <= 0 ||
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.spawnfile !== managedPaths.original ||
    !same(child.spawnargs, [
      managedPaths.original,
      '--inspect=0',
      '--remote-debugging-port=0',
    ])
  )
    fail('Actual Playwright launch object mismatch');
  return child;
}
export function acceptManagedObservation(report, installed, actual, parent) {
  const { receipt, receiptSha256, launch } = installed;
  const sample = launch?.sample;
  const expected = receipt?.expected;
  if (
    receipt?.schema !== 1 ||
    receipt.profile?.name !== managedProfile ||
    receipt.profile.content !== managedPolicy ||
    receipt.profile.sha256 !== digest(managedPolicy) ||
    receipt.original?.managed !== true ||
    receipt.original.hash !== receipt.source?.sha256 ||
    receipt.original.metadata.uid !== 0 ||
    (receipt.original.metadata.mode & 0o7777) !== 0o555 ||
    !sample ||
    sample.uid !== receipt.uid ||
    sample.uid <= 0 ||
    sample.birth !== actual.mainBirth ||
    sample.apparmorContext !== `${managedProfile} (unconfined)` ||
    sample.executableSha256 !== expected?.executableSha256 ||
    sample.appAsarSha256 !== expected?.appAsarSha256 ||
    sample.sandboxHelper?.sha256 !== expected?.helperSha256 ||
    sample.sandboxHelper.uid !== 0 ||
    sample.sandboxHelper.gid !== 0 ||
    sample.sandboxHelper.mode !== expected?.helperMode ||
    sample.mount?.source !== managedPaths.original ||
    !sample.mount.filesystem.startsWith('fuse') ||
    !/^\/tmp\/\.mount_Canopy[a-zA-Z0-9]+$/.test(sample.mount.path) ||
    sample.executable !== join(sample.mount.path, 'canopy') ||
    sample.sandboxHelper.path !== join(sample.mount.path, 'chrome-sandbox')
  )
    fail('Managed receipt/payload/profile observation mismatch');
  if (
    !hex(receiptSha256) ||
    report.completed !== true ||
    report.status !== 'observed' ||
    !Number.isFinite(report.finalizedAt) ||
    report.finalizedAt > Date.now() ||
    report.artifact !== managedPaths.original ||
    report.parent !== parent.pid ||
    report.parentBirth !== parent.birth ||
    report.managedReceipt !== receipt.token ||
    !same(report.original, {
      managed: true,
      hash: receipt.source.sha256,
      parents: receipt.original.parents,
      metadata: receipt.original.metadata,
    }) ||
    !['retained-spawn', 'native-original'].includes(report.authority?.kind) ||
    report.authority.pid !== actual.rootPid ||
    report.authority.birth !== actual.rootBirth ||
    report.authority.originalSha256 !== receipt.source.sha256 ||
    report.authority.managed !== true ||
    launch.rootPid !== actual.rootPid ||
    launch.rootBirth !== actual.rootBirth ||
    launch.sample.pid !== actual.pid ||
    !report.samples.some((sample) => same(sample, launch.sample))
  )
    fail('Completed bound managed observation required');
  return {
    receiptSha256,
    profile: managedProfile,
    rootPid: actual.rootPid,
    rootBirth: actual.rootBirth,
    finalizedAt: report.finalizedAt,
    sample: launch.sample,
  };
}
export async function withManagedAppImage(
  config,
  run,
  {
    context,
    invoke,
    parent: injectedParent,
    signals = process,
    secondary = (error) =>
      console.error('Managed cleanup also failed:', String(error)),
  } = {},
) {
  context ??= await managedHostedContext();
  const host = managedGuard(context);
  const parent = injectedParent ?? {
    pid: process.pid,
    ...processIdentity(await boundedRead('/proc/self/stat')),
  };
  const auditParent = { pid: parent.pid, birth: parent.birth };
  const request = {
    ...config,
    ...host,
    parent: auditParent,
    token: randomBytes(16).toString('hex'),
  };
  invoke ??= rootInvoke;
  let cancelled,
    cancelRun,
    uncertain = false,
    activeRequests = 0,
    runInFlight = false,
    finished = false;
  const listeners = ['SIGINT', 'SIGTERM'].map((signal) => {
    const listener = () => {
      cancelled ??= new Error(`Managed AppImage cancelled by ${signal}`);
      cancelRun?.(cancelled);
    };
    signals.on(signal, listener);
    return [signal, listener];
  });
  const checkCancellation = () => {
    if (cancelled) throw cancelled;
  };
  const call = async (operation, launch) => {
    if (operation !== 'cleanup') {
      checkCancellation();
      if (uncertain || finished)
        fail('Managed verification stopped after uncertainty');
    }
    activeRequests++;
    try {
      const value = await invoke({
        ...request,
        operation,
        ...(launch ? { launch } : {}),
      });
      if (operation !== 'cleanup') {
        checkCancellation();
        if (uncertain || finished)
          fail('Managed verification stopped after uncertainty');
      }
      return value;
    } catch (error) {
      if (error?.managedUncertain) uncertain = true;
      throw error;
    } finally {
      activeRequests--;
    }
  };
  let failed = false,
    primary,
    result;
  try {
    try {
      const installed = await call('prepare');
      checkCancellation();
      const closing = new WeakMap();
      const session = {
        installed,
        parent: auditParent,
        request,
        check: () => call('check'),
        verify: (launch) => call('launch', launch),
        refuseCleanup: () => {
          uncertain = true;
        },
        close: async (app) => {
          try {
            if (!closing.has(app)) closing.set(app, boundedManagedClose(app));
            return await closing.get(app);
          } catch (error) {
            uncertain = true;
            throw error;
          }
        },
      };
      const cancellation = new Promise((_, reject) => {
        cancelRun = reject;
      });
      runInFlight = true;
      const running = Promise.resolve()
        .then(() => {
          checkCancellation();
          return run(managedPaths.original, session);
        })
        .finally(() => {
          runInFlight = false;
        });
      result = await Promise.race([running, cancellation]);
      checkCancellation();
    } catch (error) {
      failed = true;
      primary = error;
      if (error?.managedUncertain) uncertain = true;
    }
    // No deletion while an implementation-owned helper or callback may still
    // mutate/launch/close. Rejection is finite; it is not process-death proof.
    if (uncertain || activeRequests || runInFlight) {
      const refusal = Object.assign(
        new Error('Managed cleanup refused: operation/closure still uncertain'),
        { managedUncertain: true },
      );
      if (!failed) throw refusal;
      try {
        secondary(refusal);
      } catch {
        /* Preserve even falsy primary. */
      }
    } else {
      try {
        await call('cleanup');
      } catch (error) {
        if (!failed) throw error;
        try {
          secondary(error);
        } catch {
          /* Preserve raw primary. */
        }
      }
    }
    if (failed) throw primary;
    checkCancellation();
    return result;
  } finally {
    finished = true;
    cancelRun = undefined;
    for (const [signal, listener] of listeners)
      signals.removeListener(signal, listener);
  }
}
export function boundedManagedClose(app, { deadline = 5000 } = {}) {
  const expires = performance.now() + deadline;
  return new Promise((resolve, reject) => {
    const late = () =>
      Object.assign(new Error('Managed application closure unproved'), {
        managedUncertain: true,
      });
    const timer = setTimeout(
      () => reject(late()),
      Math.max(0, expires - performance.now()),
    );
    Promise.resolve()
      .then(() => {
        if (!Number.isFinite(expires) || performance.now() >= expires)
          throw late();
        return app.close();
      })
      .then((value) => {
        if (performance.now() >= expires) reject(late());
        else resolve(value);
      }, reject)
      .finally(() => clearTimeout(timer));
  });
}
// Track only the actual returned child object. A deadline is failure even if
// exit/pipe closure arrives later. Destroy owned pipes so descendants cannot
// keep this promise pending; this neither kills nor proves descendant absence.
export function waitManagedChild(
  child,
  {
    deadline,
    expires = performance.now() + deadline,
    onSpawn,
    killOwned = false,
    input,
  },
) {
  return new Promise((resolve, reject) => {
    let settled = false,
      spawned = false,
      exited = false,
      closed = false;
    let identity,
      ready = false,
      output = '',
      stderr = '',
      code,
      signal;
    const uncertain = (message) =>
      Object.assign(new Error(message), { managedUncertain: true });
    const detach = () => {
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        try {
          stream?.destroy();
        } catch {
          /* Still uncertain; keep child observers. */
        }
      }
    };
    const refuse = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detach();
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      if (!Number.isFinite(expires) || performance.now() >= expires)
        return refuse(
          uncertain('Managed command elapsed deadline/closure unproved'),
        );
      if (!closed || !ready) return;
      if (
        !spawned ||
        !exited ||
        !Number.isSafeInteger(child.pid) ||
        identity?.pid !== child.pid ||
        !/^\d+$/.test(identity.birth ?? '')
      )
        return refuse(uncertain('Managed command lifecycle unproved'));
      settled = true;
      clearTimeout(timer);
      resolve({
        spawned,
        closed,
        timedOut: false,
        pid: child.pid,
        birth: identity.birth,
        identity,
        code,
        signal,
        output,
        stderr,
      });
    };
    const timer = setTimeout(
      () => {
        // Native root parser only: the actual child handle, never an arbitrary
        // PID/group or an ordinary-user attempt to kill a root helper.
        if (
          killOwned &&
          ready &&
          !exited &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* Uncertain; never proof. */
          }
        }
        refuse(uncertain('Managed command deadline/closure unproved'));
      },
      Math.max(0, expires - performance.now()),
    );
    for (const [stream, kind] of [
      [child.stdout, 'out'],
      [child.stderr, 'err'],
    ]) {
      stream?.on('data', (chunk) => {
        if (settled) return;
        if (performance.now() >= expires)
          return refuse(uncertain('Managed command elapsed deadline'));
        if (
          Buffer.byteLength(output) + Buffer.byteLength(stderr) + chunk.length >
          65536
        )
          return refuse(uncertain('Managed command output exceeds bound'));
        if (kind === 'out') output += chunk;
        else stderr += chunk;
      });
      stream?.on('error', () =>
        refuse(uncertain('Managed command stream failed')),
      );
    }
    child.stdin?.on('error', () =>
      refuse(uncertain('Managed request stream failed')),
    );
    child.once('spawn', () => {
      spawned = true;
      Promise.resolve()
        .then(() => {
          if (settled || performance.now() >= expires)
            throw uncertain('Managed command elapsed deadline');
          return onSpawn(child);
        })
        .then(
          (value) => {
            if (settled) return;
            identity = value;
            ready = true;
            finish();
          },
          () => refuse(uncertain('Managed successful-spawn birth unproved')),
        );
    });
    child.once('error', () =>
      refuse(uncertain('Managed child error; closure unknown')),
    );
    child.once('exit', (value, sig) => {
      exited = true;
      code = value;
      signal = sig;
    });
    child.once('close', () => {
      closed = true;
      finish();
    });
    if (input) {
      try {
        const text = input();
        if (typeof text !== 'string' || Buffer.byteLength(text) > 16384)
          throw new Error('Managed request exceeds transport bound');
        if (!Number.isFinite(expires) || performance.now() >= expires)
          throw new Error('Managed request elapsed deadline');
        child.stdin.end(text, (error) => {
          if (error) refuse(uncertain('Managed request write callback failed'));
        });
      } catch {
        refuse(uncertain('Managed request serialization/write failed'));
      }
    }
  });
}
export function validManagedResponse(response, request, onRefusal = () => {}) {
  const refuse = (reason) => {
    onRefusal(reason);
    return false;
  };
  const object = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const keys = (value, expected) =>
    object(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
  const birth = (value) => typeof value === 'string' && /^\d+$/.test(value);
  const pid = (value) => Number.isSafeInteger(value) && value > 0;
  const hash = (value) => typeof value === 'string' && hex(value);
  const fileIdentity = (value, fields, type, uid, mode) => {
    if (!keys(value, fields)) return refuse('file-identity.keys');
    for (const key of fields) {
      if (typeof value[key] !== 'number' || !Number.isFinite(value[key]))
        return refuse(`file-identity.${key}.finite`);
      if (
        !['mtimeMs', 'ctimeMs'].includes(key) &&
        (!Number.isSafeInteger(value[key]) || value[key] < 0)
      )
        return refuse(`file-identity.${key}.integer`);
    }
    if (value.ino <= 0) return refuse('file-identity.ino.positive');
    if ((value.mode & 0o170000) !== type)
      return refuse('file-identity.mode.type');
    if (value.uid !== uid) return refuse('file-identity.uid');
    if (mode !== undefined && (value.mode & 0o7777) !== mode)
      return refuse('file-identity.mode.permissions');
    return true;
  };
  const stable = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink'];
  const directory = stable.filter((key) => key !== 'nlink');
  const full = [...stable, 'size', 'mtimeMs', 'ctimeMs'];
  const originalFields = full.filter((key) => key !== 'nlink');
  const protectedDirectory = (value) =>
    fileIdentity(value, directory, 0o40000, 0) &&
    value.gid === 0 &&
    !(value.mode & 0o6022);
  const protectedFile = (value, mode) =>
    fileIdentity(value, full, 0o100000, 0, mode) &&
    value.gid === 0 &&
    value.nlink === 1;
  const writer = (value) =>
    keys(value, ['pid', 'birth', 'uid']) &&
    pid(value.pid) &&
    birth(value.birth) &&
    value.uid === 0;
  if (!object(response) || typeof response.ok !== 'boolean')
    return refuse('envelope');
  if (!response.ok)
    return (
      (keys(response, ['ok', 'error', 'uncertain']) &&
        typeof response.error === 'string' &&
        response.error.length <= 4096 &&
        typeof response.uncertain === 'boolean') ||
      refuse('failure-envelope')
    );
  if (!keys(response, ['ok', 'value']) || !object(response.value))
    return refuse('success-envelope');
  const value = response.value;
  if (request.operation === 'cleanup')
    return (
      (keys(value, ['removed']) && value.removed === true) ||
      (keys(value, ['empty']) && value.empty === true) ||
      refuse('cleanup-envelope')
    );
  if (
    !['prepare', 'check', 'launch'].includes(request.operation) ||
    !hash(value.receiptSha256) ||
    !object(value.receipt)
  )
    return refuse('receipt-envelope');
  const r = value.receipt;
  if (
    !keys(r, [
      'schema',
      'token',
      'run',
      'attempt',
      'uid',
      'parent',
      'source',
      'expected',
      'profile',
      'parents',
      'global',
      'resources',
      'loaded',
      'loadAttempted',
      'writer',
      'mutation',
      'self',
      'original',
    ]) ||
    r.schema !== 1 ||
    typeof r.token !== 'string' ||
    r.token !== request.token ||
    typeof r.run !== 'string' ||
    r.run !== request.run ||
    typeof r.attempt !== 'string' ||
    r.attempt !== request.attempt ||
    !pid(r.uid) ||
    r.uid !== request.uid ||
    !keys(r.parent, ['pid', 'birth']) ||
    !pid(r.parent.pid) ||
    !birth(r.parent.birth) ||
    !same(r.parent, request.parent) ||
    !fileIdentity(r.self, stable, 0o100000, 0, 0o600) ||
    r.self.gid !== 0 ||
    r.self.nlink !== 1 ||
    !keys(r.source, ['path', 'sha256', 'identity']) ||
    typeof r.source.path !== 'string' ||
    r.source.path !== request.source ||
    !hash(r.source.sha256) ||
    r.source.sha256 !== request.sha256 ||
    !fileIdentity(r.source.identity, full, 0o100000, request.uid) ||
    r.source.identity.nlink !== 1 ||
    r.source.identity.mode & 0o6022 ||
    !(r.source.identity.mode & 0o111) ||
    !keys(r.expected, [
      'executableSha256',
      'appAsarSha256',
      'helperSha256',
      'helperMode',
    ]) ||
    !['executableSha256', 'appAsarSha256', 'helperSha256'].every(
      (key) => hash(r.expected[key]) && r.expected[key] === request[key],
    ) ||
    typeof r.expected.helperMode !== 'string' ||
    !/^[0-7]{3,4}$/.test(r.expected.helperMode) ||
    r.expected.helperMode !== request.helperMode ||
    !keys(r.profile, ['name', 'content', 'sha256']) ||
    r.profile.name !== managedProfile ||
    r.profile.content !== managedPolicy ||
    r.profile.sha256 !== digest(managedPolicy) ||
    !Array.isArray(r.parents) ||
    r.parents.length !== 4 ||
    !['/', '/opt', '/etc', '/etc/apparmor.d'].every(
      (path, index) =>
        keys(r.parents[index], ['path', 'identity']) &&
        r.parents[index].path === path &&
        protectedDirectory(r.parents[index].identity),
    ) ||
    !keys(r.global, globalFiles) ||
    !globalFiles.every(
      (path, index) =>
        typeof r.global[path] === 'string' &&
        r.global[path].length <= 256 &&
        r.global[path].trim() === ['Y', '1', '1'][index],
    ) ||
    !Array.isArray(r.resources) ||
    r.resources.length !== 3 ||
    r.loadAttempted !== true ||
    !writer(r.writer)
  )
    return refuse('receipt-header');
  const [dir, original, policy] = r.resources;
  if (
    !keys(dir, ['path', 'kind', 'identity']) ||
    dir.path !== managedPaths.directory ||
    dir.kind !== 'directory' ||
    !protectedDirectory(dir.identity) ||
    (dir.identity.mode & 0o7777) !== 0o755 ||
    ![
      [original, managedPaths.original, 0o555, request.sha256],
      [policy, managedPaths.policy, 0o444, digest(managedPolicy)],
    ].every(
      ([item, path, mode, sha]) =>
        keys(item, ['path', 'kind', 'mode', 'identity', 'sha256']) &&
        item.path === path &&
        item.kind === 'file' &&
        item.mode === mode &&
        protectedFile(item.identity, mode) &&
        hash(item.sha256) &&
        item.sha256 === sha,
    )
  )
    return refuse('resources');
  const o = r.original;
  if (
    !keys(o, ['managed', 'hash', 'parents', 'metadata']) ||
    o.managed !== true ||
    o.hash !== request.sha256 ||
    !fileIdentity(o.metadata, originalFields, 0o100000, 0, 0o555) ||
    o.metadata.gid !== 0 ||
    !originalFields.every(
      (key) => o.metadata[key] === original.identity[key],
    ) ||
    !Array.isArray(o.parents) ||
    o.parents.length !== 3 ||
    !['/', '/opt', managedPaths.directory].every((path, index) => {
      const parent = o.parents[index],
        expected = index < 2 ? r.parents[index].identity : dir.identity;
      return (
        keys(parent, ['path', ...directory]) &&
        parent.path === path &&
        directory.every((key) => parent[key] === expected[key])
      );
    })
  )
    return refuse('original');
  const loaded = r.loaded;
  if (
    !keys(loaded, ['path', 'attach', 'mode', 'sha256', 'identity']) ||
    typeof loaded.path !== 'string' ||
    !/^\/sys\/kernel\/security\/apparmor\/policy\/profiles\/[a-zA-Z0-9._-]+$/.test(
      loaded.path,
    ) ||
    loaded.attach !== managedPaths.original ||
    loaded.mode !== 'unconfined' ||
    !hash(loaded.sha256) ||
    !fileIdentity(loaded.identity, stable, 0o40000, 0) ||
    loaded.identity.gid !== 0 ||
    loaded.identity.nlink < 1
  )
    return refuse('loaded-profile');
  const m = r.mutation,
    child = m?.child,
    proof = m?.proof;
  if (
    !keys(m, ['operation', 'state', 'writer', 'child', 'proof']) ||
    m.operation !== 'add' ||
    m.state !== 'closed' ||
    !writer(m.writer) ||
    !same(m.writer, r.writer) ||
    !keys(child, ['pid', 'birth', 'uid', 'parent']) ||
    !pid(child.pid) ||
    !birth(child.birth) ||
    child.uid !== 0 ||
    child.parent !== m.writer.pid ||
    child.pid === m.writer.pid ||
    !keys(proof, [
      'spawned',
      'closed',
      'timedOut',
      'pid',
      'birth',
      'identity',
      'code',
      'signal',
    ]) ||
    proof.spawned !== true ||
    proof.closed !== true ||
    proof.timedOut !== false ||
    proof.pid !== child.pid ||
    !birth(proof.birth) ||
    proof.birth !== child.birth ||
    !same(proof.identity, child) ||
    proof.code !== 0 ||
    proof.signal !== null
  )
    return refuse('parser-mutation');
  // The helper writes and hashes JSON.stringify(receipt), without a newline.
  if (value.receiptSha256 !== digest(JSON.stringify(r)))
    return refuse('receipt-hash');
  if (request.operation !== 'launch')
    return (
      keys(value, ['receipt', 'receiptSha256']) ||
      refuse('installation-envelope')
    );
  const launch = value.launch,
    expected = request.launch,
    sample = launch?.sample;
  if (
    !keys(value, ['receipt', 'receiptSha256', 'launch']) ||
    !keys(expected, [
      'pid',
      'mainBirth',
      'rootPid',
      'rootBirth',
      'rendererPid',
      'rendererBirth',
    ]) ||
    ![expected.pid, expected.rootPid, expected.rendererPid].every(pid) ||
    ![expected.mainBirth, expected.rootBirth, expected.rendererBirth].every(
      birth,
    ) ||
    expected.rendererPid === expected.pid ||
    !keys(launch, [
      'rootPid',
      'rootBirth',
      'sample',
      'rendererPid',
      'profile',
    ]) ||
    launch.rootPid !== expected.rootPid ||
    !birth(launch.rootBirth) ||
    launch.rootBirth !== expected.rootBirth ||
    launch.rendererPid !== expected.rendererPid ||
    launch.profile !== managedProfile ||
    !keys(sample, [
      'pid',
      'birth',
      'executable',
      'mount',
      'apparmorContext',
      'uid',
      'executableSha256',
      'appAsarSha256',
      'sandboxHelper',
    ]) ||
    sample.pid !== expected.pid ||
    !birth(sample.birth) ||
    sample.birth !== expected.mainBirth ||
    sample.uid !== request.uid ||
    sample.executableSha256 !== request.executableSha256 ||
    sample.appAsarSha256 !== request.appAsarSha256 ||
    sample.apparmorContext !== `${managedProfile} (unconfined)`
  )
    return refuse('launch');
  const mount = sample.mount,
    helper = sample.sandboxHelper;
  return (
    (keys(mount, ['path', 'options', 'filesystem', 'source', 'superOptions']) &&
      typeof mount.path === 'string' &&
      /^\/tmp\/\.mount_Canopy[a-zA-Z0-9]+$/.test(mount.path) &&
      mount.source === managedPaths.original &&
      typeof mount.filesystem === 'string' &&
      /^fuse(?:\.|$)/.test(mount.filesystem) &&
      typeof mount.options === 'string' &&
      mount.options.length > 0 &&
      mount.options.length <= 4096 &&
      typeof mount.superOptions === 'string' &&
      mount.superOptions.length > 0 &&
      mount.superOptions.length <= 4096 &&
      sample.executable === join(mount.path, 'canopy') &&
      keys(helper, ['sha256', 'path', 'uid', 'gid', 'mode']) &&
      helper.sha256 === request.helperSha256 &&
      helper.path === join(mount.path, 'chrome-sandbox') &&
      helper.uid === 0 &&
      helper.gid === 0 &&
      typeof helper.mode === 'string' &&
      helper.mode === request.helperMode) ||
    refuse('mounted-payload')
  );
}
// This is a bounded observation of the trusted fixed bootstrap, not an
// authenticated helper response. Arbitrary secret recognition is not possible.
export function managedBootstrapObservation(stderr, paths = []) {
  if (typeof stderr !== 'string' || Buffer.byteLength(stderr) > 65536)
    return '';
  let text = stderr
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
      character === '\n' ? '\n' : ' ',
    );
  for (const path of paths)
    if (typeof path === 'string' && path.length)
      text = text.split(path).join('<path>');
  text = text
    .replace(/authorization\s*[:=][^\n]*/gi, 'authorization=<redacted>')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '<url>')
    .replace(/\b[\w.-]+\s*=[^\n]*/g, '<assignment>')
    .replace(
      /\b(?:password|passwd|token|secret|credential|api[_-]?key)\s*:[^\n]*/gi,
      '<sensitive-field>',
    )
    .replace(/(?:[a-z]:[\\/]|\/)[^\s'"<>),;]*/gi, '<path>');
  let bounded = '';
  for (const character of text) {
    if (Buffer.byteLength(bounded) + Buffer.byteLength(character) > 1024) break;
    bounded += character;
  }
  return bounded;
}
export async function recordManagedProtocol(
  path,
  error,
  effects = { mkdir, writeFile },
) {
  let timer;
  try {
    const value = error?.managedProtocol;
    const reasons = [
      'json',
      'empty-response',
      'node-module-error',
      'sudo-authentication',
      'sudo-environment',
      'schema',
      'terminal',
      'deadline',
      'transport',
      'helper-failure',
      'envelope',
      'success-envelope',
      'failure-envelope',
      'cleanup-envelope',
      'receipt-envelope',
      'receipt-header',
      'resources',
      'original',
      'loaded-profile',
      'parser-mutation',
      'receipt-hash',
      'launch',
      'installation-envelope',
      'mounted-payload',
      'file-identity.keys',
      'file-identity.ino.positive',
      'file-identity.mode.type',
      'file-identity.uid',
      'file-identity.mode.permissions',
      ...[
        'dev',
        'ino',
        'uid',
        'gid',
        'mode',
        'nlink',
        'size',
        'mtimeMs',
        'ctimeMs',
      ].flatMap((key) => [
        `file-identity.${key}.finite`,
        `file-identity.${key}.integer`,
      ]),
    ];
    if (
      !value ||
      !['prepare', 'check', 'launch', 'cleanup', 'unknown'].includes(
        value.operation,
      ) ||
      !reasons.includes(value.reason)
    )
      return;
    const bytes = (count) =>
      count === null ||
      (Number.isSafeInteger(count) && count >= 0 && count <= 65536);
    if (
      !bytes(value.outputBytes) ||
      !bytes(value.stderrBytes) ||
      !(value.code === null || Number.isInteger(value.code)) ||
      ![null, 'present'].includes(value.signal)
    )
      return;
    const safe = Object.fromEntries(
      [
        'operation',
        'reason',
        'outputBytes',
        'stderrBytes',
        'code',
        'signal',
      ].map((key) => [key, value[key]]),
    );
    await Promise.race([
      (async () => {
        await effects.mkdir(dirname(path), { recursive: true });
        await effects.writeFile(path, JSON.stringify(safe, null, 2));
        const observation = managedBootstrapObservation(
          error?.managedBootstrap,
        );
        if (observation)
          await effects.writeFile(
            join(dirname(path), 'managed-bootstrap.txt'),
            observation,
          );
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Managed diagnostics deadline')),
          500,
        );
      }),
    ]);
  } catch {
    // Diagnostics cannot replace the primary or change uncertain cleanup state.
  } finally {
    clearTimeout(timer);
  }
}
async function rootInvoke(request) {
  const expires = performance.now() + 12000;
  await managedHostedContext();
  if (performance.now() >= expires)
    throw Object.assign(new Error('Managed helper setup deadline'), {
      managedUncertain: true,
    });
  const child = spawn(
    '/usr/bin/sudo',
    [
      '-n',
      `--preserve-env=${preserved.join(',')}`,
      '--',
      process.execPath,
      ownFile,
      '--managed-appimage-private',
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
        LANG: 'C',
        ...Object.fromEntries(preserved.map((key) => [key, process.env[key]])),
      },
    },
  );
  const pending = waitManagedChild(child, {
    expires,
    input: () => JSON.stringify(request),
    onSpawn: async (actual) => ({
      pid: actual.pid,
      birth: processIdentity(await boundedRead(`/proc/${actual.pid}/stat`))
        .birth,
    }),
  });
  let proof;
  try {
    proof = await pending;
  } catch (error) {
    if (error instanceof Error)
      error.managedProtocol = {
        operation: request.operation,
        reason: 'transport',
        outputBytes: null,
        stderrBytes: null,
        code: null,
        signal: null,
      };
    throw error;
  }
  let response,
    reason = 'json';
  try {
    response = JSON.parse(proof.output);
    reason = 'schema';
    if (
      !validManagedResponse(response, request, (value) => {
        if (reason === 'schema') reason = value;
      })
    )
      throw new Error('Incomplete response');
    reason = 'terminal';
    if (
      proof.signal ||
      ![0, 1].includes(proof.code) ||
      response.ok !== (proof.code === 0)
    )
      throw new Error('Incoherent response');
    reason = 'deadline';
    // Validation and terminal classification consume the same original budget.
    if (performance.now() >= expires)
      throw new Error('Elapsed response deadline');
  } catch {
    // Classify only bounded, empty-response transport diagnostics. A signature
    // is neither a validated helper envelope nor proof of writer termination.
    if (reason === 'json' && proof.output === '') {
      reason = 'empty-response';
      if (
        /^Error \[ERR_MODULE_NOT_FOUND\]: /m.test(proof.stderr) ||
        /^Error: Cannot find module /m.test(proof.stderr)
      )
        reason = 'node-module-error';
      else if (/^sudo: a password is required$/m.test(proof.stderr))
        reason = 'sudo-authentication';
      else if (
        /^sudo: sorry, you are not allowed to preserve the environment$/m.test(
          proof.stderr,
        )
      )
        reason = 'sudo-environment';
    }
    const error = Object.assign(new Error('Managed helper response unknown'), {
      managedUncertain: true,
      managedProtocol: {
        operation: ['prepare', 'check', 'launch', 'cleanup'].includes(
          request.operation,
        )
          ? request.operation
          : 'unknown',
        reason,
        outputBytes: Buffer.byteLength(proof.output),
        stderrBytes: Buffer.byteLength(proof.stderr),
        code: Number.isInteger(proof.code) ? proof.code : null,
        signal: proof.signal === null ? null : 'present',
      },
    });
    try {
      error.managedBootstrap = managedBootstrapObservation(proof.stderr, [
        process.env.GITHUB_WORKSPACE,
        process.execPath,
        dirname(process.execPath),
        ownFile,
        dirname(ownFile),
        process.env.TMPDIR,
        process.env.TMP,
        process.env.TEMP,
        request.source,
        request.artifact,
        request.workspace,
        request.token,
      ]);
    } catch {
      // Observation formatting cannot replace the unknown-response primary.
    }
    throw error;
  }
  if (!response.ok)
    throw Object.assign(new Error(response.error), {
      managedUncertain: response.uncertain === true,
      managedProtocol: {
        operation: request.operation,
        reason: 'helper-failure',
        outputBytes: Buffer.byteLength(proof.output),
        stderrBytes: Buffer.byteLength(proof.stderr),
        code: proof.code,
        signal: null,
      },
    });
  return response.value;
}
function nativeEffects() {
  const authorize = () => {
    managedGuard({
      env: process.env,
      platform: process.platform,
      arch: process.arch,
      uid: Number(process.env.SUDO_UID),
    });
    if (process.getuid() !== 0)
      fail('Private managed operation requires sudo from ordinary audit user');
  };
  const allowed = new Set(Object.values(managedPaths));
  const pathGuard = (path) => {
    authorize();
    if (!allowed.has(path)) fail('Unscoped managed mutation');
  };
  const create = async (path, text, mode, onCreated) => {
    pathGuard(path);
    const handle = await open(path, 'wx', mode);
    try {
      await onCreated(await handle.stat());
      await handle.writeFile(text());
    } finally {
      await handle.close();
    }
  };
  return {
    read: boundedRead,
    hash: boundedHash,
    lstat,
    stat: lstat,
    canonical: realpath,
    link: async (path) => (await import('node:fs/promises')).readlink(path),
    list: readdir,
    mkdir: async (path, mode) => {
      pathGuard(path);
      await mkdir(path, { mode });
    },
    create,
    receipt: async (text, expected) => {
      pathGuard(managedPaths.receipt);
      const handle = await open(
        managedPaths.receipt,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
      try {
        if (!same(identity(await handle.stat(), true), expected))
          fail('Receipt inode changed');
        await handle.truncate(0);
        await handle.writeFile(text);
      } finally {
        await handle.close();
      }
    },
    copy: async (source, destination, mode, onCreated) => {
      pathGuard(destination);
      const input = await open(
        source,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let output;
      try {
        const meta = await input.stat();
        if (
          !meta.isFile() ||
          meta.uid !== Number(process.env.SUDO_UID) ||
          meta.nlink !== 1 ||
          meta.mode & 0o6022 ||
          !Number.isSafeInteger(meta.size) ||
          meta.size < 0 ||
          meta.size > 256 * 1024 * 1024
        )
          fail('Original exceeds copy bound');
        output = await open(destination, 'wx', mode);
        await onCreated(await output.stat());
        const buffer = Buffer.alloc(65536);
        for (let offset = 0; offset < meta.size;) {
          const { bytesRead } = await input.read(
            buffer,
            0,
            Math.min(buffer.length, meta.size - offset),
            offset,
          );
          if (!bytesRead) fail('Original truncated');
          for (let written = 0; written < bytesRead;) {
            const result = await output.write(
              buffer,
              written,
              bytesRead - written,
              offset + written,
            );
            if (!result.bytesWritten) fail('Copy made no progress');
            written += result.bytesWritten;
          }
          offset += bytesRead;
        }
      } finally {
        await output?.close();
        await input.close();
      }
    },
    writer: async () => ({
      pid: process.pid,
      uid: process.getuid(),
      birth: processIdentity(await boundedRead('/proc/self/stat')).birth,
    }),
    parser: async (operation, record) => {
      const expires = performance.now() + 5000;
      authorize();
      if (!['add', 'remove'].includes(operation))
        fail('Unscoped parser command');
      if (performance.now() >= expires)
        throw Object.assign(new Error('Managed parser setup deadline'), {
          managedUncertain: true,
        });
      const child = spawn(
        '/usr/sbin/apparmor_parser',
        [
          '--config-file=/dev/null',
          '--skip-cache',
          '--jobs=0',
          `--${operation}`,
          '--',
          managedPaths.policy,
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' },
        },
      );
      return waitManagedChild(child, {
        expires,
        killOwned: true,
        onSpawn: async (actual) => {
          const current = processIdentity(
            await boundedRead(`/proc/${actual.pid}/stat`),
          );
          if (
            current.parent !== process.pid ||
            (await lstat(`/proc/${actual.pid}`)).uid !== 0
          )
            fail('Actual parser identity unproved');
          const identity = {
            pid: actual.pid,
            birth: current.birth,
            uid: 0,
            parent: process.pid,
          };
          await record(identity);
          return identity;
        },
      });
    },
    remove: async (path, kind) => {
      pathGuard(path);
      if (kind === 'directory' && path === managedPaths.directory)
        await rmdir(path);
      else if (kind === 'file' && path !== managedPaths.directory)
        await unlink(path);
      else fail('Unscoped removal');
    },
  };
}
if (
  hostBasename(process.argv[1] ?? '') === 'managed-appimage.mjs' &&
  process.argv[2] === '--managed-appimage-private'
) {
  const expires = performance.now() + 10000;
  const timer = setTimeout(
    () => process.exit(1),
    Math.max(0, expires - performance.now()),
  );
  try {
    const context = {
      env: process.env,
      platform: process.platform,
      arch: process.arch,
      uid: Number(process.env.SUDO_UID),
    };
    managedGuard(context);
    if (process.getuid() !== 0) fail('Private managed operation requires root');
    context.osRelease = release(await boundedRead('/etc/os-release'));
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 16384) fail('Managed request exceeds bound');
    }
    const result = await managedOperation(
      JSON.parse(input),
      nativeEffects(),
      context,
    );
    if (performance.now() >= expires)
      throw Object.assign(new Error('Managed helper elapsed deadline'), {
        managedUncertain: true,
      });
    process.stdout.write(JSON.stringify({ ok: true, value: result }));
  } catch (error) {
    console.error(String(error));
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: String(error).slice(0, 4096),
        uncertain:
          error?.managedUncertain === true || performance.now() >= expires,
      }),
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}
