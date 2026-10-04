import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Capture outside Playwright's process: an early launcher crash can bypass the
// packaged smoke's catch handler. pw:browser includes native launch stderr.
export function runPackagedCheck(command, args, { cwd, env }) {
  const directory = join(cwd, '.cache', 'smoke-failure');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'packaged-launch.stderr.log');
  const descriptor = openSync(path, 'w');
  let result;
  try {
    result = spawnSync(command, args, {
      cwd,
      env: { ...env, DEBUG: 'pw:browser' },
      stdio: ['inherit', 'inherit', descriptor],
    });
  } finally {
    closeSync(descriptor);
  }
  process.stderr.write(readFileSync(path));
  return result;
}
