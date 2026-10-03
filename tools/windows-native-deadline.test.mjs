import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
const source = await readFile(
  new URL('./windows-native.cs', import.meta.url),
  'utf8',
);
// Evaluate the actual scalar C# budget expression with injected elapsed milliseconds.
// This qualifies deadline arithmetic/call-site ownership, never Windows kernel behavior.
const expression = source.match(
  /static int Remaining\(Stopwatch clock,int deadlineMs\) \{ return \(int\)([^;]+); \}/,
)[1];
const remaining = new Function(
  'elapsed',
  'deadlineMs',
  `return ${expression.replace('Math.Max', 'Math.max').replace('clock.ElapsedMilliseconds', 'elapsed')};`,
);
test('parent and descendants share the same native operation budget with no renewed grace', () => {
  assert.ok(
    source.includes(
      'WaitForSingleObject(pi.Process,(uint)Remaining(operation,timeoutMs))',
    ),
  );
  assert.ok(source.includes('!WaitEmpty(job,operation,timeoutMs)'));
  assert.ok(
    source.indexOf('var operation=Stopwatch.StartNew();') <
      source.indexOf('ResumeThread(pi.Thread)'),
  );
  assert.ok(source.includes('if(remaining==0) return false;'));
  assert.ok(source.includes('Thread.Sleep(Math.Min(25,remaining));'));
  const parentExit = 1000,
    descendantExit = 30000,
    deadline = 90000;
  assert.equal(
    descendantExit - parentExit > 10000,
    true,
    'reviewed fixed ten-second descendant wait rejects this positive case',
  );
  assert.equal(remaining(parentExit, deadline), 89000);
  assert.ok(descendantExit <= parentExit + remaining(parentExit, deadline));
  assert.ok(91000 > parentExit + remaining(parentExit, deadline));
  assert.equal(remaining(89999, deadline), 1);
  assert.equal(remaining(90000, deadline), 0);
  assert.equal(remaining(90001, deadline), 0);
  assert.equal(
    remaining(90000, deadline) + 90000,
    deadline,
    'exhaustion grants no minimum or reset',
  );
  assert.ok(!source.includes('Math.Max(1000'));
});
test('cleanup remains separately bounded and preserves operation primary; descendant exit codes are not claimed', () => {
  assert.ok(source.includes('WaitEmpty(job,10000)'));
  assert.ok(source.includes('WaitForSingleObject(pi.Process,10000)'));
  assert.ok(source.includes('primary=primary ??'));
  assert.ok(
    source.includes('else { Require(GetExitCodeProcess(pi.Process,out code));'),
  );
  assert.ok(source.includes('{"descendantExitCodesObserved",false}'));
  assert.ok(source.includes('TerminateJobObject(job,1)'));
  assert.ok(source.includes('new IntPtr(0x0002000D)'));
});

test('actual native WaitEmpty loop respects remaining budget under a virtual monotonic clock', () => {
  const body = source.match(
    /static bool WaitEmpty\(IntPtr job,Stopwatch clock,int deadlineMs\) \{([\s\S]*?)\n    \}/,
  )[1];
  const wait = new Function(
    'job',
    'clock',
    'deadlineMs',
    'Empty',
    'Remaining',
    'Sleep',
    body
      .replace('int remaining=', 'const remaining=')
      .replace('Thread.Sleep', 'Sleep')
      .replace('Math.Min', 'Math.min')
      .replaceAll('clock.ElapsedMilliseconds', 'clock.elapsed'),
  );
  const run = (parentExit, childExit, deadline) => {
    const clock = { elapsed: parentExit };
    const sleeps = [];
    const completed = wait(
      {},
      clock,
      deadline,
      () => clock.elapsed >= childExit,
      (clock, limit) => remaining(clock.elapsed, limit),
      (duration) => {
        sleeps.push(duration);
        clock.elapsed += duration;
      },
    );
    return { completed, elapsed: clock.elapsed, sleeps };
  };
  assert.equal(run(1000, 30000, 90000).completed, true);
  assert.equal(run(1000, 91000, 90000).completed, false);
  assert.equal(run(1000, 91000, 90000).elapsed, 90000);
  assert.equal(run(89999, 90000, 90000).elapsed, 90000);
  assert.deepEqual(run(90000, 91000, 90000), {
    completed: false,
    elapsed: 90000,
    sleeps: [],
  });
  assert.equal(run(90001, 91000, 90000).sleeps.length, 0);
  assert.equal(
    run(91000, 91000, 90000).completed,
    false,
    'already empty observed beyond deadline cannot qualify operation success',
  );
});
