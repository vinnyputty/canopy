import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { runCimModuleControls } from '../tools/windows-cim-control.mjs';

test('native CI comparisons isolate module environment and canonical resolution without masking failures', () => {
  const env = { PSModulePath: 'fixture-PowerShell-7', OTHER: 'preserved' };
  const observed: string[] = [];
  const reports: unknown[] = [];
  const result = runCimModuleControls({
    env,
    report: (record) => reports.push(record),
    spawn: ((command, args, options) => {
      assert.ok(args && options?.env);
      assert.equal(command, 'powershell.exe');
      assert.equal(options.timeout, 15000);
      const script = Buffer.from(args[3], 'base64').toString('utf16le');
      const mode = options.env.PSModulePath
        ? 'inherited'
        : script.includes('Import-Module $manifest;')
          ? 'canonical'
          : 'default';
      observed.push(mode);
      assert.equal(options.env.OTHER, 'preserved');
      assert.ok(
        script.includes('Get-CimInstance Win32_Process'),
        'each comparison includes the complete production query',
      );
      assert.ok(script.includes('ToString("o")'));
      assert.ok(script.includes('[System.IO.File]::Exists($manifest)'));
      if (mode === 'inherited')
        return {
          status: null,
          signal: 'SIGTERM',
          error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
          stdout: '',
          stderr: 'canopy-cim phase=module-load',
        };
      if (mode === 'canonical')
        return {
          status: 0,
          signal: null,
          stdout: '{"pid":1,"ppid":0,"start":null}',
          stderr: 'canopy-cim phase=complete',
        };
      return {
        status: 0,
        signal: null,
        stdout: '',
        stderr: 'canopy-cim phase=complete',
      };
    }) as typeof spawnSync,
  });
  assert.deepEqual(observed, ['inherited', 'default', 'canonical']);
  assert.deepEqual(
    result.map((row) => row.ok),
    [false, false, true],
  );
  assert.equal(result[0].phase, 'module-load');
  assert.match(result[1].error!, /SyntaxError/);
  assert.equal(result[2].rows, 1);
  assert.equal(reports.length, 3);
  assert.equal(env.PSModulePath, 'fixture-PowerShell-7');
});

test('CIM control transport records actual owned Node timeouts and continues its bounded comparisons', () => {
  const children: number[] = [];
  const result = runCimModuleControls({
    env: {},
    report: () => {},
    spawn: ((_command, _args, options) => {
      // This is real local Node transport, not Windows PowerShell execution.
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          'console.error(process.pid); console.error("canopy-cim phase=module-load"); setInterval(()=>{},1000)',
        ],
        { ...options, timeout: 1000 },
      );
      const pid = Number(String(child.stderr).split('\n')[0]);
      assert.ok(pid > 0);
      assert.throws(
        () => process.kill(pid, 0),
        (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
      );
      children.push(pid);
      return child;
    }) as typeof spawnSync,
  });
  assert.equal(result.length, 3);
  for (let i = 0; i < result.length; i++) {
    assert.equal(result[i].ok, false);
    assert.equal(result[i].phase, 'module-load');
    assert.ok(children[i] > 0);
  }
});
