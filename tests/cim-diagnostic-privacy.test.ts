import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { inspect, promisify } from 'node:util';
import { runInNewContext } from 'node:vm';

const moduleControl = import(
  process.env.CANOPY_CIM_MODULE_SOURCE ??
    new URL('../tools/windows-cim-control.mjs', import.meta.url).href
);
const source = readFileSync(
  process.env.CANOPY_AUDIT_PRIVACY_SOURCE ??
    new URL('../tools/audit-lifecycle.mjs', import.meta.url),
  'utf8',
);
const body = source.slice(
  source.indexOf('async function processes('),
  source.indexOf('\nfunction validBirth('),
);
const sentinel = 'PRIVATE_FIXTURE_PATH_TOKEN';
const phases = [
  'script-entry',
  'module-load',
  'query',
  'projection',
  'serialization',
  'complete',
];
const execFile = promisify(execFileCallback);

function snapshot(transport: (...args: unknown[]) => Promise<unknown>) {
  return runInNewContext(`let activeCimSnapshots = 0; ${body}; processes`, {
    execFile: transport,
    windowsSnapshotScript: () => 'unchanged snapshot',
    powershellEnvironment: () => ({}),
    hostCpuTimes: () => ({ total: 0, idle: 0 }),
    freemem: () => 1,
    totalmem: () => 2,
    process: {
      platform: 'win32',
      pid: process.pid,
      cpuUsage: () => ({ user: 0, system: 0 }),
      memoryUsage: () => ({ rss: 1 }),
    },
    Buffer,
  }) as (ms: number) => Promise<unknown>;
}
function privateFailure(phase: string) {
  return Object.assign(new Error(sentinel, { cause: new Error(sentinel) }), {
    code: 'ETIMEDOUT',
    killed: true,
    signal: 'SIGTERM',
    stdout: sentinel,
    stderr: `${sentinel}\ncanopy-cim phase=${phase}\n`,
  });
}
function safe(value: unknown) {
  for (const text of [
    String(value),
    inspect(value, { depth: null }),
    JSON.stringify(value),
  ])
    assert.ok(
      !text?.includes(sentinel),
      'diagnostic leaked fixture private bytes',
    );
}

for (const phase of [
  ...phases,
  sentinel,
  'module-load-PRIVATE_FIXTURE_PATH_TOKEN',
]) {
  test(`snapshot and module records keep only fixed phase ${phases.includes(phase) ? phase : 'unknown'} diagnostics`, async () => {
    const fault = privateFailure(phase);
    const reports: unknown[] = [];
    const rows = (await moduleControl).runCimModuleControls({
      report: (r: unknown) => reports.push(r),
      spawn: () => ({
        error: fault,
        status: null,
        signal: 'SIGTERM',
        stdout: fault.stdout,
        stderr: fault.stderr,
      }),
    });
    safe(reports);
    for (const row of rows) {
      assert.equal(
        row.phase,
        phases.includes(phase) ? phase : 'startup-or-script-entry',
      );
      assert.equal(row.code, 'ETIMEDOUT');
      assert.equal(row.signal, 'SIGTERM');
      assert.equal(row.stdoutBytes, Buffer.byteLength(fault.stdout));
      assert.equal(row.stderrBytes, Buffer.byteLength(fault.stderr));
      assert.equal(row.ok, false);
    }
    await assert.rejects(
      snapshot(async () => {
        throw fault;
      })(15000),
      (error: unknown) => {
        safe(error);
        const e = error as Error;
        assert.equal(e.cause, undefined);
        const record = JSON.parse(e.message.slice(e.message.indexOf('{')));
        assert.equal(
          record.phase,
          phases.includes(phase) ? phase : 'startup-or-script-entry',
        );
        assert.equal(record.code, 'ETIMEDOUT');
        assert.equal(record.signal, 'SIGTERM');
        assert.equal(record.killed, true);
        assert.equal(record.stdoutBytes, Buffer.byteLength(fault.stdout));
        assert.equal(record.stderrBytes, Buffer.byteLength(fault.stderr));
        assert.equal(record.timeoutMs, 15000);
        return true;
      },
    );
  });
}

