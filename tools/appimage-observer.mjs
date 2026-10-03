import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMIT = 10_000;
const MAX_TEXT = 64 * 1024;
const MAX_HASH = 256 * 1024 * 1024;
const ownFile = fileURLToPath(import.meta.url);
const hosted = (env) =>
  env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
const message = (error) => ({
  error: error?.code ?? error?.message ?? String(error),
});

// Never read cmdline or environ. A PID alone is not a retained process identity.
export function processIdentity(text) {
  const end = text.lastIndexOf(')');
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  if (end < 0 || fields.length < 20 || !/^\d+$/.test(fields[19]))
    throw new Error('Invalid process stat');
  return { parent: Number(fields[1]), birth: fields[19] };
}
export function childPids(text) {
  if (!/^\s*(?:\d+\s*)*$/.test(text)) throw new Error('Invalid child list');
  return text.trim() ? text.trim().split(/\s+/).map(Number) : [];
}
export function mountedPath(executable, mountinfo) {
  const match = /^\/tmp\/(\.mount_Canopy[a-zA-Z0-9]+)\/canopy$/.exec(
    executable,
  );
  if (!match) throw new Error('Executable is outside the owned Canopy mount');
  const mount = dirname(executable);
  const lines = mountinfo
    .split('\n')
    .filter((line) => line.split(' ')[4] === mount);
  if (lines.length !== 1)
    throw new Error('Mounted filesystem identity unavailable');
  const [left, right] = lines[0].split(' - ');
  const fields = right?.split(' ');
  if (!fields?.[0].startsWith('fuse'))
    throw new Error('Executable is not on a FUSE mount');
  return {
    path: mount,
    options: left.split(' ')[5],
    filesystem: fields[0],
    source: fields[1],
    superOptions: fields[2],
  };
}
export async function boundedRead(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_TEXT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_TEXT) throw new Error('Diagnostic input exceeds limit');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}
export async function boundedHash(path) {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new Error('Diagnostic payload is not a regular file');
    if (
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 0 ||
      metadata.size > MAX_HASH
    )
      throw new Error('Payload exceeds diagnostic hash limit');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; position < metadata.size;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, metadata.size - position),
        position,
      );
      if (!bytesRead) throw new Error('Payload disappeared during hash');
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== metadata.size ||
      after.mtimeMs !== metadata.mtimeMs ||
      after.ctimeMs !== metadata.ctimeMs
    )
      throw new Error('Payload changed during diagnostic hash');
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}
const io = {
  read: boundedRead,
  link: readlink,
  canonical: realpath,
  stat,
  hash: boundedHash,
};
const proc = (pid, suffix) => `/proc/${pid}/${suffix}`;
async function waitWithin(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Diagnostic operation timed out')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function retained(pid, identity, effects) {
  const current = processIdentity(await effects.read(proc(pid, 'stat')));
  if (current.birth !== identity.birth || current.parent !== identity.parent)
    throw new Error('Process identity changed');
}
export async function runtimeIdentity(pid, config, effects = io) {
  if (config.baseline.includes(pid))
    throw new Error('Pre-existing child is outside launch scope');
  const identity = processIdentity(await effects.read(proc(pid, 'stat')));
  if (identity.parent !== config.parent)
    throw new Error('Foreign launch parent');
  if ((await effects.link(proc(pid, 'exe'))) !== config.artifact)
    throw new Error('Original runtime identity was not observed');
  if ((await effects.stat(proc(pid, 'exe'))).uid !== config.uid)
    throw new Error('Runtime ownership mismatch');
  await retained(pid, identity, effects);
  return identity;
}
// Only descendants of the original, observed runtime can supply mounted evidence.
export async function mountedEvidence(pid, identity, config, effects = io) {
  await retained(pid, identity, effects);
  if ((await effects.stat(proc(pid, ''))).uid !== config.uid)
    throw new Error('Mounted process owner differs from launch user');
  const executable = await effects.link(proc(pid, 'exe'));
  const mount = mountedPath(
    executable,
    await effects.read(proc(pid, 'mountinfo')),
  );
  const helper = join(mount.path, 'chrome-sandbox');
  if ((await effects.canonical(helper)) !== helper)
    throw new Error('Sandbox helper escapes mounted payload');
  if (
    (await effects.hash(executable)) !== config.executableSha256 ||
    (await effects.hash(join(mount.path, 'resources', 'app.asar'))) !==
      config.appAsarSha256
  )
    throw new Error('Mounted payload identity mismatch');
  const metadata = await effects.stat(helper);
  const context = await effects.read(proc(pid, 'attr/current'));
  await retained(pid, identity, effects);
  if ((await effects.link(proc(pid, 'exe'))) !== executable)
    throw new Error('Executable changed during observation');
  return {
    pid,
    birth: identity.birth,
    executable,
    mount,
    apparmorContext: context.trim(),
    sandboxHelper: {
      path: helper,
      uid: metadata.uid,
      gid: metadata.gid,
      mode: (metadata.mode & 0o7777).toString(8),
    },
  };
}

