import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

// Complete Windows snapshot models, actual disposable profile sentinel, and
// intercepted individual taskkill. Fake PIDs never authorize OS signals.
for (const mode of [
  'forced-root',
  'forced-root-null',
  'forced-root-empty',
  'forced-member',
  'forced-member-null',
  'spontaneous-root',
  'spontaneous-root-null',
  'spontaneous-member',
  'spontaneous-member-null',
  'spontaneous-member-malformed',
  'root-reuse-before',
  'root-reuse-before-null',
  'root-reuse-after',
  'member-reuse-before',
  'member-reuse-before-null',
  'member-reuse-after',
  'replacement-child',
  'departed-replacement-child',
  'older-child',
  'absence',
  'late-chain',
  'late-null-chain',
  'mixed-scopes',
]) {
  test(`Late Windows parent: ${mode}`, () => {
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
      import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const mode = ${JSON.stringify(mode)};
      const birth = '2026-10-02T12:00:00.1234568Z';
      const memberBirth = '2026-10-02T12:00:00.1234569Z';
      const lateBirth = '2026-10-02T12:00:00.1234570Z';
      const reuseBirth = '2026-10-02T12:00:00.1234571Z';
      const newBirth = '2026-10-02T12:00:00.1234572Z';
      assert.equal(Date.parse(birth), Date.parse(newBirth), 'chronology requires full fractional precision');
      const root = { pid: 980001, exitCode: null, signalCode: null };
      const other = { pid: 980010, exitCode: null, signalCode: null };
      const hasMember = mode.includes('member');
      const parentPid = hasMember ? 980002 : root.pid;
      const unrelated = { pid: 980099, ppid: 1, start: null };
      const row = (pid, ppid, start) => ({ pid, ppid, start });
      let rows = [row(root.pid, 1, birth), unrelated];
      if (hasMember) rows.push(row(parentPid, root.pid, memberBirth));
      const late = () => row(980004, parentPid, mode.endsWith('-empty') ? '' : mode.endsWith('-malformed') ? 'garbage' : mode.endsWith('-null') || mode === 'late-null-chain' ? null : lateBirth);
      const kills = [];
      cp.spawn = () => root;
      process.kill = () => { throw new Error('OS signals prohibited'); };
      cp.execFile = (command, args, options, callback) => {
        assert.ok(options.timeout > 0 && options.timeout <= 100);
        if (command === 'powershell.exe')
          queueMicrotask(() => callback(null, { stdout: JSON.stringify(rows), stderr: '' }));
        else {
          assert.equal(command, 'taskkill.exe');
          const pid = Number(args[1]);
          assert.deepEqual(args, ['/PID', String(pid), '/F']);
          assert.ok([root.pid, parentPid, other.pid].includes(pid), 'ambiguous descendants/replacements cannot be signaled');
          assert.notEqual(pid, unrelated.pid);
          kills.push(pid);
          rows = rows.filter(row => row.pid !== pid);
          if (pid === root.pid) root.exitCode = 0;
          if (pid === other.pid) other.exitCode = 0;
          if (mode.startsWith('forced-') && pid === parentPid) rows.push(late());
          queueMicrotask(() => callback(null, { stdout: '', stderr: '' }));
        }
      };
      const { AuditOwner, finishAudit } = await import(${JSON.stringify(helper)});
      const profile = await mkdtemp(join(tmpdir(), 'canopy-late-parent-'));
      try {
        await writeFile(join(profile, 'sentinel'), 'live writer');
        const owner = new AuditOwner({ profile, executable: 'fixture', graceMs: 1, operationMs: 100, killMs: 100 });
        const launch = () => owner.launch(() => cp.spawn('fixture', [], { env: { CANOPY_USER_DATA: profile }, detached: false }));
        await launch(); owner.confirm(root);
        const scope = owner.scopes[0];
        if (!mode.startsWith('forced-')) {
          root.exitCode = 0;
          rows = rows.filter(row => row.pid === unrelated.pid);
          if (mode === 'older-child') rows.push(row(980004, parentPid, '2026-10-02T12:00:00.1234567Z'), row(980006, 980004, newBirth));
          else if (mode !== 'absence') rows.push(late());
        }
        if (mode.includes('reuse-before')) rows.push(row(parentPid, 1, reuseBirth));
        if (mode === 'replacement-child' || mode === 'departed-replacement-child') {
          rows = [unrelated, row(root.pid, 1, reuseBirth), row(980004, root.pid, newBirth)];
          await scope.live();
          if (mode === 'departed-replacement-child') rows = rows.filter(row => row.pid !== root.pid);
        }
        if (mode.includes('reuse-after')) {
          await assert.rejects(scope.live(), /Unestablished process creation identity/);
          rows.push(row(parentPid, 1, reuseBirth), row(980005, parentPid, newBirth));
        }
        if (mode === 'late-chain' || mode === 'late-null-chain') {
          await assert.rejects(scope.live(), /Unestablished process creation identity/);
          rows = [unrelated, row(980006, 980004, newBirth)];
        }
        if (mode === 'mixed-scopes') {
          rows.push(row(other.pid, 1, birth));
          cp.spawn = () => other;
          await assert.rejects(launch(), /Expected exactly one verified audit launch/);
        }
        let removed = false;
        const finish = () => finishAudit({ owner,
          removeProfile: async () => { removed = true; await rm(profile, { recursive: true, force: true }); },
          writeEvidence: async () => {},
        });
        const safe = ['older-child', 'absence', 'replacement-child', 'departed-replacement-child'].includes(mode);
        if (safe) {
          await finish();
          assert.equal(removed, true);
          await assert.rejects(access(profile));
          assert.deepEqual(kills, []);
          assert.equal(scope.observed.has(980004), false);
          assert.equal(scope.observed.has(980006), false, 'older unrelated subtree stays excluded');
        } else {
          await assert.rejects(finish(), error => error instanceof AggregateError &&
            error.errors.some(detail => /Unestablished process creation identity/.test(detail.message)));
          assert.equal(removed, false, 'first-seen live descendant retains profile');
          assert.equal(await readFile(join(profile, 'sentinel'), 'utf8'), 'live writer');
          const latePid = mode.includes('chain') ? 980006 : 980004;
          assert.equal(scope.observed.has(latePid), true);
          assert.equal(scope.members.has(latePid), false, 'historical ancestry never grants kill ownership');
          assert.ok(rows.some(row => row.pid === latePid));
          assert.deepEqual(kills, mode.startsWith('forced-') ? hasMember ? [root.pid, parentPid] : [root.pid] : mode === 'mixed-scopes' ? [other.pid] : []);
          const previousKills = [...kills];
          // A complete later snapshot proves all ambiguous descendants absent.
          // Keep known replacement parents/new children: they remain unrelated.
          rows = rows.filter(row => row.pid === unrelated.pid ||
            mode.includes('reuse') && [parentPid, 980005].includes(row.pid));
          await finish();
          assert.equal(removed, true, 'complete absence resolves uncertainty');
          assert.deepEqual(kills, previousKills, 'recovery does not signal replacements');
          await assert.rejects(access(profile));
        }
        assert.ok(rows.some(row => row.pid === unrelated.pid));
      } finally {
        // Only this model's unique filesystem fixture; all process rows are fake.
        await rm(profile, { recursive: true, force: true });
      }
    `,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
