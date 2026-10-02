import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { cpus, freemem, totalmem } from 'node:os';

const execFile = promisify(childProcess.execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let activeCimSnapshots = 0;

function hostCpuTimes() {
  return cpus().reduce(
    (sum, cpu) => ({
      total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
      idle: sum.idle + cpu.times.idle,
    }),
    { total: 0, idle: 0 },
  );
}

export async function deadline(operation, ms, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function processes(ms) {
  if (process.platform === 'win32') {
    // CreationDate distinguishes a retained tree member from a reused PID.
    // Flush phase markers independently of stdout's complete identity snapshot.
    // A timeout before script-entry is different from a slow query or serializer.
    const script = `
[Console]::Error.WriteLine("canopy-cim phase=script-entry"); [Console]::Error.Flush();
$ErrorActionPreference = "Stop";
$clock = [System.Diagnostics.Stopwatch]::StartNew();
function Mark($phase, $count) {
  $self = [System.Diagnostics.Process]::GetCurrentProcess();
  [Console]::Error.WriteLine("canopy-cim phase=$phase elapsedMs=$($clock.ElapsedMilliseconds) rows=$count cpuMs=$($self.TotalProcessorTime.TotalMilliseconds) memoryBytes=$($self.WorkingSet64) processors=$([Environment]::ProcessorCount)");
  [Console]::Error.Flush();
}
Mark "module-load" 0;
Import-Module CimCmdlets;
Mark "query" 0;
$processes = @(Get-CimInstance Win32_Process);
Mark "projection" $processes.Count;
$rows = @($processes | ForEach-Object { @{ pid=$_.ProcessId; ppid=$_.ParentProcessId; start=if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("o") } else { $null } } });
Mark "serialization" $rows.Count;
$json = $rows | ConvertTo-Json -Compress;
Mark "complete" $rows.Count;
[Console]::Out.WriteLine($json);
`;
    const started = Date.now();
    const concurrentSnapshots = ++activeCimSnapshots;
    const cpuStarted = process.cpuUsage();
    let hostStarted = null;
    let spawnedMs = null;
    let snapshotPid = null;
    let stdout;
    try {
      const pending = execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { timeout: ms, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      );
      pending.child?.once('spawn', () => {
        spawnedMs = Date.now() - started;
        snapshotPid = pending.child.pid;
        hostStarted = hostCpuTimes();
      });
      ({ stdout } = await pending);
    } catch (error) {
      const hostEnded = hostStarted ? hostCpuTimes() : null;
      // TAP otherwise prints only the generic message, losing timeout evidence.
      throw new Error(
        `CIM process snapshot failed: ${JSON.stringify({
          elapsedMs: Date.now() - started,
          timeoutMs: ms,
          phase:
            [
              ...String(error.stderr ?? '').matchAll(
                /canopy-cim phase=([\w-]+)/g,
              ),
            ].at(-1)?.[1] ?? 'startup-or-script-entry',
          spawnedMs,
          snapshotPid,
          observerPid: process.pid,
          concurrentSnapshots,
          observerCpuMicros: process.cpuUsage(cpuStarted),
          observerMemoryBytes: process.memoryUsage().rss,
          hostCpuDeltaMs:
            hostEnded && hostStarted
              ? {
                  total: hostEnded.total - hostStarted.total,
                  idle: hostEnded.idle - hostStarted.idle,
                }
              : null,
          hostMemoryBytes: { free: freemem(), total: totalmem() },
          code: error.code ?? null,
          killed: error.killed ?? null,
          signal: error.signal ?? null,
          stdout: String(error.stdout ?? '').slice(0, 4096),
          stderr: String(error.stderr ?? '').slice(0, 4096),
        })}`,
        { cause: error },
      );
    } finally {
      activeCimSnapshots--;
    }
    const result = JSON.parse(stdout);
    return (Array.isArray(result) ? result : [result]).map((row) => {
      if (
        !row ||
        !Number.isSafeInteger(row.pid) ||
        row.pid < 0 ||
        !Number.isSafeInteger(row.ppid) ||
        row.ppid < 0
      )
        throw new Error('Invalid CIM process identity');
      // Keep missing birth stamps visible; only owned identities authorize signals.
      return { ...row, pgid: 0, zombie: false };
    });
  }

  const { stdout } = await execFile(
    'ps',
    ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='],
    {
      timeout: ms,
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) throw new Error(`Cannot parse process identity: ${line}`);
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        zombie: match[4].startsWith('Z'),
        start: match[5].trim(),
      };
    });
}

