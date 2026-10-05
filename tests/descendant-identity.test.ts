import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { test } from 'node:test';
import {
  assertDescendantAbsent,
  captureDescendantIdentity,
  readDescendantSnapshot,
} from './fixtures/descendant-identity';
import { windowsSnapshotScript } from '../tools/audit-lifecycle.mjs';

const start = '2026-10-02T12:00:00.1234567Z';
const replacement = '2026-10-02T12:00:00.1234568Z';
const parent = () => ({
  pid: 876541,
  exitCode: null as number | null,
  signalCode: null as NodeJS.Signals | null,
});
const root = { pid: 876541, ppid: 1, start };
const descendant = { pid: 876542, ppid: root.pid, start };
const unrelated = { pid: 876543, ppid: 1, start: null };

test('independent descendant assertion rejects the original birth and preserves a full-birth PID replacement', async () => {
  const original = await captureDescendantIdentity(
    parent(),
    descendant.pid,
    async () => [root, descendant, unrelated],
  );
  await assert.rejects(
    assertDescendantAbsent(original, async () => [descendant, unrelated]),
    /Original descendant remains live/,
  );
  // Full tokens differ below Date's millisecond precision; do not truncate them.
  assert.equal(Date.parse(start), Date.parse(replacement));
  const rows = [unrelated, { ...descendant, ppid: 1, start: replacement }];
  const before = structuredClone(rows);
  await assertDescendantAbsent(original, async () => rows);
  assert.deepEqual(rows, before);
  await assertDescendantAbsent(original, async () => [unrelated]);
});

test('missing, malformed, ambiguous and failed independent observations never prove descendant absence', async () => {
  const original = await captureDescendantIdentity(
    parent(),
    descendant.pid,
    async () => [root, descendant],
  );
  for (const snapshot of [
    null,
    undefined,
    [],
    {},
    'partial',
    [{ ...descendant, start: null }],
    [{ pid: descendant.pid, ppid: 1 }],
    [{ ...descendant, start: '2026-02-30T12:00:00.1234567Z' }],
    [{ ...descendant, start: '2026-10-02T12:00:00.123Z' }],
    [{ ...descendant, start: '2026-10-02T12:00:00.1234566Z' }],
    [descendant, { ...descendant, start: replacement }],
    [unrelated, { pid: 'bad', ppid: 1, start }],
  ])
    await assert.rejects(
      assertDescendantAbsent(original, async () => snapshot),
    );
  const fault = new Error('independent reader failed');
  await assert.rejects(
    assertDescendantAbsent(original, async () => {
      throw fault;
    }),
    (error) => error === fault,
  );
});

test('identity capture requires the live original parent, its relation and complete births', async () => {
  for (const snapshot of [
    [unrelated],
    [root],
    [descendant],
    [{ ...root, start: null }, descendant],
    [root, { ...descendant, start: null }],
    [root, { ...descendant, ppid: 1 }],
    [root, { ...descendant, start: '2026-10-02T11:00:00.1234567Z' }],
    [root, descendant, descendant],
  ])
    await assert.rejects(
      captureDescendantIdentity(parent(), descendant.pid, async () => snapshot),
    );
  const exited = parent();
  exited.exitCode = 0;
  await assert.rejects(
    captureDescendantIdentity(exited, descendant.pid, async () => [
      root,
      descendant,
    ]),
    /Original parent must remain live/,
  );
  const closing = parent();
  await assert.rejects(
    captureDescendantIdentity(closing, descendant.pid, async () => {
      closing.exitCode = 0;
      return [root, descendant];
    }),
    /Original parent must remain live/,
  );
});

test('independent reader uses the exact shared query, original operation limit and sanitized environment', async (t) => {
  let failure: Error | undefined;
  let stdout = JSON.stringify([root, descendant]);
  let calls = 0;
  t.mock.method(
    childProcess,
    'execFile',
    (
      command: string,
      args: readonly string[],
      options: childProcess.ExecFileOptions,
      callback: (
        error: Error | undefined,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      calls++;
      assert.equal(command, 'powershell.exe');
      assert.deepEqual(args.slice(0, 3), [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
      ]);
      assert.equal(
        Buffer.from(args[3], 'base64').toString('utf16le'),
        windowsSnapshotScript(),
      );
      assert.equal(options.timeout, 15000);
      assert.equal(options.maxBuffer, 16 * 1024 * 1024);
      assert.equal(options.windowsHide, true);
      assert.ok(options.env);
      assert.ok(
        !Object.keys(options.env).some(
          (key) => key.toUpperCase() === 'PSMODULEPATH',
        ),
      );
      queueMicrotask(() => callback(failure, stdout, ''));
    },
  );
  assert.deepEqual(await readDescendantSnapshot(15000, 'win32'), [
    root,
    descendant,
  ]);
  stdout = 'partial JSON';
  await assert.rejects(readDescendantSnapshot(15000, 'win32'), SyntaxError);
  failure = new Error('CIM snapshot timeout');
  await assert.rejects(
    readDescendantSnapshot(15000, 'win32'),
    (error) => error === failure,
  );
  assert.equal(calls, 3, 'one query per observation; no readiness retries');
});

test('POSIX independent observation retains complete calendar births and rejects partial ps output', async (t) => {
  const first = 'Fri Oct  2 12:00:00 2026';
  let stdout = `876541 1 876541 S ${first}\n876542 876541 876541 S ${first}\n`;
  t.mock.method(
    childProcess,
    'execFile',
    (
      command: string,
      args: readonly string[],
      options: childProcess.ExecFileOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      assert.equal(command, 'ps');
      assert.deepEqual(args, ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=']);
      assert.equal(options.timeout, 3000);
      assert.equal(options.env?.LC_ALL, 'C');
      queueMicrotask(() => callback(null, stdout, ''));
    },
  );
  const snapshot = () => readDescendantSnapshot(3000, 'darwin');
  const original = await captureDescendantIdentity(
    parent(),
    descendant.pid,
    snapshot,
  );
  await assert.rejects(
    assertDescendantAbsent(original, snapshot),
    /Original descendant remains live/,
  );
  // Calendar ordering crosses weekday and month boundaries.
  stdout = '876542 1 876542 S Sun Nov  1 12:00:00 2026\n';
  await assertDescendantAbsent(original, snapshot);
  stdout = '876542 1 876542 S Fri Oct 32 12:00:00 2026\n';
  await assert.rejects(assertDescendantAbsent(original, snapshot));
  stdout = 'partial ps';
  await assert.rejects(assertDescendantAbsent(original, snapshot));
  // Missing original PID proves absence only after every ps row is complete.
  for (const birth of [
    'Fri Oct',
    'Fri Oct 32 12:00:00 2026',
    'Fri Oct  2 25:00:00 2026',
    'Sat Oct  2 12:00:00 2026',
    start,
  ]) {
    stdout = `876543 1 876543 S ${birth}\n`;
    await assert.rejects(assertDescendantAbsent(original, snapshot));
  }
  stdout = `876543 1 876543 S ${first}\n`;
  await assertDescendantAbsent(original, snapshot);
});
