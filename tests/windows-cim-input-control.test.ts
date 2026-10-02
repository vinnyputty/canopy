import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runCimInputControls } from '../tools/windows-cim-input-control.mjs';

const output = `console.log(JSON.stringify({pid:process.pid,ppid:process.ppid,start:null}));`;
const entry = `console.error('canopy-fixture pid='+process.pid); console.error('canopy-cim phase=module-load');`;
function assertGone(pid: number | null) {
  assert.ok(pid !== null && pid > 1);
  assert.throws(
    () => process.kill(pid, 0),
    (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
  );
}

test('real owned Node input reader distinguishes open stdin from EOF and ignore, with closure before the next comparison', async () => {
  // This proves transport behavior, never Windows PowerShell module behavior.
  const unrelated = spawn(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    { stdio: 'ignore' },
  );
  await once(unrelated, 'spawn');
  try {
    const reports: string[] = [];
    const result = await runCimInputControls({
      command: process.execPath,
      argsFor: () => [
        '-e',
        `${entry} process.stdin.resume(); process.stdin.once('end',()=>{ console.error('canopy-cim phase=complete'); ${output} });`,
      ],
      timeoutMs: 1000,
      report: (record) => {
        assert.equal(record.closed, true);
        assertGone(record.childPid);
        reports.push(`${record.variant}/${record.mode}`);
      },
    });
    assert.deepEqual(reports, [
      'raw/sync',
      'raw/exec-open',
      'raw/exec-end',
      'raw/spawn-ignore',
      'canonical/exec-open',
      'canonical/exec-end',
      'canonical/spawn-ignore',
    ]);
    for (const record of result) {
      assert.equal(record.ok, record.mode !== 'exec-open');
      assert.equal(
        record.phase,
        record.mode === 'exec-open' ? 'module-load' : 'complete',
      );
      if (record.mode === 'exec-open') {
        assert.ok(record.elapsedMs >= 1000 && record.elapsedMs < 3000);
        assert.ok(
          record.stderrEvents!.length > 0,
          'stderr arrived while stdout/input remained blocked',
        );
        assert.equal(record.stdoutBytes, 0);
      } else {
        assert.equal(record.rows, 1);
        assert.ok(!('stdout' in record), 'raw process rows are not reported');
      }
    }
    assert.equal(process.kill(unrelated.pid!, 0), true);
  } finally {
    const exited = once(unrelated, 'exit');
    unrelated.kill('SIGKILL');
    await exited;
  }
});

test('real Node no-input command succeeds for every transport without changing script or child environment', async () => {
  const env = {
    ...process.env,
    PSModulePath: 'fixture-incompatible',
    canopy_control_sentinel: 'preserved',
  };
  const scripts: string[] = [];
  const results = await runCimInputControls({
    command: process.execPath,
    env,
    timeoutMs: 1000,
    argsFor: (script) => {
      scripts.push(script);
      return [
        '-e',
        `${entry} if(process.env.PSModulePath || process.env.canopy_control_sentinel!=='preserved') process.exit(4); ${output}`,
      ];
    },
    report: (record) => assertGone(record.childPid),
  });
  assert.ok(results.every((record) => record.ok && record.closed));
  assert.equal(env.PSModulePath, 'fixture-incompatible');
  for (const script of scripts) {
    assert.ok(script.includes('Get-CimInstance Win32_Process'));
    assert.ok(script.includes('ToString("o")'));
  }
  assert.equal(new Set(scripts).size, 2);
  assert.ok(scripts[0].includes('Import-Module CimCmdlets;'));
  assert.ok(
    scripts
      .at(-1)!
      .includes(
        "Import-Module ($PSHOME + '\\Modules\\CimCmdlets\\CimCmdlets.psd1');",
      ),
  );
});

test('real Node launch/exit/parse faults remain diagnostic failures and all bounded comparisons continue', async () => {
  let index = 0;
  const result = await runCimInputControls({
    command: process.execPath,
    timeoutMs: 1000,
    argsFor: () => [
      '-e',
      `${entry} ${index++ % 2 ? 'process.exit(9)' : "console.log('not-json')"}`,
    ],
    report: (record) => assertGone(record.childPid),
  });
  assert.equal(result.length, 7);
  assert.ok(result.every((record) => !record.ok && record.closed));
  assert.equal(result[0].error, 'INVALID_SNAPSHOT_JSON');
  assert.equal(result[1].stdoutBytes, 0);
  const missing = await runCimInputControls({
    command: `canopy-owned-nonexistent-${process.pid}`,
    timeoutMs: 1000,
    report: () => {},
  });
  assert.equal(missing.length, 7);
  assert.ok(missing.every((record) => !record.ok && record.closed));
});

test('real child stderr is drained past diagnostic truncation and retains the final phase', async () => {
  const result = await runCimInputControls({
    command: process.execPath,
    timeoutMs: 1000,
    argsFor: () => [
      '-e',
      `${entry} console.error('x'.repeat(9000)); console.error('canopy-cim phase=complete'); ${output}`,
    ],
    report: (record) => assertGone(record.childPid),
  });
  for (const record of result) {
    assert.equal(record.ok, true);
    assert.ok(record.stderrBytes > 9000);
    assert.ok(!('stderr' in record));
    // Sync retains full stderr internally; async tracks markers as it drains.
    assert.equal(record.phase, 'complete');
  }
});

const helper =
  process.env.CANOPY_INPUT_CONTROL_SOURCE ??
  new URL('../tools/windows-cim-input-control.mjs', import.meta.url).href;
async function reviewedControl() {
  return (await import(helper))
    .runCimInputControls as typeof runCimInputControls;
}

const model = `
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const children=[];
const row=JSON.stringify({pid:123456,ppid:0,start:null});
cp.spawnSync=()=>({pid:123456,status:0,signal:null,stdout:row,stderr:''});
function child() {
  const c=new EventEmitter();
  c.pid=123457; c.killed=false;
  c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();
  c.unref=()=>{c.unreferenced=true;};
  children.push(c);return c;
}
`;
function checkModel(source: string) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', source],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test('refused termination and withheld close fail closed with retained primary/handle and cleared observers', () => {
  checkModel(`${model}
    let calls=0, launches=0, primary;
    cp.execFile=()=>{launches++; const c=child();c.kill=()=>{calls++;return false;};return c;};
    syncBuiltinESMExports();
    const {runCimInputControls}=await import(${JSON.stringify(helper)});
    const records=[];
    let failure;
    try { await runCimInputControls({timeoutMs:30,report:r=>records.push(r)}); }
    catch(error) {failure=error;}
    assert.ok(failure,'unconfirmed control must reject, not return normally');
    assert.equal(failure.child,children[0]);
    assert.equal(failure.primary.code,'ETIMEDOUT');
    assert.equal(failure.record.closed,false);
    assert.equal(launches,1,'no later comparisons launched');
    assert.deepEqual(failure.record.cleanupCodes,['CONTROL_CLEANUP_FAILED']);
    assert.equal(records.length,2);
    assert.equal(children[0].unreferenced,true);
    for(const emitter of [children[0],children[0].stdin,children[0].stdout,children[0].stderr])
      for(const event of ['spawn','close','error','data']) assert.equal(emitter.listenerCount(event),0);
    for(const stream of [children[0].stdin,children[0].stdout,children[0].stderr]) assert.equal(stream.destroyed,true);
    const before=calls;
    await new Promise(r=>setTimeout(r,80));
    assert.equal(calls,before,'no retained timer or late observer can signal');
    const secondary=new Error('secondary report fault');
    await assert.rejects(runCimInputControls({timeoutMs:30, report:r=>{if(!r.closed)throw secondary;}}), error=>error.primary.code==='ETIMEDOUT' && error.reportError===secondary && error.child===children[1]);
    const denied=Object.assign(new Error('fixture-private-kill-error'),{code:'EPERM'});
    cp.execFile=()=>{const c=child();c.kill=()=>{throw denied;};return c;};
    syncBuiltinESMExports();
    await assert.rejects(runCimInputControls({timeoutMs:30,report:()=>{}}), error=>{
      assert.equal(error.primary.code,'ETIMEDOUT');
      assert.equal(error.cleanupErrors[0],denied);
      assert.deepEqual(error.record.cleanupCodes,['EPERM']);
      assert.ok(!String(error).includes('fixture-private-kill-error'));
      return true;
    });
  `);
});

