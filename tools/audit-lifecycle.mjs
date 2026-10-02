import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const execFile = promisify(childProcess.execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const script =
      'Get-CimInstance Win32_Process | ForEach-Object { @{ pid=$_.ProcessId; ppid=$_.ParentProcessId; start=$_.CreationDate.ToUniversalTime().ToString("o") } } | ConvertTo-Json -Compress';
    const { stdout } = await execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: ms, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    const result = JSON.parse(stdout || '[]');
    return (Array.isArray(result) ? result : [result]).map((row) => ({
      ...row,
      pid: Number(row.pid),
      ppid: Number(row.ppid),
      pgid: 0,
      zombie: false,
    }));
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

class OwnedScope {
  constructor(child, options, owner) {
    this.child = child;
    this.pid = child.pid;
    this.owner = owner;
    this.members = new Map();
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
  async live() {
    if (!this.valid)
      throw new Error(
        'Launch did not establish an isolated owned process scope',
      );
    const rows = await processes(this.owner.operationMs);
    const root = rows.find((row) => row.pid === this.pid);
    if (root && this.rootStart && root.start !== this.rootStart) {
      // A reused root PID must never become a kill target or seed a new tree.
      this.groupRetired = true;
    } else if (root) {
      if (process.platform !== 'win32' && root.pgid !== this.pid)
        throw new Error('Owned launch is not its process-group leader');
      this.rootStart ??= root.start;
      this.members.set(root.pid, root.start);
    }
    const owned = rows.filter((row) => this.members.get(row.pid) === row.start);
    if (process.platform !== 'win32' && !this.groupRetired) {
      // Node detached:true creates this new group before exec; the recorded
      // successful spawn owns it even if the leader exits before the first ps.
      owned.push(...rows.filter((row) => row.pgid === this.pid));
    } else if (!this.rootStart && !this.members.size) {
      throw new Error(
        'Could not retain the launch-owned Windows process-tree identity',
      );
    }
    const identities = new Set(owned.map((row) => row.pid));
    let added;
    do {
      added = false;
      for (const row of rows) {
        if (!identities.has(row.pid) && identities.has(row.ppid)) {
          identities.add(row.pid);
          owned.push(row);
          added = true;
        }
      }
    } while (added);
    for (const row of owned) {
      if (row.pid === process.pid)
        throw new Error(
          'Refusing to include the audit process in its child scope',
        );
      this.members.set(row.pid, row.start);
    }
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
      const current = (await processes(remaining())).find(
        (row) =>
          row.pid === member.pid && row.start === member.start && !row.zombie,
      );
      if (!current) continue;
      if (process.platform === 'win32') {
        await execFile(
          'taskkill.exe',
          ['/PID', String(member.pid), '/T', '/F'],
          { timeout: remaining(), windowsHide: true },
        );
      } else {
        try {
          process.kill(member.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
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
    killMs = 5000,
    operationMs = 3000,
    signalGroup = process.kill.bind(process),
  }) {
    Object.assign(this, {
      profile,
      executable,
      graceMs,
      killMs,
      operationMs,
      signalGroup,
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
      if (
        Number.isSafeInteger(child.pid) &&
        options?.env?.CANOPY_USER_DATA === owner.profile &&
        (command === owner.executable ||
          (process.platform === 'win32' &&
            command.startsWith(`"${owner.executable}" `)))
      ) {
        owner.scopes.push(new OwnedScope(child, options, owner));
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
