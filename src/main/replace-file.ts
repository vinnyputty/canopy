import { open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** Replace saved state without reusing temporary files left by an earlier launch. */
export async function writeSavedFile(destination: string, contents: string) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(contents);
    } finally {
      await file.close();
    }
    await replaceFile(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Keep the existing file intact while Windows releases a temporary file lock. */
export async function replaceFile(
  source: string,
  destination: string,
  platform = process.platform,
  move = rename,
): Promise<void> {
  const backoff = [25, 50, 100, 200, 250, 250];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await move(source, destination);
      return;
    } catch (error) {
      if (
        platform !== 'win32' ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        ) ||
        attempt === backoff.length
      )
        throw error;
      await delay(backoff[attempt]);
    }
  }
}
