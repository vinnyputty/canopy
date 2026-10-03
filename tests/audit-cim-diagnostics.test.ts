import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

for (const phase of [
  'startup-or-script-entry',
  'script-entry',
  'module-load',
  'query',
  'projection',
  'serialization',
]) {
  test(`CIM timeout diagnostics retain phase ${phase} and forbid profile removal`, () => {
    const helper =
      process.env.CANOPY_AUDIT_SOURCE ??
      new URL('../tools/audit-lifecycle.mjs', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import cp from 'node:child_process';
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const phase = ${JSON.stringify(phase)};
      const child = { pid: 876541, exitCode: null, signalCode: null };
      cp.spawn = () => child;
      let failure;
      cp.execFile = (command, args, options, callback) => {
        assert.equal(command, 'powershell.exe');
        assert.equal(options.timeout, 15000);
        failure = Object.assign(new Error('CIM timed out'), {
          code: null, killed: true, signal: 'SIGTERM', stdout: '',
          stderr: phase === 'startup-or-script-entry' ? '' : 'canopy-cim phase=script-entry\\ncanopy-cim phase=' + phase + ' elapsedMs=12000 rows=42 cpuMs=100 memoryBytes=1000 processors=2\\n',
        });
        queueMicrotask(() => callback(failure));
      };
      const { AuditOwner, finishAudit } = await import(${JSON.stringify(helper)});
      const owner = new AuditOwner({ profile: 'fixture', executable: 'node-fixture' });
      let primary;
      try { await owner.launch(async () => cp.spawn('node-fixture', [], { env: { CANOPY_USER_DATA: 'fixture' } })); }
      catch (error) { primary = error; }
      assert.equal(primary.cause, undefined);
      const evidence = JSON.parse(primary.message.slice(primary.message.indexOf('{')));
      assert.equal(evidence.phase, phase);
      assert.equal(evidence.timeoutMs, 15000);
      assert.equal(evidence.concurrentSnapshots, 1);
      assert.equal(evidence.observerPid, process.pid);
      assert.equal(evidence.stderrBytes, Buffer.byteLength(failure.stderr));
      assert.equal(evidence.stdoutBytes, 0);
      assert.equal(evidence.code, 'CHILD_ERROR');
      assert.equal(evidence.killed, true);
      assert.equal(evidence.signal, 'SIGTERM');
      let removed = false;
      await assert.rejects(finishAudit({ owner, primary,
        removeProfile: async () => { removed = true; }, writeEvidence: async () => {} }),
        error => error.cause === primary && error.errors[0] === primary);
      assert.equal(removed, false);
      console.log('PASS diagnostic model, not native Windows: ' + phase);
    `,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
