import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

// Real helper, complete Windows snapshots, no OS signals or native-pass claim.
for (const mode of [
  'older',
  'older-transitive',
  'fraction-older',
  'fraction-new',
  'equal',
  'new',
  'unknown-child',
  'unknown-parent-child',
  'unknown-parent-recovery',
  'mixed-unknown',
  'escaped',
  'root-reuse',
  'member-reuse',
  'late-child',
  'individual-kill',
  'kill-stalled',
]) {
  test(`Windows parent chronology: ${mode}`, () => {
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
      const birth = '2026-10-02T12:00:00.1234568Z';
      const older = mode === 'fraction-older' ? '2026-10-02T12:00:00.1234567Z' : '2026-10-02T11:00:00.0000000Z';
      const newer = '2026-10-02T12:00:00.1234569Z';
      assert.equal(Date.parse(birth), Date.parse(newer), 'precision control shares milliseconds');
      const root = { pid: 876541, exitCode: null, signalCode: null };
      const other = { pid: 876551, exitCode: null, signalCode: null };
      const unknown = mode.startsWith('unknown-') || mode === 'mixed-unknown';
      const stale = mode.startsWith('older') || mode === 'fraction-older';
      let rows = [
        { pid: root.pid, ppid: 1, start: birth },
        { pid: 876542, ppid: root.pid, start: unknown ? null : stale ? older : mode === 'equal' ? birth : newer },
        { pid: 876543, ppid: 1, start: null },
      ];
      if (mode === 'older-transitive' || mode.startsWith('unknown-parent'))
        rows.push({ pid: 876544, ppid: 876542, start: newer });
      const signals = [];
      cp.spawn = () => root;
      cp.execFile = (command, args, options, callback) => {
        assert.ok(options.timeout > 0 && options.timeout <= 100);
        if (command === 'powershell.exe')
          queueMicrotask(() => callback(null, { stdout: JSON.stringify(rows), stderr: '' }));
        else if (command === 'taskkill.exe') {
          const pid = Number(args[1]);
          assert.deepEqual(args, ['/PID', String(pid), '/F'], 'never delegate unverified recursive tree walks');
          assert.notEqual(pid, 876543);
          if (stale) assert.notEqual(pid, 876542);
          if (mode === 'older-transitive') assert.notEqual(pid, 876544);
          if (mode === 'root-reuse') assert.notEqual(pid, root.pid);
          if (mode === 'member-reuse') assert.notEqual(pid, 876542);
          signals.push(pid);
          if (mode === 'kill-stalled') {
            setTimeout(() => callback(null, { stdout: '', stderr: '' }), 5);
            return;
          }
          rows = rows.filter(row => row.pid !== pid);
          if (pid === other.pid) other.exitCode = 0;
          if (pid === root.pid) {
            root.exitCode = 0;
            if (mode === 'late-child') rows.push({ pid: 876544, ppid: 876542, start: newer });
          }
          queueMicrotask(() => callback(null, { stdout: '', stderr: '' }));
        } else throw new Error('Unexpected subprocess');
      };
      process.kill = () => { throw new Error('OS signals prohibited'); };
      const { AuditOwner, finishAudit } = await import(${JSON.stringify(helper)});
      const owner = new AuditOwner({ profile: 'chronology-fixture', executable: 'fixture', graceMs: 1, operationMs: 100, killMs: 100 });
      const launch = () => owner.launch(() => cp.spawn('fixture', [], { env: { CANOPY_USER_DATA: 'chronology-fixture' }, detached: false }));
      let primary;
      try { await launch(); owner.confirm(root); } catch (error) { primary = error; }
      const scope = owner.scopes[0];
      if (stale) {
        assert.equal(primary, undefined);
        assert.equal(scope.members.has(876542), false, 'older unrelated child never owned');
        assert.equal(scope.observed.has(876542), false, 'older unrelated child never observed');
        assert.equal(scope.members.has(876544), false);
        assert.equal(scope.observed.has(876544), false, 'stale subtree not followed transitively');
      } else if (unknown) {
        assert.match(primary.message, /Unestablished process creation identity/);
        assert.equal(scope.observed.has(876542), true);
        assert.equal(scope.members.has(876542), false);
        if (mode.startsWith('unknown-parent')) {
          assert.equal(scope.observed.has(876544), true);
          assert.equal(scope.members.has(876544), false, 'ownership cannot cross unknown ancestry');
        }
      } else assert.equal(primary, undefined);
      if (mode === 'mixed-unknown') {
        rows.push({ pid: other.pid, ppid: 1, start: birth });
        cp.spawn = () => other;
        await assert.rejects(launch(), /Expected exactly one verified audit launch/);
      }
      if (mode === 'escaped') { rows[1].ppid = 1; root.exitCode = 0; rows = rows.filter(row => row.pid !== root.pid); }
      if (mode === 'root-reuse') {
        root.exitCode = 0; rows[0].start = '2026-10-02T13:00:00.0000000Z';
        rows.push({ pid: 876545, ppid: root.pid, start: '2026-10-02T14:00:00.0000000Z' });
      }
      if (mode === 'member-reuse') rows[1].start = '2026-10-02T11:00:00.0000000Z';
      if (mode === 'unknown-parent-recovery') rows[1].start = newer;
      const uncertain = unknown && mode !== 'unknown-parent-recovery';
      let removed = false;
      const finish = () => finishAudit({ owner, removeProfile: async () => { removed = true; }, writeEvidence: async () => {} });
      const started = Date.now();
      const failure = await finish().then(() => null, error => error);
      assert.ok(failure instanceof AggregateError);
      if (mode === 'kill-stalled') {
        assert.ok(failure.errors.some(error => /Owned scope kill deadline expired/.test(error.message)));
        assert.ok(rows.some(row => row.pid === 876543), 'unrelated row survives stalled cleanup');
        assert.equal(removed, false);
        assert.ok(Date.now() - started < 1000, 'stalled termination is finite');
        assert.ok(signals.length > 0 && signals.every(pid => pid === root.pid));
        assert.equal(root.exitCode, null);
        process.exit(0);
      }
      assert.equal(removed, !uncertain);
      assert.ok(rows.some(row => row.pid === 876543), 'unrelated null row survives');
      if (uncertain) {
        assert.deepEqual(signals, mode === 'mixed-unknown' ? [other.pid] : []);
        root.exitCode = 0; rows = rows.filter(row => row.pid === 876543);
        await finish();
        assert.equal(removed, true, 'later complete absence recovers uncertainty');
      } else if (stale) assert.deepEqual(signals, [root.pid]);
      else if (mode === 'escaped' || mode === 'root-reuse') assert.deepEqual(signals, [876542]);
      else if (mode === 'member-reuse') assert.deepEqual(signals, [root.pid]);
      else assert.deepEqual(signals, mode === 'late-child' || mode === 'unknown-parent-recovery' ? [root.pid, 876542, 876544] : [root.pid, 876542]);
      if (mode === 'root-reuse') assert.ok(rows.some(row => row.pid === 876545), 'reused root new subtree survives');
    `,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