test('held close and stdin/stream faults preserve bounded cleanup and remove listeners on successful closure', () => {
  checkModel(`${model}
    let index=0;
    const primary=Object.assign(new Error('fixture input failure'),{code:'EPIPE'});
    cp.execFile=()=>{
      const c=child(); const n=index++;
      c.kill=(signal)=>{assert.equal(signal,'SIGKILL');c.killed=true;setTimeout(()=>c.emit('close',null,signal),80);return true;};
      if(n===1)c.stdin.end=()=>{throw primary;};
      queueMicrotask(()=>{ if(n===0)c.stderr.emit('error',primary); else if(n!==1){c.stdout.emit('data',row);c.emit('close',0,null);} });
      return c;
    };
    cp.spawn=()=>{const c=child();queueMicrotask(()=>{c.stdout.emit('data',row);c.emit('close',0,null);});return c;};
    syncBuiltinESMExports();
    const {runCimInputControls}=await import(${JSON.stringify(helper)});
    const result=await runCimInputControls({timeoutMs:300,report:()=>{}});
    assert.equal(result.length,7);
    assert.equal(result[1].closed,true);assert.equal(result[1].code,'EPIPE');
    assert.equal(result[2].closed,true);assert.equal(result[2].code,'EPIPE');
    for(const c of children) for(const emitter of [c,c.stdin,c.stdout,c.stderr])
      for(const event of ['spawn','close','error','data']) assert.equal(emitter.listenerCount(event),0);
  `);
});

