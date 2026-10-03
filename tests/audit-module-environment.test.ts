import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

for (const spelling of ['PSModulePath', 'PSMODULEPATH', 'psmodulepath']) {
  test(`Windows PowerShell child isolates inherited ${spelling} without changing ownership`, () => {
    const helper =
      process.env.CANOPY_MODULE_SOURCE ??
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
      const key = ${JSON.stringify(spelling)};
      process.env[key] = 'fixture-incompatible-PowerShell-7-modules';
      process.env.CANOPY_CONTROL_SENTINEL = 'retained';
      const child = { pid: 876541, exitCode: null, signalCode: null };
      const birth = '2026-10-02T12:00:00.1234567Z';
      let live = true;
      let snapshots = 0;
      cp.spawn = () => child;
      cp.execFile = (command, args, options, callback) => {
        assert.equal(command, 'powershell.exe', 'no signals or alternate provider');
        assert.equal(options.timeout, 15000);
        const env = options.env ?? process.env;
        snapshots++;
        if (Object.keys(env).some(k => k.toUpperCase() === 'PSMODULEPATH')) {
          const error = Object.assign(new Error('modeled incompatible module discovery'), {
            code: null, killed: true, signal: 'SIGTERM', stdout: '', stderr: 'canopy-cim phase=module-load',
          });
          queueMicrotask(() => callback(error));
        } else {
          assert.equal(env.CANOPY_CONTROL_SENTINEL, 'retained');
          assert.equal(process.env[key], 'fixture-incompatible-PowerShell-7-modules');
          queueMicrotask(() => callback(null, { stdout: JSON.stringify(live
            ? [{ pid: child.pid, ppid: 1, start: birth }]
            : [{ pid: 876542, ppid: 1, start: null }]), stderr: '' }));
        }
      };
      const { AuditOwner, finishAudit } = await import(${JSON.stringify(helper)});
      const owner = new AuditOwner({ profile: 'fixture-profile', executable: 'fixture-node' });
      await owner.launch(async () => cp.spawn('fixture-node', [], { env: { CANOPY_USER_DATA: 'fixture-profile' } }));
      owner.confirm(child);
      let removed = false;
      await finishAudit({ owner,
        close: async () => { live = false; child.exitCode = 0; },
        removeProfile: async () => { removed = true; }, writeEvidence: async () => {} });
      assert.equal(removed, true);
      assert.ok(snapshots >= 2);
      assert.equal(process.env[key], 'fixture-incompatible-PowerShell-7-modules');
      console.log('PASS environment compatibility model only: ' + key);
    `,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
