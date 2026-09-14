import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['dist/broker.cjs'], {
  stdio: 'inherit',
  env: process.env,
});
child.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
