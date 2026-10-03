import assert from 'node:assert/strict';
import { ChildProcess, spawn, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import {
  captureAppImageSpawn,
  originalArtifact,
  retainedSpawnIdentity,
  runtimeIdentity,
} from './appimage-observer.mjs';
const artifact = '/opt/Canopy/Canopy.AppImage';
const statText = (parent, birth) =>
  `70 (fixture) S ${parent} ${Array(17).fill('0').join(' ')} ${birth}`;
export async function checkRetainedAppImage() {
  await checkWorkerHandoff();
  const hash = createHash('sha256')
    .update('owned artifact sample')
    .digest('hex');
  const metadata = {
    uid: 0,
    gid: 0,
    mode: 0o100555,
    dev: 1,
    ino: 2,
    size: 21,
    mtimeMs: 1,
    ctimeMs: 1,
    isFile: () => true,
  };
  const config = {
    artifact,
    artifactSha256: hash,
    uid: 1001,
    parent: 50,
    parentBirth: '321',
    baseline: [],
    nonce: 'private-test-nonce',
  };
  const effects = {
    canonical: async (path) => path,
    hash: async () => hash,
    stat: async (path) =>
      path === artifact
        ? { ...metadata }
        : path.startsWith('/proc/')
          ? { uid: 1001 }
          : {
              uid: 0,
              gid: 0,
              dev: 1,
              ino: 10,
              mode: 0o40755,
              isDirectory: () => true,
            },
    read: async (path) =>
      statText(
        path === '/proc/50/stat' ? 1 : 50,
        path === '/proc/50/stat' ? '321' : '123',
      ),
    link: async () => '/tmp/.mount_CanopyABC/canopy',
  };
  const original = await originalArtifact(config, effects);
  await assert.rejects(
    originalArtifact({ ...config, uid: 0 }, effects),
    /Ordinary launch user/,
  );
  const offer = {
    type: 'offer',
    nonce: config.nonce,
    pid: 70,
    args: [artifact, '--inspect=0', '--remote-debugging-port=0'],
  };
  // Parent native polling rejects the already-execed process; the new managed
  // authority distinguishes a retained spawn contract from native observation.
  await assert.rejects(
    runtimeIdentity(70, config, effects),
    /Original runtime/,
  );
  assert.deepEqual(
    await retainedSpawnIdentity(offer, config, original, effects),
    { parent: 50, birth: '123' },
  );
  for (const value of [
    undefined,
    { ...offer, nonce: 'foreign' },
    { ...offer, pid: 0 },
    { ...offer, pid: 1.2 },
    { ...offer, args: [artifact, '--no-sandbox'] },
    { ...offer, type: 'confirm' },
  ])
    await assert.rejects(
      retainedSpawnIdentity(value, config, original, effects),
    );
  await assert.rejects(
    retainedSpawnIdentity(
      offer,
      { ...config, baseline: [70] },
      original,
      effects,
    ),
  );
  for (const altered of [
    { canonical: async (path) => (path === artifact ? '/foreign' : path) },
    { hash: async () => 'changed' },
    {
      stat: async (path) =>
        path === artifact ? { ...metadata, uid: 1001 } : effects.stat(path),
    },
    {
      stat: async (path) =>
        path === artifact
          ? { ...metadata, mode: 0o100755 }
          : effects.stat(path),
    },
    {
      stat: async (path) =>
        path === '/opt'
          ? { uid: 0, mode: 0o40777, isDirectory: () => true }
          : effects.stat(path),
    },
    {
      stat: async (path) =>
        path === '/opt/Canopy'
          ? { uid: 1001, mode: 0o40755, isDirectory: () => true }
          : effects.stat(path),
    },
    {
      stat: async (path) =>
        path.startsWith('/proc/') ? { uid: 0 } : effects.stat(path),
    },
    {
      read: async (path) =>
        statText(
          path === '/proc/50/stat' ? 1 : 49,
          path === '/proc/50/stat' ? '321' : '123',
        ),
    },
    {
      read: async (path) =>
        statText(
          path === '/proc/50/stat' ? 1 : 50,
          path === '/proc/50/stat' ? 'foreign' : '123',
        ),
    },
  ])
    await assert.rejects(
      retainedSpawnIdentity(offer, config, original, {
        ...effects,
        ...altered,
      }),
    );
  await assert.rejects(
    retainedSpawnIdentity(offer, config, original, {
      ...effects,
      stat: async (path) =>
        path === '/opt'
          ? { ...(await effects.stat(path)), ino: 11 }
          : effects.stat(path),
    }),
    /original changed/,
  );
  let reads = 0;
  await assert.rejects(
    retainedSpawnIdentity(offer, config, original, {
      ...effects,
      read: async (path) => {
        if (path === '/proc/70/stat')
          return statText(50, ++reads === 1 ? '123' : '124');
        return effects.read(path);
      },
    }),
    /identity changed/,
  );
  // A nonroot download cannot use the managed fast-exec substitute.
  const direct = { ...config, artifact: '/release/Canopy.AppImage' };
  const directEffects = {
    ...effects,
    stat: async (path) =>
      path === direct.artifact
        ? { ...metadata, uid: 1001, mode: 0o100755 }
        : effects.stat(path),
  };
  const directOriginal = await originalArtifact(direct, directEffects);
  await assert.rejects(
    retainedSpawnIdentity(
      {
        ...offer,
        args: [direct.artifact, '--inspect=0', '--remote-debugging-port=0'],
      },
      direct,
      directOriginal,
      directEffects,
    ),
    /Original runtime/,
  );

  // Exercise real Node constructor/spawn events on every platform. Node
  // rejects the Electron-only argument; OS spawn success is not app startup.
  const dir = await mkdtemp(join(tmpdir(), 'canopy-retained-spawn-'));
  try {
    const executable = process.env.JS_BINARY__NODE_BINARY ?? process.execPath;
    const options = {
      artifact: executable,
      nonce: 'actual-node-nonce',
      deadline: Date.now() + 1500,
    };
    const sent = [];
    const capture = captureAppImageSpawn(options, (value) => sent.push(value));
    const child = spawn(
      executable,
      ['--inspect=0', '--remote-debugging-port=0'],
      { stdio: 'ignore' },
    );
    try {
      await once(child, 'spawn');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].pid, child.pid);
      assert.deepEqual(sent[0].args, child.spawnargs);
      capture.confirm({
        type: 'confirm-request',
        nonce: options.nonce,
        pid: child.pid,
        birth: '123',
      });
      assert.equal(sent[1].type, 'confirm');
      await once(child, 'exit');
      assert.equal(sent.at(-1).type, 'revoke');
      const count = sent.length;
      capture.confirm({
        type: 'confirm-request',
        nonce: options.nonce,
        pid: child.pid,
        birth: 'late',
      });
      assert.equal(sent.length, count);
    } finally {
      capture.close();
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    }

    // Constructor-only publication is not proof, and unrelated commands do not
    // become offers. Fake diagnostics are confined to a private test callback.
    let subscriber;
    let unsubscribed = 0;
    const diagnostics = {
      subscribe: (fn) => {
        subscriber = fn;
      },
      unsubscribe: () => {
        unsubscribed++;
      },
    };
    const notes = [];
    const controller = captureAppImageSpawn(
      { ...options, deadline: Date.now() + 500 },
      (value) => notes.push(value),
      { diagnostics },
    );
    subscriber({ process: new ChildProcess() });
    assert.equal(notes.length, 0);
    controller.close();
    assert.equal(unsubscribed, 1);
    const unrelated = [];
    const ignore = captureAppImageSpawn(
      {
        ...options,
        artifact: join(dir, 'other.AppImage'),
        deadline: Date.now() + 1000,
      },
      (value) => unrelated.push(value),
    );
    const other = spawn(executable, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });
    try {
      await once(other, 'exit');
      assert.deepEqual(unrelated, []);
    } finally {
      ignore.close();
      if (other.exitCode === null && other.signalCode === null)
        other.kill('SIGKILL');
    }
    const bounded = [];
    const expiring = captureAppImageSpawn(
      { ...options, deadline: Date.now() + 30 },
      (value) => bounded.push(value),
      { diagnostics },
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(
      bounded.map((value) => value.type),
      ['revoke'],
    );
    expiring.close();
    for (const fault of ['duplicate-confirm', 'error', 'ambiguous']) {
      const records = [];
      const live = captureAppImageSpawn(
        { ...options, deadline: Date.now() + 1500 },
        (value) => records.push(value),
      );
      const actors = [
        spawn(executable, ['--inspect=0', '--remote-debugging-port=0'], {
          stdio: 'ignore',
        }),
      ];
      if (fault === 'ambiguous')
        actors.push(
          spawn(executable, ['--inspect=0', '--remote-debugging-port=0'], {
            stdio: 'ignore',
          }),
        );
      const exits = actors.map(
        (actor) => new Promise((resolve) => actor.once('exit', resolve)),
      );
      try {
        await once(actors[0], 'spawn');
        if (fault === 'duplicate-confirm') {
          const request = {
            type: 'confirm-request',
            nonce: options.nonce,
            pid: actors[0].pid,
            birth: '123',
          };
          live.confirm(request);
          live.confirm(request);
        } else if (fault === 'error') {
          const primary = new Error('owned child error');
          let actual;
          actors[0].once('error', (error) => {
            actual = error;
          });
          actors[0].emit('error', primary);
          assert.equal(actual, primary);
        }
        await Promise.all(exits);
        assert.equal(
          records.filter((value) => value.type === 'offer').length,
          1,
        );
        assert.equal(records.at(-1).type, 'revoke');
      } finally {
        live.close();
        for (const actor of actors)
          if (actor.exitCode === null && actor.signalCode === null)
            actor.kill('SIGKILL');
      }
    }
    const invalid = [];
    const wrong = captureAppImageSpawn(
      { ...options, deadline: Date.now() + 1000 },
      (value) => invalid.push(value),
    );
    const bad = spawn(executable, ['--no-sandbox'], { stdio: 'ignore' });
    try {
      await once(bad, 'exit');
      assert.deepEqual(
        invalid.map((value) => value.type),
        ['revoke'],
      );
    } finally {
      wrong.close();
      if (bad.exitCode === null && bad.signalCode === null) bad.kill('SIGKILL');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function checkWorkerHandoff() {
  const moduleUrl = new URL('./appimage-observer.mjs', import.meta.url);
  const source = await readFile(moduleUrl, 'utf8');
  const begin = source.indexOf('async function worker(config) {');
  const end = source.indexOf('\nasync function startObserver', begin);
  const retainedBegin = source.indexOf('async function retained(');
  const retainedEnd = source.indexOf(
    'export async function runtimeIdentity',
    retainedBegin,
  );
  assert(
    begin >= 0 &&
      end > begin &&
      retainedBegin >= 0 &&
      retainedEnd > retainedBegin,
  );
  const dir = await mkdtemp(join(tmpdir(), 'canopy-retained-ipc-'));
  try {
    const fixture = join(dir, 'worker.mjs');
    await writeFile(
      fixture,
      `
      import {mkdir, writeFile as actualWrite} from 'node:fs/promises';
      import {dirname} from 'node:path';
      import {originalArtifact as realOriginal, retainedSpawnIdentity as realSpawn,
        runtimeIdentity as realRuntime, mountedEvidence as realMounted,
        processIdentity, childPids} from ${JSON.stringify(moduleUrl.href)};
      const [mode, output] = process.argv.slice(2);
      let sampled = false;
      let nativeOriginalSeen = false;
      const writeFile = async (path, data) => {
        const value = JSON.parse(data);
        if (value.completed && mode.startsWith('final-')) {
          process.send({type:'final-write', finalizedAt:value.finalizedAt});
          if(mode==='final-hung') return new Promise(()=>{});
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        await actualWrite(path, data);
        if (value.samples.length && !value.completed) {
          sampled = true;
          process.send('sample-saved');
        }
      };
      const LIMIT = 10000;
      const proc = (pid, suffix) => '/proc/' + pid + '/' + suffix;
      const message = error => ({error:error?.code ?? error?.message ?? String(error)});
      const text = (parent,birth) => '70 (fixture) S ' + parent + ' ' + Array(17).fill('0').join(' ') + ' ' + birth;
      const artifact = '/opt/Canopy/Canopy.AppImage';
      const mount = '/tmp/.mount_CanopyFIXTURE';
      const io = {
        canonical: async path => path,
        stat: async path => path === artifact ? {uid:0,gid:0,mode:0o100555,dev:1,ino:2,size:21,mtimeMs:1,ctimeMs:1,isFile:()=>true} :
          path.endsWith('/exe') ? {uid:0} : path.startsWith('/proc/') ? {uid:mode==='owner-change' && sampled ? 1002 : 1001} : path.endsWith('chrome-sandbox') ? {uid:0,gid:0,mode:0o100755} : {uid:0,gid:0,dev:1,ino:10,mode:0o40755,isDirectory:()=>true},
        hash: async path => {if (mode === 'hung') return new Promise(()=>{});if(mode==='late-sample' && path.endsWith('/canopy')) await new Promise(resolve=>setTimeout(resolve,800));return path===artifact?'original':path.endsWith('app.asar')?'asar':'binary'},
        link: async () => {if(mode==='native-no-offer' && !nativeOriginalSeen){nativeOriginalSeen=true;return artifact;}return mount+'/canopy'},
        read: async path => {
          if(sampled && mode==='hung-after-sample') return new Promise(()=>{});
          if(sampled && mode==='parent-read-fail' && path===proc(process.ppid,'stat')) throw new Error('fixture parent read failed');
          return path.endsWith('/children') ? (path.startsWith('/proc/'+process.ppid+'/')?(sampled && mode==='ambiguity'?'70 71':'70'):'') :
          path.endsWith('mountinfo') ? '25 1 0:100 / '+mount+' ro,nosuid,nodev - fuse.Canopy '+artifact+' ro' :
          path.endsWith('attr/current') ? 'fixture-profile (unconfined)' : text(path.startsWith('/proc/'+process.ppid+'/')?1:process.ppid,path.startsWith('/proc/'+process.ppid+'/')?(sampled && mode==='parent-change'?'322':'321'):(sampled && mode==='birth-change'?'124':'123'));},
      };
      const originalArtifact = config => realOriginal(config,io);
      const retainedSpawnIdentity = (value,config,original) => realSpawn(value,config,original,io);
      const runtimeIdentity = (pid,config) => realRuntime(pid,config,io);
      const mountedEvidence = (pid,identity,config) => realMounted(pid,identity,config,io);
      const diagnosticCommand = async () => {
        if(mode==='pre-final-revoke') {
          process.send('pre-finalize');
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        return {error:'fixture audit unavailable'};
      };
      ${source.slice(retainedBegin, retainedEnd)}
      ${source.slice(begin, end)}
      await worker({artifact,artifactSha256:'original',parent:process.ppid,parentBirth:'321',uid:1001,
        baseline:[],nonce:'fixture-private-nonce',executableSha256:'binary',appAsarSha256:'asar',output,deadline:Date.now()+1400});
    `,
    );
    for (const mode of [
      'success',
      'duplicate-offer',
      'bad-nonce',
      'duplicate-confirm',
      'late-confirm',
      'missing-confirm',
      'expired-confirm',
      'disconnect',
      'hung',
      'ambiguity',
      'parent-read-fail',
      'parent-change',
      'birth-change',
      'owner-change',
      'pre-final-revoke',
      'final-revoke',
      'final-disconnect',
      'final-hung',
      'late-sample',
      'hung-after-sample',
      'native-no-offer',
    ]) {
      const output = join(dir, mode + '.json');
      const child = fork(fixture, [mode, output], {
        execPath: process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
        execArgv: [],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const timers = [];
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      let savedPositive = false;
      let boundary;
      child.on('message', (value) => {
        if (value === 'sample-saved') {
          savedPositive = true;
          return;
        }
        if (value === 'pre-finalize') {
          child.send(
            { type: 'revoke', nonce: 'fixture-private-nonce' },
            () => {},
          );
          return;
        }
        if (value?.type === 'final-write') {
          boundary = value.finalizedAt;
          if (mode === 'final-disconnect') child.disconnect();
          else
            child.send(
              { type: 'revoke', nonce: 'fixture-private-nonce' },
              () => {},
            );
          return;
        }
        if (value === 'ready') {
          if (mode === 'native-no-offer') return;
          const offer = {
            type: 'offer',
            nonce: mode === 'bad-nonce' ? 'foreign' : 'fixture-private-nonce',
            pid: 70,
            args: [artifact, '--inspect=0', '--remote-debugging-port=0'],
          };
          child.send(offer, () => {});
          if (mode === 'duplicate-offer') child.send(offer, () => {});
          if (mode === 'bad-nonce' || mode === 'duplicate-offer')
            timers.push(
              setTimeout(() => {
                if (child.connected) child.send('stop', () => {});
              }, 80),
            );
        } else if (value.type === 'confirm-request') {
          if (mode === 'missing-confirm') {
            timers.push(
              setTimeout(() => {
                if (child.connected) child.send('stop', () => {});
              }, 550),
            );
            return;
          }
          if (mode === 'disconnect') {
            child.disconnect();
            return;
          }
          const confirm = {
            type: 'confirm',
            nonce: value.nonce,
            pid: value.pid,
            birth: value.birth,
          };
          if (mode === 'expired-confirm') {
            timers.push(
              setTimeout(() => {
                if (child.connected) child.send(confirm, () => {});
              }, 550),
            );
            return;
          }
          if (mode === 'late-confirm') child.send('stop', () => {});
          child.send(confirm, () => {});
          if (mode === 'duplicate-confirm') child.send(confirm, () => {});
          if (['success', 'duplicate-confirm', 'late-confirm'].includes(mode))
            timers.push(
              setTimeout(() => {
                if (child.connected) child.send('stop', () => {});
              }, 80),
            );
        }
      });
      try {
        const result = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code, signal) => resolve({ code, signal }));
        });
        assert.deepEqual(result, { code: 0, signal: null }, stderr);
        const report = JSON.parse(await readFile(output, 'utf8'));
        if (
          [
            'success',
            'final-revoke',
            'final-disconnect',
            'final-hung',
            'hung-after-sample',
            'native-no-offer',
          ].includes(mode)
        ) {
          assert.equal(report.status, 'observed');
          if (mode === 'native-no-offer')
            assert.equal(report.authority, undefined);
          else assert.equal(report.authority.kind, 'retained-spawn');
          assert.equal(report.samples.length, 1);
          assert.equal(
            report.samples[0].apparmorContext,
            'fixture-profile (unconfined)',
          );
        } else {
          assert.equal(report.status, 'unknown');
          assert.deepEqual(report.samples, []);
        }
        assert.equal(
          report.completed,
          !['hung', 'hung-after-sample', 'final-hung'].includes(mode),
        );
        if (
          [
            'ambiguity',
            'parent-read-fail',
            'parent-change',
            'birth-change',
            'owner-change',
            'pre-final-revoke',
          ].includes(mode)
        ) {
          assert(
            savedPositive,
            mode + ' must invalidate a previously persisted positive sample',
          );
          assert.equal(report.authority, undefined);
        }
        if (mode.startsWith('final-')) {
          assert(savedPositive);
          assert(
            Number.isFinite(boundary),
            'protocol must close before final serialization',
          );
          if (mode !== 'final-hung') assert.equal(report.finalizedAt, boundary);
        }
        if (report.completed) assert(Number.isFinite(report.finalizedAt));
        else assert.equal(report.finalizedAt, undefined);
      } finally {
        clearTimeout(timer);
        timers.forEach(clearTimeout);
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
