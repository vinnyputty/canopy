import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import {
  powershellEnvironment,
  windowsSnapshotScript,
} from '../../tools/audit-lifecycle.mjs';

type Identity = { pid: number; ppid: number; start: string };
type Snapshot = () => Promise<unknown>;

// Query-only fixture evidence, independent of AuditOwner's retained scope.
// Keep the complete shared CIM query/seven-digit UTC tokens on Windows and
// the shared LC_ALL=C ps fields on POSIX. Equal ps births remain a failure.
export async function readDescendantSnapshot(
  operationMs: number,
  platform = process.platform,
) {
  if (platform !== 'win32') {
    const stdout = await new Promise<string>((resolve, reject) =>
      childProcess.execFile(
        'ps',
        ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='],
        {
          timeout: operationMs,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, LC_ALL: 'C' },
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    );
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const match = line
          .trim()
          .match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        assert.ok(match, 'Unknown descendant identity: malformed ps snapshot');
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          start: match[5].trim(),
        };
      });
  }
  const stdout = await new Promise<string>((resolve, reject) =>
    childProcess.execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(windowsSnapshotScript(), 'utf16le').toString('base64'),
      ],
      {
        timeout: operationMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: powershellEnvironment(),
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
  return JSON.parse(stdout) as unknown;
}

function rows(snapshot: unknown) {
  const result = Array.isArray(snapshot) ? snapshot : [snapshot];
  assert.ok(result.length, 'Unknown descendant identity: empty snapshot');
  const seen = new Set<number>();
  for (const row of result) {
    assert.ok(
      row &&
        Number.isSafeInteger(row.pid) &&
        row.pid >= 0 &&
        Number.isSafeInteger(row.ppid) &&
        row.ppid >= 0 &&
        Object.hasOwn(row, 'start') &&
        !seen.has(row.pid),
      'Unknown descendant identity: malformed or ambiguous snapshot',
    );
    seen.add(row.pid);
  }
  return result as { pid: number; ppid: number; start: unknown }[];
}

function birth(start: unknown): asserts start is string {
  if (typeof start === 'string') {
    const match = start.match(
      /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/,
    );
    if (match) {
      const month = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'
        .split(' ')
        .indexOf(match[2]);
      const [day, hour, minute, second, year] = match.slice(3).map(Number);
      const date = new Date(0);
      date.setUTCFullYear(year, month, day);
      date.setUTCHours(hour, minute, second, 0);
      assert.ok(
        date.getUTCFullYear() === year &&
          date.getUTCMonth() === month &&
          date.getUTCDate() === day &&
          date.getUTCHours() === hour &&
          date.getUTCMinutes() === minute &&
          date.getUTCSeconds() === second &&
          'Sun Mon Tue Wed Thu Fri Sat'.split(' ')[date.getUTCDay()] ===
            match[1],
        'Unknown descendant identity: invalid ps birth',
      );
      return;
    }
  }
  assert.ok(
    typeof start === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(start) &&
      Number.isFinite(Date.parse(start)) &&
      new Date(start).toISOString().slice(0, 19) === start.slice(0, 19),
    'Unknown descendant identity: missing or invalid full birth',
  );
}

function after(current: string, previous: string) {
  const utc = previous.endsWith('Z');
  assert.equal(current.endsWith('Z'), utc, 'Unknown descendant birth format');
  return utc ? current > previous : Date.parse(current) > Date.parse(previous);
}

export async function captureDescendantIdentity(
  parent: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>,
  pid: number,
  snapshot: Snapshot,
): Promise<Identity> {
  const parentLive = () => {
    assert.ok(parent.pid && parent.pid > 1 && pid > 1 && pid !== parent.pid);
    assert.equal(parent.exitCode, null, 'Original parent must remain live');
    assert.equal(parent.signalCode, null, 'Original parent must remain live');
  };
  parentLive();
  const observed = rows(await snapshot());
  parentLive();
  const root = observed.find((row) => row.pid === parent.pid);
  const descendant = observed.find((row) => row.pid === pid);
  assert.ok(root && descendant, 'Unknown original parent/descendant identity');
  birth(root.start);
  birth(descendant.start);
  assert.equal(descendant.ppid, parent.pid, 'Original parent relation');
  assert.ok(
    descendant.start === root.start || after(descendant.start, root.start),
    'Original descendant birth order',
  );
  // The original parent's IPC reports the PID of its process.execPath spawn.
  return { pid, ppid: descendant.ppid, start: descendant.start };
}

export async function assertDescendantAbsent(
  original: Identity,
  snapshot: Snapshot,
) {
  birth(original.start);
  const current = rows(await snapshot()).find(
    (row) => row.pid === original.pid,
  );
  if (!current) return;
  birth(current.start);
  assert.notEqual(
    current.start,
    original.start,
    'Original descendant remains live',
  );
  assert.ok(
    after(current.start, original.start),
    'Unknown descendant replacement birth',
  );
}
