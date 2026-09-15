import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(
  process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
  [join(root, 'dist', 'broker.cjs')],
  {
    stdio: 'inherit',
    env: process.env,
    cwd: root,
  },
);
child.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