for (const fault of [undefined, null, false, 0, '', privateFailure(sentinel)]) {
  test(`snapshot and module controls fail safely for ${fault instanceof Error ? 'private error' : String(fault)} child failures`, async () => {
    if (fault instanceof Error)
      Object.assign(fault, {
        code: sentinel,
        signal: sentinel,
        killed: sentinel,
      });
    const rows = (await moduleControl).runCimModuleControls({
      report: () => {},
      spawn: () => ({
        status: 0,
        signal: sentinel,
        error: fault,
        stdout: '{"pid":1,"ppid":0,"start":null}',
        stderr: sentinel,
      }),
    });
    safe(rows);
    assert.ok(
      rows.every(
        (r: { ok: boolean; code: string; signal: null }) =>
          !r.ok && r.code === 'CHILD_ERROR' && r.signal === null,
      ),
    );
    await assert.rejects(
      snapshot(async () => {
        throw fault;
      })(15000),
      (error: unknown) => {
        safe(error);
        return String(error).startsWith('Error: CIM process snapshot failed:');
      },
    );
  });
}

for (const stdout of [
  sentinel,
  `{"pid":"${sentinel}","ppid":0,"start":null}`,
]) {
  test('snapshot and module parse/schema failures hide input and parsing exception text', async () => {
    const rows = (await moduleControl).runCimModuleControls({
      report: () => {},
      spawn: () => ({ status: 0, signal: null, stdout, stderr: sentinel }),
    });
    safe(rows);
    assert.ok(
      rows.every(
        (r: { ok: boolean; error: string }) =>
          !r.ok && r.error === 'INVALID_SNAPSHOT_JSON_OR_SCHEMA',
      ),
    );
    await assert.rejects(
      snapshot(async () => ({ stdout }))(15000),
      (error: unknown) => {
        safe(error);
        return String(error).includes('Invalid CIM');
      },
    );
  });
}

test('snapshot and module success preserve raw full-fraction identity internally without logging rows', async () => {
  const start = '2026-10-03T00:00:00.1234567Z';
  const stdout = JSON.stringify([{ pid: 1, ppid: 0, start }]);
  const rows = await snapshot(async () => ({ stdout }))(15000);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    { pid: 1, ppid: 0, start, pgid: 0, zombie: false },
  ]);
  const records = (await moduleControl).runCimModuleControls({
    report: () => {},
    spawn: () => ({
      status: 0,
      signal: null,
      stdout,
      stderr: 'canopy-cim phase=complete',
    }),
  });
  assert.ok(
    records.every(
      (r: { ok: boolean; rows: number; phase: string }) =>
        r.ok && r.rows === 1 && r.phase === 'complete',
    ),
  );
  assert.ok(!JSON.stringify(records).includes(start));
});

test('actual owned Node nonzero and malformed output stay private at the snapshot error boundary', async () => {
  for (const fail of [true, false]) {
    const operation = snapshot(async () =>
      execFile(
        process.execPath,
        [
          '-e',
          `console.log(${JSON.stringify(sentinel)}); console.error(${JSON.stringify(sentinel)}); process.exit(${fail ? 23 : 0});`,
        ],
        { timeout: 2000 },
      ),
    );
    await assert.rejects(operation(15000), (error: unknown) => {
      safe(error);
      return true;
    });
  }
  const rows = (await moduleControl).runCimModuleControls({
    report: () => {},
    spawn: () => ({
      status: 23,
      signal: null,
      stdout: sentinel,
      stderr: sentinel,
    }),
  });
  safe(rows);
  assert.ok(
    rows.every(
      (r: { status: number; error: string }) =>
        r.status === 23 && r.error === 'NONZERO_EXIT',
    ),
  );
});