// Bounded read-only commands. Permission denial/output truncation remain unknown.
export function diagnosticCommand(command, args, budget = 500) {
  return new Promise((resolve) => {
    let child;
    let output = '';
    let bytes = 0;
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(
      () => {
        child?.kill('SIGKILL');
        finish({ error: 'Diagnostic command timed out' });
      },
      Math.max(1, Math.min(500, budget)),
    );
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_TEXT) {
          child.kill('SIGKILL');
          finish({ error: 'Diagnostic output exceeds limit' });
        } else output += chunk.toString();
      });
      child.on('error', (error) => finish(message(error)));
      child.on('close', (code) =>
        finish(
          code === 0
            ? { output }
            : { error: `Read-only command exit ${code}; evidence unavailable` },
        ),
      );
    } catch (error) {
      finish(message(error));
    }
  });
}
export async function canopyPolicyEvidence(
  env = process.env,
  effects = { stat, command: diagnosticCommand },
) {
  if (!hosted(env))
    return { unavailable: 'Not a disposable GitHub-hosted runner' };
  let profile;
  try {
    const value = await effects.stat('/etc/apparmor.d/canopy');
    profile = {
      present: true,
      uid: value.uid,
      mode: (value.mode & 0o7777).toString(8),
    };
  } catch (error) {
    profile = error.code === 'ENOENT' ? { present: false } : message(error);
  }
  const loaded = await effects.command('sudo', [
    '-n',
    'timeout',
    '--signal=KILL',
    '0.4s',
    'grep',
    '-E',
    '^canopy( |$)',
    '/sys/kernel/security/apparmor/profiles',
  ]);
  return { profile, loaded };
}
export async function recordCanopyPolicy(path, phase) {
  let timer;
  try {
    await Promise.race([
      (async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(
          path,
          JSON.stringify({ phase, ...(await canopyPolicyEvidence()) }, null, 2),
        );
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Policy snapshot timed out')),
          750,
        );
      }),
    ]);
  } catch (error) {
    console.error('Canopy policy diagnostics unavailable:', message(error));
  } finally {
    clearTimeout(timer);
  }
}

