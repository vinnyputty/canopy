import { execFile, spawn, spawnSync } from 'node:child_process';
import { cpus, freemem } from 'node:os';
import {
  powershellEnvironment,
  windowsSnapshotScript,
} from './audit-lifecycle.mjs';

const limit = 16 * 1024 * 1024;
const modes = ['exec-open', 'exec-end', 'spawn-ignore'];

// Read-only diagnostics: these results never establish process ownership.
// Called inside the native lifecycle test worker, not the pre-build launcher.
export async function runCimInputControls({
  command = 'powershell.exe',
  argsFor = (script) => [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ],
  env = process.env,
  timeoutMs = 15000,
  report = (record) =>
    console.log('Windows CIM input control:', JSON.stringify(record)),
} = {}) {
  const results = [];
  const options = {
    env: powershellEnvironment(env),
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: limit,
    encoding: 'utf8',
  };
  const raw = windowsSnapshotScript();
  const variants = [
    ['raw', raw],
    [
      'canonical',
      raw.replace(
        'Import-Module CimCmdlets;',
        String.raw`Import-Module ($PSHOME + '\Modules\CimCmdlets\CimCmdlets.psd1');`,
      ),
    ],
  ];
  const context = {
    observerPid: process.pid,
    nodeVersion: process.version,
    bazelTest: Boolean(env.TEST_TARGET),
    nodeTest: Boolean(env.NODE_TEST_CONTEXT),
    tempConfigured: Boolean(env.TEMP || env.TMP || env.TMPDIR),
    moduleAnalysisCacheConfigured: Boolean(env.PSModuleAnalysisCachePath),
    processors: cpus().length,
  };
  // Same raw script and context establish whether the pre-build sync result
  // transfers to this worker. Sync children consume an empty input then EOF.
  for (const [variant, script] of variants) {
    for (const mode of variant === 'raw' ? ['sync', ...modes] : modes) {
      const started = Date.now();
      const cpuStarted = process.cpuUsage();
      let result;
      if (mode === 'sync') {
        const child = spawnSync(command, argsFor(script), options);
        result = {
          ...child,
          killed: child.error?.code === 'ETIMEDOUT',
          closed: !child.error || child.error.code !== 'ETIMEDOUT',
          stderrEvents: null,
          spawnedMs: null,
        };
        // spawnSync waits for exit/stdio closure even when its timeout kills.
        if (child.error?.code === 'ETIMEDOUT')
          result.closed = child.signal !== null;
      } else {
        result = await asyncControl(command, argsFor(script), options, mode);
      }
      let rows;
      let parseError;
      if (result.status === 0 && !result.error) {
        try {
          const parsed = JSON.parse(String(result.stdout));
          const snapshot = Array.isArray(parsed) ? parsed : [parsed];
          if (
            !snapshot.length ||
            snapshot.some(
              (row) =>
                !row ||
                !Number.isSafeInteger(row.pid) ||
                !Number.isSafeInteger(row.ppid) ||
                !('start' in row),
            )
          )
            throw new Error('Incomplete CIM input-control snapshot');
          rows = snapshot.length;
        } catch (error) {
          parseError = String(error);
        }
      }
      const record = {
        ...context,
        variant,
        mode,
        ok:
          result.closed && result.status === 0 && !result.error && !parseError,
        elapsedMs: Date.now() - started,
        timeoutMs,
        status: result.status,
        signal: result.signal,
        killed: result.killed,
        childPid: result.pid ?? null,
        code: result.error?.code ?? null,
        error: result.error ? String(result.error).slice(0, 4096) : parseError,
        closed: result.closed,
        spawnedMs: result.spawnedMs,
        stderrEvents: result.stderrEvents,
        observerCpuMicros: process.cpuUsage(cpuStarted),
        hostFreeMemoryBytes: freemem(),
        phase:
          result.phase ??
          [
            ...String(result.stderr ?? '').matchAll(
              /canopy-cim phase=([\w-]+)/g,
            ),
          ].at(-1)?.[1] ??
          'startup-or-script-entry',
        rows,
        stderr: String(result.stderr ?? '').slice(0, 4096),
        stdout:
          result.status === 0 && !parseError
            ? undefined
            : String(result.stdout ?? '').slice(0, 4096),
      };
      results.push(record);
      report(record);
      // Never continue spawning comparisons after unestablished child closure.
      if (!result.closed) return results;
    }
  }
  return results;
}

function asyncControl(command, args, options, mode) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    let error;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let phase;
    let phaseTail = '';
    let spawnedMs = null;
    const stderrEvents = [];
    let settled = false;
    let timer;
    let closureTimer;
    const done = (status, signal, closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closureTimer);
      resolve({
        status,
        signal,
        closed,
        pid: child?.pid ?? null,
        killed: child?.killed ?? false,
        error,
        stdout,
        stderr,
        spawnedMs,
        stderrEvents,
        phase,
      });
    };
    try {
      child =
        mode === 'spawn-ignore'
          ? spawn(command, args, {
              ...options,
              stdio: ['ignore', 'pipe', 'pipe'],
            })
          : execFile(command, args, options, (failure) => {
              error ??= failure;
            });
    } catch (failure) {
      error = failure;
      done(null, null, true); // No child was launched.
      return;
    }
    child.once('spawn', () => {
      spawnedMs = Date.now() - started;
    });
    child.once('error', (failure) => {
      error ??= failure;
    });
    child.once('close', (status, signal) => done(status, signal, true));
    child.stdout?.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= limit) stdout += chunk;
      else {
        error ??= Object.assign(
          new Error('CIM control output exceeded maxBuffer'),
          { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
        );
        child.kill();
      }
    });
    child.stderr?.on('data', (chunk) => {
      const text = phaseTail + chunk;
      phase =
        [...text.matchAll(/canopy-cim phase=([\w-]+)/g)].at(-1)?.[1] ?? phase;
      phaseTail = text.slice(-128);
      if (stderrEvents.length < 16)
        stderrEvents.push({
          elapsedMs: Date.now() - started,
          bytes: Buffer.byteLength(chunk),
        });
      if (stderr.length < 4096) stderr = (stderr + chunk).slice(0, 4096);
    });
    // end() sends EOF, not input. Production execFile remains unchanged.
    child.stdin?.on('error', (failure) => {
      error ??= failure;
    });
    if (mode === 'exec-end') child.stdin?.end();
    timer = setTimeout(() => {
      error ??= Object.assign(new Error('CIM input control timed out'), {
        code: 'ETIMEDOUT',
      });
      child.kill(); // Only this diagnostic's directly launched child handle.
      closureTimer = setTimeout(() => done(null, null, false), 2000);
    }, options.timeout);
  });
}
