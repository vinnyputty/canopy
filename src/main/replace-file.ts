import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

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
