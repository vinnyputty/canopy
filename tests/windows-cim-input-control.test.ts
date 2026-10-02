import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { runCimInputControls } from '../tools/windows-cim-input-control.mjs';

const output = `console.log(JSON.stringify({pid:process.pid,ppid:process.ppid,start:null}));`;
const entry = `console.error('canopy-fixture pid='+process.pid); console.error('canopy-cim phase=module-load');`;
function assertGone(stderr: string) {
  const pid = Number(stderr.match(/canopy-fixture pid=(\d+)/)?.[1]);
  assert.ok(pid > 1);
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
        assertGone(record.stderr);
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
        assert.equal(record.stdout, '');
      } else {
        assert.equal(record.rows, 1);
        assert.equal(
          record.stdout,
          undefined,
          'successful raw process rows are not reported',
        );
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
    report: (record) => assertGone(record.stderr),
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
    report: (record) => assertGone(record.stderr),
  });
  assert.equal(result.length, 7);
  assert.ok(result.every((record) => !record.ok && record.closed));
  assert.match(result[0].error!, /SyntaxError/);
  assert.equal(result[1].stdout, '');
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
    report: (record) => assertGone(record.stderr),
  });
  for (const record of result) {
    assert.equal(record.ok, true);
    assert.equal(record.stderr.length, 4096);
    // Sync retains full stderr internally; async tracks markers as it drains.
    assert.equal(record.phase, 'complete');
  }
});
