import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

// Exercise the production helper in an isolated Node subprocess with modeled
// Windows APIs. No PowerShell/taskkill or unrelated OS process is signaled.
for (const mode of [
  'cold',
  'timeout',
  'syntax',
  'root-null',
  'descendant-null',
  'pid-reuse',
  'denied',
]) {
  test(`Windows lifecycle model: ${mode}`, () => {
    const helper = new URL('../tools/audit-lifecycle.mjs', import.meta.url)
      .href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import assert from 'node:assert/strict';
        import cp from 'node:child_process';
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const mode = ${JSON.stringify(mode)};
        const child = { pid: 876541, exitCode: null, signalCode: null };
        const executable = 'C:\\Fixture Path\\electron.exe';
        const birth = '2026-10-02T12:00:00.0000000Z';
        let rows = [
          { pid: child.pid, ppid: 1, start: mode === 'root-null' ? null : birth },
          { pid: 876542, ppid: child.pid, start: mode === 'descendant-null' ? null : birth },
          { pid: 876543, ppid: 1, start: null },
        ];
        const kills = [];
        let snapshots = 0;
        let failure;
        cp.spawn = () => child;
        cp.execFile = (command, args, options, callback) => {
          assert.ok(options.timeout > 0 && options.timeout <= 15000);
          if (command === 'powershell.exe') {
            // A source-sensitive transport regression, not a Windows execution claim.
            if (mode === 'cold') {
              assert.equal(args[2], '-EncodedCommand');
              const script = Buffer.from(args[3], 'base64').toString('utf16le');
              assert.ok(script.includes('ToString("o")'));
              assert.ok(script.includes('$ErrorActionPreference = "Stop"'));
            }
            const count = snapshots++;
            if (mode === 'timeout' || mode === 'syntax') {
              failure = Object.assign(new Error('Command failed: powershell.exe'), {
                code: mode === 'timeout' ? null : 1,
                killed: mode === 'timeout',
                signal: mode === 'timeout' ? 'SIGTERM' : null,
                stdout: mode === 'timeout' ? 'partial snapshot' : '',
                stderr: mode === 'syntax' ? 'ParserError: fixture' : '',
              });
              queueMicrotask(() => callback(failure));
            } else if (mode === 'cold' && count === 0) {
              // Success requires a budget exceeding the proven CI three-second timeout.
              assert.equal(options.timeout, 15000);
              setTimeout(() => callback(null, { stdout: JSON.stringify(rows), stderr: '' }), 3200);
            } else queueMicrotask(() => callback(null, { stdout: JSON.stringify(rows), stderr: '' }));
          } else if (command === 'taskkill.exe') {
            kills.push(args);
            if (mode === 'denied') {
              assert.deepEqual(args, ['/PID', '876541', '/F']);
              queueMicrotask(() => callback(new Error('taskkill denied')));
              return;
            }
            assert.deepEqual(args, ['/PID', '876542', '/F']);
            rows = rows.filter(row => row.pid !== 876542);
            queueMicrotask(() => callback(null, { stdout: '', stderr: '' }));
          } else throw new Error('Unexpected subprocess: ' + command);
        };
        const { AuditOwner, finishAudit } = await import(${JSON.stringify(helper)});
        const owner = new AuditOwner({ profile: 'model-profile', executable, graceMs: 1, killMs: 100 });
        let primary;
        try {
          await owner.launch(async () => cp.spawn('"' + executable + '" "--inspect=0"', [], {
            env: { CANOPY_USER_DATA: 'model-profile' }, detached: false, shell: true,
          }));
          owner.confirm(child);
        } catch (error) { primary = error; }
        let removed = false;
        if (mode === 'cold') {
          assert.equal(primary, undefined);
          await finishAudit({ owner, close: async () => { rows = rows.filter(row => row.pid === 876543); child.exitCode = 0; },
            removeProfile: async () => { removed = true; }, writeEvidence: async () => {} });
          assert.equal(removed, true);
          assert.equal(rows[0].pid, 876543);
          assert.deepEqual(kills, []);
        } else if (mode === 'denied') {
          assert.equal(primary, undefined);
          const original = new Error('original assertion');
          await assert.rejects(finishAudit({ owner, primary: original,
            removeProfile: async () => { removed = true; }, writeEvidence: async () => {} }),
            error => error.cause === original && error.errors[0] === original &&
              error.errors.some(detail => /taskkill denied/.test(detail.message)));
          assert.equal(removed, false);
          assert.equal(child.exitCode, null);
          assert.equal(rows.length, 3);
          assert.equal(kills.length, 1);
        } else if (mode === 'pid-reuse') {
          assert.equal(primary, undefined);
          child.exitCode = 0;
          rows[0] = { ...rows[0], start: '2026-10-02T12:00:09.0000000Z' };
          const result = await owner.shutdown(async () => {});
          assert.equal(result.terminated, true);
          assert.ok(result.errors.some(error => /forced shutdown/.test(error.message)));
          assert.deepEqual(rows.map(row => row.pid), [876541, 876543]);
          assert.equal(kills.length, 1);
        } else {
          assert.ok(primary);
          if (mode === 'timeout' || mode === 'syntax') {
            assert.equal(primary.cause, undefined);
            const details = JSON.parse(primary.message.slice(primary.message.indexOf('{')));
            assert.equal(details.timeoutMs, 15000);
            assert.equal(details.code, 'CHILD_ERROR');
            assert.equal(details.status, mode === 'syntax' ? 1 : null);
            for (const field of ['killed', 'signal']) assert.equal(details[field], failure[field]);
            assert.equal(details.stdoutBytes, Buffer.byteLength(failure.stdout));
            assert.equal(details.stderrBytes, Buffer.byteLength(failure.stderr));
            assert.equal(details.stdout, undefined);
            assert.equal(details.stderr, undefined);
          } else assert.match(primary.message, /Unestablished process creation identity/);
          await assert.rejects(finishAudit({ owner, primary,
            removeProfile: async () => { removed = true; }, writeEvidence: async () => {} }),
            error => error.cause === primary && error.errors[0] === primary);
          assert.equal(removed, false);
          assert.deepEqual(kills, []);
          assert.equal(child.exitCode, null);
        }
        console.log('PASS ' + mode + '; Windows logic model only');
      `,
      ],
      { encoding: 'utf8', timeout: 15000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
