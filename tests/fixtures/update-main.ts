// Dedicated audit entry point. Production main never reads these controls.
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { launch } from '../../src/main/app';
import { createDemoFixture, demoWorkspace } from '../../src/main/demo';
import { Updates } from '../../src/main/updates';
import { ReleaseRequestError, type ReleasePage } from '../../src/main/releases';
import { release } from './releases';

// Fail before launch/Auth/fixture writes if a parent did not explicitly select
// a disposable temp profile. Do not read credentials, even in a mistaken launch.
const profile = process.env.CANOPY_USER_DATA;
if (!profile || !isAbsolute(profile))
  throw new Error(
    'Supply an explicit disposable CANOPY_USER_DATA for update audit.',
  );
const resolvedProfile = realpathSync(profile);
const tempRoots = [
  realpathSync(tmpdir()),
  ...(existsSync('/tmp') ? [realpathSync('/tmp')] : []),
];
if (
  !tempRoots.some((root) => {
    const child = relative(root, resolvedProfile);
    return (
      child &&
      child !== '..' &&
      !child.startsWith(`..${sep}`) &&
      !isAbsolute(child)
    );
  }) ||
  existsSync(join(resolvedProfile, 'credentials.json'))
)
  throw new Error(
    'Update audit requires a credential-free disposable temp profile.',
  );

const controls = {
  mode: 'available' as
    'available' | 'empty' | 'incompatible' | 'offline' | 'rate' | 'hold',
  requests: [] as number[],
  browserHandoffs: [] as string[],
  releaseHeld: undefined as ((page: ReleasePage) => void) | undefined,
  time: Date.now(),
  advance(ms: number) {
    this.time += ms;
  },
};
launch(async (storage) => {
  await storage.write('workspace', demoWorkspace);
  const updates = new Updates(
    storage,
    '0.1.0',
    process.platform,
    process.arch,
    true,
    async (page, signal) => {
      controls.requests.push(page);
      if (controls.mode === 'offline') throw new Error('Sample offline');
      if (controls.mode === 'rate')
        throw new ReleaseRequestError(
          'Sample GitHub rate limit.',
          controls.time + 120_000,
        );
      if (controls.mode === 'hold')
        return new Promise((resolve, reject) => {
          controls.releaseHeld = resolve;
          signal.addEventListener(
            'abort',
            () => reject(new Error('Sample cancelled')),
            { once: true },
          );
        });
      const suffix =
        controls.mode === 'incompatible'
          ? 'unknown-cpu.zip'
          : process.platform === 'darwin'
            ? `mac-${process.arch}.dmg`
            : process.platform === 'win32'
              ? `win-${process.arch}.exe`
              : `linux-${process.arch === 'x64' ? 'amd64' : process.arch}.deb`;
      return {
        rows:
          controls.mode === 'empty'
            ? []
            : [
                release('0.2.0', suffix),
                release('0.3.0-rc.1', suffix),
                release('0.1.0', suffix),
              ],
        more: false,
      };
    },
    () => controls.time,
  );
  const open = updates.open.bind(updates);
  updates.open = (tag) =>
    open(tag, async (url) => {
      controls.browserHandoffs.push(url);
    });
  Object.assign(globalThis, { canopyUpdateAudit: controls });
  return { ...(await createDemoFixture()), updates };
});
