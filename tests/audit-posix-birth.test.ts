import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

// Escaped retained descendants: ps-shaped invalid tokens cannot prove PID reuse.
for (const [mode, birth] of Object.entries({
  'impossible-day': 'Fri Feb 30 12:00:00 2026',
  'non-leap-day': 'Sun Feb 29 12:00:00 2026',
  'century-non-leap': 'Mon Feb 29 12:00:00 2100',
  'short-month': 'Fri Apr 31 12:00:00 2026',
  'zero-day': 'Fri Oct  0 12:00:00 2026',
  'invalid-hour': 'Fri Oct  2 24:00:00 2026',
  'invalid-minute': 'Fri Oct  2 12:60:00 2026',
  'invalid-second': 'Fri Oct  2 12:00:61 2026',
  'wrong-weekday': 'Thu Oct  2 12:00:00 2026',
  'valid-reuse': 'Fri Oct  2 13:00:00 2026',
  'valid-leap-reuse': 'Thu Feb 29 12:00:00 2024',
  'valid-century-leap-reuse': 'Tue Feb 29 12:00:00 2000',
  absence: '',
})) {
  test(`POSIX orphan birth: ${mode}`, () => {
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
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const birth = ${JSON.stringify(birth)};
      const mode = ${JSON.stringify(mode)};
      const original = 'Fri Oct  2 12:00:00 2026';
      const child = { pid: 778001, exitCode: null, signalCode: null };
      const unrelated = '778003 1 778003 S garbage';
      let rows = [
        '778001 1 778001 S ' + original,
        '778002 778001 778001 S ' + original,
        unrelated,
      ];
      cp.spawn = () => child;
      cp.execFile = (command, args, options, callback) => {
        assert.equal(command, 'ps');
        assert.deepEqual(args, ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=']);
        assert.equal(options.env.LC_ALL, 'C');
        assert.ok(options.timeout > 0 && options.timeout <= 100);
        queueMicrotask(() => callback(null, { stdout: rows.join('\\n'), stderr: '' }));
      };
      const signals = [];
      process.kill = (...args) => {
        signals.push(args);
        throw new Error('OS signals prohibited in model');
      };
      const { AuditOwner, finishAudit } = await import(${JSON.stringify(helper)});
      const owner = new AuditOwner({
        profile: 'posix-fixture', executable: 'fixture', graceMs: 1,
        operationMs: 100, killMs: 100, signalGroup: process.kill,
      });
      await owner.launch(() => cp.spawn('fixture', [], {
        env: { CANOPY_USER_DATA: 'posix-fixture' }, detached: true,
      }));
      owner.confirm(child);
      child.exitCode = 0;
      rows = mode === 'absence' ? [unrelated] : ['778002 1 778010 S ' + birth, unrelated];
      let removed = false;
      const finish = (close) => finishAudit({
        owner, close,
        removeProfile: async () => { removed = true; },
        writeEvidence: async () => {},
      });
      if (mode.startsWith('valid-') || mode === 'absence') {
        await finish();
        assert.equal(removed, true);
        assert.equal(rows.length, mode === 'absence' ? 1 : 2, 'valid replacement stays untouched');
      } else {
        await assert.rejects(finish(), /Unestablished process creation identity/);
        assert.equal(removed, false, 'uncertain live orphan retains shared profile');
        assert.equal(rows.length, 2, 'uncertain orphan stays untouched');
        // A later exact original token establishes ownership again, then a
        // successful complete absence permits normal removal without signaling.
        rows[0] = '778002 1 778010 S ' + original;
        await finish(async () => { rows = [unrelated]; });
        assert.equal(removed, true);
      }
      assert.ok(rows.includes(unrelated));
      assert.deepEqual(signals, []);
    `,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
