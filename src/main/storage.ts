import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStorage } from 'electron';

export class Storage {
  private pending: Promise<void> = Promise.resolve();
  constructor(private directory: string) {}
  async read<T>(name: string): Promise<T | null> {
    try {
      return JSON.parse(
        await readFile(join(this.directory, `${name}.json`), 'utf8'),
      ) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(
        `Could not read saved ${name}. Back up and repair the file in ${this.directory}.`,
      );
    }
  }
  write(name: string, value: unknown): Promise<void> {
    const contents = JSON.stringify(value);
    const task = this.pending
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const file = join(this.directory, `${name}.json`);
        await writeFile(`${file}.tmp`, contents, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      });
    this.pending = task;
    return task;
  }
  assertSecure() {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' &&
        safeStorage.getSelectedStorageBackend() === 'basic_text')
    )
      throw new Error(
        'Secure credential storage is unavailable. Enable your operating system keychain, then connect again.',
      );
  }
  async readSecrets<T>(): Promise<T | null> {
    const encrypted = await this.read<string>('credentials');
    if (!encrypted) return null;
    this.assertSecure();
    try {
      return JSON.parse(
        safeStorage.decryptString(Buffer.from(encrypted, 'base64')),
      ) as T;
    } catch {
      throw new Error(
        'Saved credentials could not be unlocked using this OS account.',
      );
    }
  }
  async writeSecrets(value: unknown) {
    this.assertSecure();
    await this.write(
      'credentials',
      safeStorage.encryptString(JSON.stringify(value)).toString('base64'),
    );
  }
}
