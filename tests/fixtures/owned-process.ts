import type { ChildProcess } from 'node:child_process';

// Test-only direct handles; no PID discovery or ownership authority.
export async function disposeProcess(
  child: ChildProcess | undefined,
  signal = () => child!.kill('SIGKILL'),
) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const errors: unknown[] = [];
    const done = () => {
      clearTimeout(timer);
      child.removeListener('close', done);
      child.removeListener('error', failed);
      if (errors.length)
        reject(new AggregateError(errors, 'Owned test process cleanup failed'));
      else resolve();
    };
    const failed = (error: unknown) => errors.push(error);
    const timer = setTimeout(() => {
      child.removeListener('close', done);
      child.removeListener('error', failed);
      reject(new AggregateError(errors, 'Owned test process close timed out'));
    }, 5000);
    child.once('close', done);
    child.on('error', failed);
    // An asynchronous spawn failure has no process to signal; observe close.
    if (child.pid !== undefined) {
      try {
        signal();
      } catch (error) {
        errors.push(error);
      }
    }
  });
}

export async function withCleanup<T>(
  run: () => Promise<T>,
  ...cleanups: (() => Promise<unknown>)[]
): Promise<T> {
  let value!: T;
  let primary: unknown;
  let failed = false;
  const secondary: unknown[] = [];
  try {
    value = await run();
  } catch (error) {
    failed = true;
    primary = error;
  }
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      secondary.push(error);
    }
  }
  if (secondary.length)
    throw new AggregateError(
      failed ? [primary, ...secondary] : secondary,
      'Owned test cleanup failed',
      failed ? { cause: primary } : undefined,
    );
  if (failed) throw primary;
  return value;
}