async function worker(config) {
  const started = Date.now();
  const deadline = Math.min(config.deadline, started + LIMIT);
  const evidence = {
    artifact: config.artifact,
    parent: config.parent,
    parentBirth: config.parentBirth,
    status: 'unknown',
    completed: false,
    samples: [],
    limitations: [],
  };
  const roots = new Map();
  const baseline = new Set(config.baseline);
  const seen = new Set();
  const note = (error) => {
    const value = message(error);
    if (
      evidence.limitations.length < 12 &&
      !evidence.limitations.some((item) => item.error === value.error)
    )
      evidence.limitations.push(value);
  };
  const save = () =>
    writeFile(config.output, JSON.stringify(evidence, null, 2));
  let stopped = false;
  // IPC failures are secondary diagnostics, including parent-disconnect races.
  process.on('error', note);
  process.on('message', (value) => {
    if (value === 'stop') stopped = true;
  });
  process.on('disconnect', () => {
    stopped = true;
  });
  // An abort of the smoke parent still leaves this private observer its bounded
  // chance to persist evidence. A hard deadline also bounds slow filesystem IO.
  const hardStop = setTimeout(
    () => {
      process.exit(0);
    },
    Math.max(1, deadline - Date.now()),
  );
  try {
    await mkdir(dirname(config.output), { recursive: true });
    await save();
    if (process.connected)
      process.send('ready', (error) => {
        if (error) note(error);
      });
    while (!stopped && Date.now() < deadline - 750) {
      try {
        const parent = processIdentity(
          await io.read(proc(config.parent, 'stat')),
        );
        if (parent.birth !== config.parentBirth)
          throw new Error('Launch parent identity changed or exited');
        const children = childPids(
          await io.read(proc(config.parent, `task/${config.parent}/children`)),
        ).filter((pid) => pid !== process.pid && !baseline.has(pid));
        if (children.length > 1)
          throw new Error('Ambiguous launch children; identity unavailable');
        for (const pid of children) {
          const identity = processIdentity(await io.read(proc(pid, 'stat')));
          if (identity.parent !== config.parent)
            throw new Error('Foreign launch parent');
          if (!roots.has(pid)) {
            if (roots.size)
              throw new Error(
                'A different runtime PID appeared in this launch',
              );
            // Bind the real runtime before it execs the mounted binary. Missing
            // this transient event is explicitly unknown, never a hash-only bind.
            roots.set(pid, await runtimeIdentity(pid, config));
          }
        }
        for (const [root, identity] of roots) {
          await retained(root, identity, io);
          const candidates = [{ pid: root, identity }];
          // Follow only the retained runtime's direct children; no global /proc
          // scan. FUSE runtime implementations may fork the mounted executable.
          for (const pid of childPids(
            await io.read(proc(root, `task/${root}/children`)),
          )) {
            const child = processIdentity(await io.read(proc(pid, 'stat')));
            if (child.parent === root)
              candidates.push({ pid, identity: child });
          }
          for (const candidate of candidates) {
            const key = `${candidate.pid}:${candidate.identity.birth}`;
            if (seen.has(key) || evidence.samples.length >= 4) continue;
            const executable = await io.link(proc(candidate.pid, 'exe'));
            if (!/^\/tmp\/\.mount_Canopy[a-zA-Z0-9]+\/canopy$/.test(executable))
              continue;
            const sample = await mountedEvidence(
              candidate.pid,
              candidate.identity,
              config,
            );
            await retained(root, identity, io);
            evidence.samples.push(sample);
            seen.add(key);
            evidence.status = 'observed';
            await save();
          }
        }
      } catch (error) {
        note(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Kernel output is filtered at the reader, never copied wholesale. Include
    // only this invocation's observed PIDs and exact validated mount paths.
    const targets = [...roots.keys()].map((pid) => `pid=${pid}([^0-9]|$)`);
    for (const sample of evidence.samples) {
      targets.push(`pid=${sample.pid}([^0-9]|$)`);
      targets.push(sample.mount.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    if (targets.length && Date.now() < deadline - 550) {
      const target = `(${targets.join('|')})`;
      const filter = `((apparmor|userns).*${target}|${target}.*(apparmor|userns))`;
      evidence.kernelAudit = await diagnosticCommand(
        'sudo',
        [
          '-n',
          'timeout',
          '--signal=KILL',
          '0.4s',
          'journalctl',
          '--kernel',
          '--no-pager',
          '--quiet',
          '--output=cat',
          '--since',
          `@${Math.floor(started / 1000)}`,
          '--until',
          `@${Math.ceil(Date.now() / 1000)}`,
          '--grep',
          filter,
        ],
        deadline - Date.now() - 50,
      );
    } else
      evidence.kernelAudit = {
        unavailable: 'No retained launch identity or remaining audit budget',
      };
    evidence.completed = true;
    evidence.elapsedMs = Date.now() - started;
    await save();
  } catch (error) {
    note(error);
    console.error('AppImage observer diagnostics unavailable:', message(error));
    await save().catch(() => {});
  } finally {
    clearTimeout(hardStop);
    if (process.connected) process.disconnect();
  }
}

async function startObserver(config) {
  const parent = process.pid;
  const [parentStat, children, artifact] = await waitWithin(
    Promise.all([
      io.read(proc(parent, 'stat')),
      io.read(proc(parent, `task/${parent}/children`)),
      realpath(config.artifact),
    ]),
    500,
  );
  const parentBirth = processIdentity(parentStat).birth;
  const baseline = childPids(children);
  if (artifact !== config.artifact || !artifact.endsWith('.AppImage'))
    throw new Error('Original canonical AppImage required');
  const child = spawn(
    process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
    [
      ownFile,
      '--appimage-observer',
      JSON.stringify({
        ...config,
        artifact,
        parent,
        parentBirth,
        baseline,
        uid: process.getuid(),
        deadline: Date.now() + LIMIT,
      }),
    ],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], detached: false },
  );
  const lifetime = setTimeout(() => child.kill('SIGKILL'), LIMIT);
  lifetime.unref();
  child.once('exit', () => clearTimeout(lifetime));
  child.once('error', () => clearTimeout(lifetime));
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 500);
    child.once('message', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return resolve();
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 750);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      if (child.connected) child.send('stop', () => {});
    });
}
export async function observeAppImageLaunch(
  config,
  launch,
  {
    env = process.env,
    start = startObserver,
    platform = process.platform,
  } = {},
) {
  if (platform !== 'linux' || !hosted(env)) return launch();
  let finish;
  try {
    const startup = Promise.resolve().then(() => start(config));
    try {
      finish = await waitWithin(startup, 1000);
    } catch (error) {
      // A late setup must be stopped instead of following an unrelated launch.
      startup.then((stop) => stop?.()).catch(() => {});
      throw error;
    }
  } catch (error) {
    console.error('AppImage observer unavailable:', message(error));
  }
  try {
    return await launch();
  } finally {
    try {
      if (finish) await waitWithin(Promise.resolve().then(finish), 750);
    } catch (error) {
      console.error(
        'AppImage observer completion unavailable:',
        message(error),
      );
    }
  }
}

if (process.argv[2] === '--appimage-observer') {
  if (process.platform !== 'linux' || !hosted(process.env))
    throw new Error(
      'Observer requires a disposable GitHub-hosted Linux runner',
    );
  await worker(JSON.parse(process.argv[3]));
}
