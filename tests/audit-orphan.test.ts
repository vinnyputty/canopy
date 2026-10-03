import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

// Complete snapshot/taskkill models in separate Node processes, with no OS signals.
for (const mode of [
  'orphan-null',
  'orphan-empty',
  'orphan-malformed',
  'orphan-invalid-date',
  'recheck-descendant-null',
  'initial-root-null-orphan',
  'initial-root-null-absence',
  'partial-sibling-recovery',
  'initial-null-orphan',
  'initial-null-valid-orphan',
  'mixed-orphan-null',
  'recovery-known',
  'recovery-absence',
  'recovery-reuse',
  'initial-null-absence',
  'initial-null-ancestry-recovery',
  'valid-orphan',
  'reuse-orphan',
  'absent-orphan',
  'malformed-root',
  'malformed-descendant',
]) {
  test(`Orphan identity model: ${mode}`, () => {
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
      const birth = '2026-10-02T12:00:00.0000000Z';
      const reused = '2026-10-02T13:00:00.0000000Z';
      const child = { pid: 876541, exitCode: null, signalCode: null };
      const other = { pid: 876551, exitCode: null, signalCode: null };
      let rows = [
        { pid: child.pid, ppid: 1, start: mode.startsWith('initial-root-null') ? null : mode === 'malformed-root' ? 'garbage' : birth },
        { pid: 876542, ppid: child.pid, start: mode.startsWith('initial-null') || mode === 'partial-sibling-recovery' ? null : mode === 'malformed-descendant' ? 'garbage' : birth },
        { pid: 876543, ppid: 1, start: null },
      ];
      if (mode === 'partial-sibling-recovery') rows.push({ pid: 876544, ppid: child.pid, start: birth });
      const kills = [];
      let rechecks = 0;
      let rechecking = false;
      cp.spawn = () => child;
      cp.execFile = (command, args, options, callback) => {
        assert.ok(options.timeout > 0 && options.timeout <= 100);
        if (command === 'powershell.exe') {
          if (rechecking && ++rechecks === 4) rows.find(row => row.pid === 876542).start = null;
          queueMicrotask(() => callback(null, { stdout: JSON.stringify(rows), stderr: '' }));
        }
        else if (command === 'taskkill.exe') {
          const pid = Number(args[1]);
          kills.push(pid);
          assert.notEqual(pid, 876543, 'unrelated null-birth process cannot be signaled');
          rows = rows.filter(row => row.pid !== pid);
          if (pid === child.pid) child.exitCode = 0;
          if (pid === other.pid) other.exitCode = 0;
          queueMicrotask(() => callback(null, { stdout: '', stderr: '' }));
        } else throw new Error('Unexpected subprocess');
      };
      const { AuditOwner, finishAudit } = await import(${JSON.stringify(helper)});
      const owner = new AuditOwner({ profile: 'fixture-profile', executable: 'fixture', graceMs: 1, killMs: 100, operationMs: 100 });
      const launch = () => owner.launch(async () => cp.spawn('fixture', [], { env: { CANOPY_USER_DATA: 'fixture-profile' }, detached: false }));
      let primary;
      try { await launch(); owner.confirm(child); } catch (error) { primary = error; }
      if (mode.startsWith('initial-') || mode.startsWith('malformed') || mode === 'partial-sibling-recovery') assert.ok(primary, 'invalid initial birth must reject');
      else assert.equal(primary, undefined);
      let removed = false;
      const finish = async (close) => {
        let error;
        try { await finishAudit({ owner, primary, close, removeProfile: async () => { removed = true; }, writeEvidence: async () => {} }); }
        catch (failure) { error = failure; }
        if (primary) assert.ok(error === primary || error?.cause === primary, 'original launch error remains primary');
        assert.ok(rows.some(row => row.pid === 876543), 'unrelated null row must survive');
        return error;
      };
      const descendant = () => rows.find(row => row.pid === 876542);
      if (mode === 'recheck-descendant-null') {
        rechecking = true;
        assert.ok(await finish());
        assert.equal(removed, false);
        assert.deepEqual(kills, []);
        assert.equal(child.exitCode, null);
        assert.ok(descendant());
      } else if (mode === 'initial-null-ancestry-recovery') {
        descendant().start = birth;
        await finish(async () => { child.exitCode = 0; rows = rows.filter(row => row.pid === 876543); });
        assert.equal(removed, true, 'valid ancestry can establish a previously unknown birth before normal close');
        assert.deepEqual(kills, []);
      } else if (mode.startsWith('malformed')) {
        assert.ok(await finish());
        assert.equal(removed, false);
        assert.deepEqual(kills, []);
      } else {
        child.exitCode = 0;
        rows = rows.filter(row => row.pid !== child.pid);
        if (mode === 'orphan-empty') descendant().start = '';
        else if (mode === 'orphan-malformed') descendant().start = 'not-a-date';
        else if (mode === 'orphan-invalid-date') descendant().start = '2026-02-30T12:00:00.0000000Z';
        else if (mode === 'initial-null-valid-orphan') descendant().start = birth;
        else if (mode === 'reuse-orphan') descendant().start = reused;
        else if (mode === 'absent-orphan' || mode === 'initial-null-absence' || mode === 'initial-root-null-absence' || mode === 'partial-sibling-recovery') rows = rows.filter(row => row.pid !== 876542);
        else if (mode !== 'valid-orphan') descendant().start = null;
        if (mode === 'mixed-orphan-null') {
          cp.spawn = () => other;
          rows.push({ pid: other.pid, ppid: 1, start: birth });
          await assert.rejects(launch());
        }
        const failure = await finish();
        if (['valid-orphan', 'reuse-orphan', 'absent-orphan', 'initial-null-absence', 'initial-root-null-absence', 'partial-sibling-recovery'].includes(mode)) {
          assert.equal(removed, true);
          assert.deepEqual(kills, mode === 'valid-orphan' ? [876542] : mode === 'partial-sibling-recovery' ? [876544] : []);
          if (mode === 'reuse-orphan') assert.equal(descendant().start, reused);
        } else {
          assert.ok(failure, 'uncertain orphan must fail finalization');
          assert.equal(removed, false, 'uncertain orphan must retain shared profile');
          assert.deepEqual(kills, mode === 'mixed-orphan-null' ? [other.pid] : []);
          assert.ok(descendant(), 'uncertain orphan stays live and untouched');
          if (mode === 'mixed-orphan-null') assert.equal(other.exitCode, 0);
          if (mode.startsWith('recovery')) {
            if (mode === 'recovery-known') descendant().start = birth;
            if (mode === 'recovery-reuse') descendant().start = reused;
            if (mode === 'recovery-absence') rows = rows.filter(row => row.pid !== 876542);
            await finish();
            assert.equal(removed, true, 'later verified evidence can resolve uncertainty');
            assert.deepEqual(kills, mode === 'recovery-known' ? [876542] : []);
            if (mode === 'recovery-reuse') assert.equal(descendant().start, reused);
          }
        }
      }
      console.log('PASS ' + mode + '; modeled Windows rows, no OS signals');
    `,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