test('actual lifecycle setup controller blocks following fixtures on unconfirmed diagnostic closure', async () => {
  const lifecycle = await readFile(
    process.env.CANOPY_INPUT_CONTROLLER_SOURCE ??
      new URL('./audit-lifecycle.test.ts', import.meta.url),
    'utf8',
  );
  const controller = lifecycle
    .slice(
      lifecycle.indexOf("if (process.platform === 'win32')"),
      lifecycle.indexOf('// PowerShell/CIM startup'),
    )
    .replace("if (process.platform === 'win32')", 'if (true)')
    .replace(
      'runCimInputControls()',
      'runCimInputControls({timeoutMs:30, report:()=>{}})',
    );
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `${model}
    import {before,test} from 'node:test';
    cp.execFile=()=>{const c=child();c.kill=()=>false;return c;};
    syncBuiltinESMExports();
    const {runCimInputControls}=await import(${JSON.stringify(helper)});
    ${controller}
    test('required fixture sentinel',()=>console.log('FIXTURE_STARTED_UNSAFELY'));
  `,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, 'worker setup must fail');
  assert.ok(!result.stdout.includes('FIXTURE_STARTED_UNSAFELY'));
  assert.match(result.stdout, /closure unconfirmed/);
});

test('real owned Node refuses TERM, closes after scoped KILL, and leaves unrelated child untouched', async () => {
  const unrelated = spawn(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    { stdio: 'ignore' },
  );
  await once(unrelated, 'spawn');
  try {
    let index = 0;
    const results = await runCimInputControls({
      command: process.execPath,
      timeoutMs: 1000,
      argsFor: () => [
        '-e',
        index++ === 1
          ? `${entry} process.on('SIGTERM',()=>console.error('canopy-cim phase=query'));if(process.platform!=='win32')process.kill(process.pid,'SIGTERM');setInterval(()=>{},1000);`
          : `${entry} ${output}`,
      ],
      report: (record) => {
        assert.equal(record.closed, true);
        assertGone(record.childPid);
      },
    });
    assert.equal(results.length, 7);
    assert.equal(results[1].ok, false);
    if (process.platform !== 'win32')
      assert.equal(
        results[1].phase,
        'query',
        'fixture handled TERM and remained alive until scoped KILL',
      );
    assert.equal(process.kill(unrelated.pid!, 0), true);
  } finally {
    const exit = once(unrelated, 'exit');
    unrelated.kill('SIGKILL');
    await exit;
  }
});

test('real malformed/nonzero/extra-field stdout and stderr never expose a synthetic command-line secret', async () => {
  const sentinel = 'fixture-only-sensitive-stdout-token';
  let index = 0;
  const reported: unknown[] = [];
  const results = await (
    await reviewedControl()
  )({
    command: process.execPath,
    timeoutMs: 1000,
    argsFor: () => [
      '-e',
      `${entry} console.error(${JSON.stringify(sentinel)});console.log(${JSON.stringify(JSON.stringify({ pid: 123, ppid: 0, start: null, CommandLine: sentinel }))}${index++ % 3 === 0 ? "+'invalid-json'" : ''});${index % 3 === 2 ? 'process.exitCode=9;' : ''}`,
    ],
    report: (record) => {
      reported.push(record);
      assertGone(record.childPid);
    },
  });
  assert.ok(!JSON.stringify(reported).includes(sentinel));
  assert.ok(results.every((r) => !r.ok && r.closed));
  assert.ok(results.some((r) => r.error === 'INVALID_SNAPSHOT_JSON'));
  assert.ok(results.some((r) => r.error === 'INVALID_SNAPSHOT_SCHEMA'));
  assert.ok(results.every((r) => r.stdoutBytes > 0 && r.stderrBytes > 0));
});

test('real stdout/stderr overflow enforces the cap for every transport and confirms closure before continuing', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const results = await (
      await reviewedControl()
    )({
      command: process.execPath,
      timeoutMs: 1500,
      argsFor: () => [
        '-e',
        `${entry} process.${stream}.write('x'.repeat(17*1024*1024));${output}`,
      ],
      report: (record) => {
        assert.equal(record.closed, true);
        assertGone(record.childPid);
      },
    });
    assert.equal(results.length, 7);
    assert.ok(
      results.every((record) => !record.ok),
      stream + ' cap must apply to ignored-input comparisons too',
    );
  }
});
