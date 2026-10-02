// Backup audits own one Playwright process tree and one disposable directory.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
const execute = promisify(execFile);

async function bounded(label, operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function finishBackupAudit({
  app,
  directory,
  failure,
  failed = failure !== undefined,
  diagnostics,
  timeoutMs = 5000,
}) {
  const errors = [];
  const attempt = async (label, operation) => {
    try {
      await bounded(label, operation, timeoutMs);
      return true;
    } catch (error) {
      errors.push(error);
      console.error(`${label}:`, error);
      return false;
    }
  };
  // Collect only descendants of the exact process returned by this launch.
  let owned;
  await attempt('Owned process handle', () => {
    owned = app?.process?.();
  });
  let descendants = [];
  const live = () =>
    owned?.pid && owned.exitCode === null && owned.signalCode === null;
  if (live() && process.platform !== 'win32')
    await attempt('Owned process discovery', async () => {
      const { stdout } = await execute('ps', ['-eo', 'pid=,ppid='], {
        timeout: timeoutMs,
      });
      const rows = stdout
        .trim()
        .split('\n')
        .map((row) => row.trim().split(/\s+/).map(Number));
      const parents = new Set([owned.pid]);
      for (let changed = true; changed;) {
        changed = false;
        for (const [pid, parent] of rows)
          if (parents.has(parent) && !parents.has(pid)) {
            parents.add(pid);
            descendants.push(pid);
            changed = true;
          }
      }
    });
  if (failed && diagnostics) await attempt('Sample diagnostics', diagnostics);
  const closed =
    !app || (await attempt('Owned Electron close', () => app.close()));
  if (!closed && live())
    await attempt('Owned process termination', async () => {
      if (process.platform === 'win32') {
        await execute('taskkill', ['/PID', String(owned.pid), '/T', '/F'], {
          timeout: timeoutMs,
        });
      } else {
        for (const pid of descendants.reverse()) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
        owned.kill('SIGKILL');
      }
      if (owned.exitCode === null && owned.signalCode === null)
        await new Promise((resolve) => owned.once('exit', resolve));
    });
  await attempt('Owned profile removal', () =>
    rm(directory, { recursive: true, force: true }),
  );
  if (failed) throw failure;
  if (errors.length)
    throw new AggregateError(errors, 'Backup audit cleanup failed');
}
