import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Run the actual stop callback in a strict subprocess so an unobserved rejection
// is fatal. Only an owned disposable Node child is launched; no desktop runtime.
for (const scenario of [
  'healthy',
  'immediate-failure',
  'signal-failure',
  'timeout',
  'reject-error',
  'reject-zero',
  'reject-false',
  'reject-null',
  'reject-undefined',
  'reject-after-exit',
  'throw-zero',
]) {
  test(`window stop: ${scenario}`, async (t) => {
    const source = await readFile(
      new URL('../tools/window-check.mjs', import.meta.url),
      'utf8',
    );
    const start = source.indexOf("async function stop(action = 'quit'");
    const end = source.indexOf('\nasync function reopen(', start);
    assert.ok(start >= 0 && end > start);
    const stop = source.slice(start, end);
    const result = spawnSync(
      process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
      [
        '--unhandled-rejections=throw',
        '--input-type=module',
        '--eval',
        `
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
const scenario = ${JSON.stringify(scenario)};
const child = spawn(process.execPath, ['-e',
  "process.on('message', code => process.exit(code)); process.send('ready');"
], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const exit = once(child, 'exit');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const timers = new Set();
let fireDeadline;
let cleared = 0;
const geometry = { bounds: { x: 3, y: 4, width: 900, height: 700 }, maximized: false };
const primaries = { 'reject-error': new Error('evaluation rejected'), 'reject-zero': 0,
  'reject-false': false, 'reject-null': null, 'reject-undefined': undefined,
  'reject-after-exit': new Error('evaluation after exit'), 'throw-zero': 0 };
const rejects = Object.hasOwn(primaries, scenario);
let context;
try {
  await once(child, 'message');
  const owner = {
    process: () => child,
    evaluate: (_callback, options) => {
      assert.deepEqual(JSON.parse(JSON.stringify(options)), { action: 'close', finalChange: true });
      if (scenario === 'throw-zero') throw primaries[scenario];
      return (async () => {
        if (scenario === 'timeout') {
          fireDeadline();
          await pause(30);
        } else if (['healthy', 'immediate-failure', 'signal-failure', 'reject-after-exit'].includes(scenario)) {
          if (scenario === 'signal-failure') child.kill('SIGTERM');
          else child.send(scenario === 'healthy' ? 0 : 1);
          await exit;
          // Hold evaluate across event-loop turns after the actual exit.
          await pause(30);
        }
        if (rejects) throw primaries[scenario];
        return geometry;
      })();
    },
  };
  context = {
    running: owner,
    setTimeout: (callback, ms) => {
      assert.equal(ms, 15000);
      fireDeadline = callback;
      const timer = setTimeout(callback, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout: timer => {
      if (timers.delete(timer)) cleared++;
      clearTimeout(timer);
    },
  };
  const invoke = runInNewContext(${JSON.stringify(stop)} + '\\nstop', context);
  let failed = false;
  let failure;
  let value;
  try { value = await invoke('close', true); }
  catch (error) { failed = true; failure = error; }
  assert.equal(timers.size, 0, 'stop must clear its deadline on every path');
  assert.equal(cleared, 1);
  if (scenario === 'healthy') {
    assert.equal(failed, false);
    assert.equal(value, geometry);
    assert.equal(context.running, undefined);
    assert.equal(child.exitCode, 0);
  } else {
    assert.equal(failed, true);
    assert.equal(context.running, owner, 'failure retains the outer cleanup owner');
    if (rejects) assert.equal(failure, primaries[scenario]);
    else if (scenario === 'timeout') assert.equal(failure.message, 'Bounds flush blocked exit');
    else if (scenario === 'signal-failure') assert.match(failure.message, /Electron exited with null\\/SIGTERM/);
    else assert.equal(failure.message, 'Electron exited with 1/null');
  }
  console.log(JSON.stringify({ scenario, failed, cleared, exitCode: child.exitCode, signal: child.signalCode }));
} finally {
  for (const timer of timers) clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await exit;
}
`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"cleared":1/);
    t.diagnostic(result.stdout.trim());
  });
}