function validBirth(start) {
  if (typeof start !== 'string' || !Number.isFinite(Date.parse(start)))
    return false;
  if (process.platform !== 'win32') {
    // LC_ALL=C lstart uses local calendar components and a space-padded day.
    // Validate in UTC to avoid local timezone/DST normalization. Keep the
    // original token for identity comparisons, not this validation-only date.
    const match = start.match(
      /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/,
    );
    if (!match) return false;
    const month = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'
      .split(' ')
      .indexOf(match[2]);
    const [day, hour, minute, second, year] = match.slice(3).map(Number);
    const date = new Date(0);
    date.setUTCFullYear(year, month, day);
    date.setUTCHours(hour, minute, second, 0);
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month &&
      date.getUTCDate() === day &&
      date.getUTCHours() === hour &&
      date.getUTCMinutes() === minute &&
      date.getUTCSeconds() === second &&
      'Sun Mon Tue Wed Thu Fri Sat'.split(' ')[date.getUTCDay()] === match[1]
    );
  }
  // Exact UTC round-trip form emitted by CreationDate.ToString("o").
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(start) &&
    new Date(start).toISOString().slice(0, 19) === start.slice(0, 19)
  );
}

class OwnedScope {
  constructor(child, options, owner) {
    this.child = child;
    this.pid = child.pid;
    this.owner = owner;
    this.members = new Map();
    this.observed = new Set();
    // Departed identities can reveal possible late descendants, but never
    // authorize signals. Keep full birth tokens and any proven reuse boundary.
    this.ancestry = new Map();
    this.capturedRows = false;
    this.groupRetired = false;
    this.valid =
      Number.isSafeInteger(this.pid) &&
      this.pid > 1 &&
      this.pid !== process.pid &&
      (process.platform === 'win32'
        ? !options.detached
        : options.detached === true);
    // Capture before Electron.launch initializes or rejects, not just after it returns.
    this.ready = this.live().catch((error) => {
      this.captureError = error;
    });
  }
  async live(ms = this.owner.operationMs) {
    if (!this.valid)
      throw new Error(
        'Launch did not establish an isolated owned process scope',
      );
    const rows = await processes(ms);
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const historicalPotential = new Set();
    if (process.platform === 'win32') {
      for (const [pid, births] of this.ancestry) {
        const current = byPid.get(pid);
        if (!validBirth(current?.start)) continue;
        for (const history of births.values()) {
          if (
            current.start !== history.start &&
            (!history.until || current.start < history.until)
          )
            history.until = current.start;
        }
      }
      for (const row of rows) {
        const identity = this.ancestry.get(row.pid);
        if (
          validBirth(row.start) &&
          identity &&
          !identity.get(row.start)?.verified &&
          [...identity.values()].some((history) => history.verified)
        )
          continue; // Proven replacement of a previously verified member.
        const parent = byPid.get(row.ppid);
        const births = this.ancestry.get(row.ppid);
        if (!births) continue;
        for (const history of births.values()) {
          if (parent?.start === history.start) continue;
          if (
            !validBirth(row.start) ||
            ((!history.start || row.start >= history.start) &&
              (!history.until || row.start < history.until) &&
              (!validBirth(parent?.start) || row.start < parent.start))
          )
            historicalPotential.add(row.pid);
        }
      }
    }
    // A complete successful snapshot can prove absence or valid PID reuse.
    // Unavailable/malformed birth information proves neither.
    for (const [pid, birth] of this.members) {
      const row = byPid.get(pid);
      if (!row || (validBirth(row.start) && row.start !== birth)) {
        this.members.delete(pid);
        this.observed.delete(pid);
      }
    }
    for (const pid of this.observed)
      if (!byPid.has(pid)) this.observed.delete(pid);
    const root = byPid.get(this.pid);
    if (
      root &&
      this.rootStart &&
      validBirth(root.start) &&
      root.start !== this.rootStart
    ) {
      this.groupRetired = true;
      this.members.delete(this.pid);
      this.observed.delete(this.pid);
    }
    // Retain every potential descendant BEFORE validation can reject a partial
    // capture. Unknown identities seed observation only, never signaling.
    const potential = new Set([...this.members.keys(), ...this.observed]);
    for (const pid of historicalPotential) potential.add(pid);
    if (root && !this.groupRetired && (this.rootStart || !this.exited()))
      potential.add(root.pid);
    if (process.platform !== 'win32' && !this.groupRetired)
      for (const row of rows) if (row.pgid === this.pid) potential.add(row.pid);
    // Windows keeps stale parent PIDs. Fixed-width UTC tokens preserve all
    // seven fractional digits; unknown births remain potential, never owned.
    const edge = (row, verified) => {
      if (process.platform !== 'win32') return true;
      const parent = byPid.get(row.ppid);
      const known = validBirth(row.start) && validBirth(parent?.start);
      return known ? row.start >= parent.start : !verified;
    };
    let added;
    do {
      added = false;
      for (const row of rows) {
        if (
          !potential.has(row.pid) &&
          potential.has(row.ppid) &&
          edge(row, false)
        ) {
          potential.add(row.pid);
          added = true;
        }
      }
    } while (added);
    for (const pid of potential) this.observed.add(pid);
    if (process.platform === 'win32')
      for (const row of rows) {
        if (!potential.has(row.pid)) continue;
        const start = validBirth(row.start) ? row.start : null;
        let births = this.ancestry.get(row.pid);
        if (!births) this.ancestry.set(row.pid, (births = new Map()));
        if (!births.has(start)) births.set(start, { start });
      }
    this.capturedRows ||= potential.size > 0;
    if (root && !this.groupRetired && (this.rootStart || !this.exited())) {
      if (!validBirth(root.start))
        throw new Error(
          `Unestablished process creation identity for PID ${root.pid}`,
        );
      if (process.platform !== 'win32' && root.pgid !== this.pid)
        throw new Error('Owned launch is not its process-group leader');
      this.rootStart ??= root.start;
      this.members.set(root.pid, root.start);
    }
    const owned = rows.filter(
      (row) =>
        this.members.has(row.pid) && this.members.get(row.pid) === row.start,
    );
    if (process.platform !== 'win32' && !this.groupRetired) {
      // Node detached:true creates this new group before exec; the recorded
      // successful spawn owns it even if the leader exits before the first ps.
      owned.push(...rows.filter((row) => row.pgid === this.pid));
    } else if (
      !this.rootStart &&
      !this.members.size &&
      !(this.capturedRows && !this.observed.size && this.exited())
    ) {
      throw new Error(
        'Could not retain the launch-owned Windows process-tree identity',
      );
    }
    const identities = new Set(owned.map((row) => row.pid));
    do {
      added = false;
      for (const row of rows) {
        if (
          !identities.has(row.pid) &&
          identities.has(row.ppid) &&
          edge(row, true)
        ) {
          identities.add(row.pid);
          owned.push(row);
          added = true;
        }
      }
    } while (added);
    // Save all verified siblings even when another observed row is uncertain.
    for (const row of owned) {
      if (row.pid === process.pid)
        throw new Error(
          'Refusing to include the audit process in its child scope',
        );
      if (validBirth(row.start)) {
        this.members.set(row.pid, row.start);
        if (process.platform === 'win32')
          this.ancestry.get(row.pid).get(row.start).verified = true;
      }
    }
    const uncertain = rows.filter(
      (row) =>
        this.observed.has(row.pid) &&
        (!validBirth(row.start) ||
          !this.members.has(row.pid) ||
          this.members.get(row.pid) !== row.start),
    );
    if (uncertain.length)
      throw new Error(
        `Unestablished process creation identity for PID ${uncertain.map((row) => row.pid).join(', ')}`,
      );
    const live = [
      ...new Map(
        owned.filter((row) => !row.zombie).map((row) => [row.pid, row]),
      ).values(),
    ];
    if (
      process.platform !== 'win32' &&
      !live.some((row) => row.pgid === this.pid) &&
      this.exited()
    )
      this.groupRetired = true;
    return live;
  }
  exited() {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }
  async wait(ms) {
    const until = Date.now() + ms;
    do {
      if (!(await this.live()).length && this.exited()) return true;
      await delay(20);
    } while (Date.now() < until);
    return false;
  }
  async kill(ms) {
    const until = Date.now() + ms;
    const remaining = () => {
      const ms = Math.min(this.owner.operationMs, until - Date.now());
      if (ms <= 0) throw new Error('Owned scope kill deadline expired');
      return ms;
    };
    if (process.platform === 'win32') {
      // Enumerate again after each individual signal, including newly observed
      // descendants. Never let taskkill follow unverified stale parent links.
      let live = await this.live(remaining());
      while (live.length) {
        const member = live[0];
        const current = (await this.live(remaining())).find(
          (row) => row.pid === member.pid && row.start === member.start,
        );
        if (current) await this.owner.killPid(member.pid, remaining());
        live = await this.live(remaining());
      }
      return;
    }
    const live = await this.live();
    if (
      process.platform !== 'win32' &&
      live.some((row) => row.pgid === this.pid)
    ) {
      try {
        this.owner.signalGroup(-this.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    // Retained descendants that left the POSIX group, or the Windows tree.
    // Recheck birth identities immediately before signaling; never kill by name.
    for (const member of live) {
      if (process.platform !== 'win32' && member.pgid === this.pid) continue;
      const current = (await this.live(remaining())).find(
        (row) =>
          row.pid === member.pid && row.start === member.start && !row.zombie,
      );
      if (!current) continue;
      try {
        process.kill(member.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
}

/** Matches only the exact executable and unique disposable-profile launch. */
export class AuditOwner {
  constructor({
    profile,
    executable,
    graceMs = 10000,
    killMs = process.platform === 'win32' ? 60000 : 5000,
    operationMs = process.platform === 'win32' ? 15000 : 3000,
    signalGroup = process.kill.bind(process),
    killPid = (pid, ms) =>
      execFile('taskkill.exe', ['/PID', String(pid), '/F'], {
        timeout: ms,
        windowsHide: true,
      }),
  }) {
    Object.assign(this, {
      profile,
      executable,
      graceMs,
      killMs,
      operationMs,
      signalGroup,
      killPid,
    });
    this.scopes = [];
  }
  get child() {
    return this.scopes.length === 1 ? this.scopes[0].child : undefined;
  }
  restore() {
    this.restoreCapture?.();
    this.restoreCapture = undefined;
  }
  async launch(operation) {
    const original = childProcess.spawn;
    const owner = this;
    const capture = function (command, args, options) {
      const child = original.call(this, command, args, options);
      if (options?.env?.CANOPY_USER_DATA === owner.profile) {
        if (
          Number.isSafeInteger(child.pid) &&
          child.pid > 1 &&
          child.pid !== process.pid &&
          (command === owner.executable ||
            (process.platform === 'win32' &&
              command.startsWith(`"${owner.executable}" `)))
        ) {
          owner.scopes.push(new OwnedScope(child, options, owner));
        } else {
          // An unverified profile-bearing launch may still be writing to it.
          owner.unknownLaunch = true;
        }
      }
      return child;
    };
    childProcess.spawn = capture;
    syncBuiltinESMExports();
    this.restoreCapture = () => {
      if (childProcess.spawn === capture) {
        childProcess.spawn = original;
        syncBuiltinESMExports();
      }
    };
    try {
      const app = await operation();
      if (this.scopes.length !== 1)
        throw new Error('Expected exactly one verified audit launch');
      await this.scopes[0].ready;
      if (this.scopes[0].captureError) throw this.scopes[0].captureError;
      await this.scopes[0].live();
      return app;
    } finally {
      this.restore();
    }
  }
  confirm(child) {
    if (this.child !== child) {
      this.unknownLaunch = true;
      throw new Error(
        'Electron process does not match the retained audit launch',
      );
    }
  }
  async shutdown(close) {
    this.restore();
    const errors = [];
    if (this.unknownLaunch)
      errors.push(
        new Error('Unestablished launch ownership; profile retained'),
      );
    for (const scope of this.scopes) {
      try {
        await scope.ready;
        await scope.live();
      } catch (error) {
        errors.push(error);
      }
    }
    const gracefulEnd = Date.now() + this.graceMs;
    if (close && !this.unknownLaunch) {
      try {
        await deadline(
          close,
          Math.max(1, gracefulEnd - Date.now()),
          'Graceful audit close',
        );
      } catch (error) {
        errors.push(error);
      }
    }
    let terminated = !this.unknownLaunch;
    for (const scope of this.scopes) {
      try {
        await scope.ready;
        if (
          !close ||
          !(await scope.wait(Math.max(0, gracefulEnd - Date.now())))
        ) {
          if ((await scope.live()).length) {
            errors.push(
              new Error(
                `Owned audit scope ${scope.pid} required forced shutdown`,
              ),
            );
            await scope.kill(this.killMs);
          }
        }
        if (!(await scope.wait(this.killMs)))
          throw new Error(
            `Owned audit scope ${scope.pid} termination could not be established; profile retained`,
          );
        if (scope.child.exitCode !== 0 || scope.child.signalCode !== null)
          errors.push(
            new Error(
              `Abnormal audit exit: code=${scope.child.exitCode} signal=${scope.child.signalCode}`,
            ),
          );
      } catch (error) {
        terminated = false;
        errors.push(error);
      }
    }
    return { terminated, errors };
  }
}

/** Keep the assertion/launch error first; diagnostic and cleanup faults are secondary. */
export async function finishAudit({
  owner,
  close,
  primary,
  diagnostics = [],
  removeProfile,
  writeEvidence,
  secondary = () => {},
  operationMs = 3000,
}) {
  const errors = [];
  const report = (error) => {
    errors.push(error);
    try {
      secondary(error);
    } catch (reportError) {
      errors.push(
        new Error('Secondary error reporting failed', { cause: reportError }),
      );
    }
  };
  const attempt = async (label, operation) => {
    try {
      await deadline(operation, operationMs, label);
    } catch (error) {
      const detail = new Error(`${label}: ${error.message ?? error}`, {
        cause: error,
      });
      report(detail);
    }
  };
  for (const { label, run } of diagnostics) await attempt(label, run);
  let shutdown;
  try {
    shutdown = await owner.shutdown(close);
  } catch (error) {
    shutdown = { terminated: false, errors: [error] };
  }
  for (const error of shutdown.errors) report(error);
  if (shutdown.terminated) await attempt('Profile removal', removeProfile);
  else report(new Error(`Profile retained: ${owner.profile}`));
  await attempt('Evidence write', writeEvidence);
  if (primary && !errors.length) throw primary;
  if (primary || errors.length) {
    const first = primary ?? errors[0];
    throw new AggregateError(
      primary ? [primary, ...errors] : errors,
      `${first.message ?? first}; ${errors.length} diagnostic/cleanup error(s)`,
      { cause: first },
    );
  }
}
