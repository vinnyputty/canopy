import { execFile, spawn, spawnSync } from 'node:child_process';
import { cpus, freemem } from 'node:os';
import {
  powershellEnvironment,
  windowsSnapshotScript,
} from './audit-lifecycle.mjs';

const limit = 16 * 1024 * 1024;
const modes = ['exec-open', 'exec-end', 'spawn-ignore'];
const phasePattern =
  /canopy-cim phase=(script-entry|module-load|query|projection|serialization|complete)(?=\s|$)/g;
const codes = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOBUFS',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  'ABORT_ERR',
]);
const lastPhase = (text) => [...text.matchAll(phasePattern)].at(-1)?.[1];

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
  // Sync's empty input/EOF baseline has Node's synchronous exit-wait contract.
  for (const [variant, script] of variants) {
    for (const mode of variant === 'raw' ? ['sync', ...modes] : modes) {
      const started = Date.now();
      const cpuStarted = process.cpuUsage();
      let result;
      if (mode === 'sync') {
        const child = spawnSync(command, argsFor(script), options);
        result = {
          ...child,
          hasError: Object.hasOwn(child, 'error'),
          killed: child.error?.code === 'ETIMEDOUT',
          closed: child.error?.code !== 'ETIMEDOUT' || child.signal !== null,
          stderrEvents: null,
          spawnedMs: null,
          stdoutBytes: Buffer.byteLength(child.stdout ?? ''),
          stderrBytes: Buffer.byteLength(child.stderr ?? ''),
          phase: lastPhase(String(child.stderr ?? '')),
        };
      } else
        result = await asyncControl(command, argsFor(script), options, mode);
      let rows;
      let parseError;
      if (result.status === 0 && !result.hasError) {
        let parsed;
        try {
          parsed = JSON.parse(String(result.stdout));
        } catch {
          parseError = 'INVALID_SNAPSHOT_JSON';
        }
        if (!parseError) {
          const snapshot = Array.isArray(parsed) ? parsed : [parsed];
          if (
            !snapshot.length ||
            snapshot.some(
              (row) =>
                !row ||
                Object.keys(row).sort().join(',') !== 'pid,ppid,start' ||
                !Number.isSafeInteger(row.pid) ||
                row.pid < 0 ||
                !Number.isSafeInteger(row.ppid) ||
                row.ppid < 0 ||
                !(row.start === null || typeof row.start === 'string'),
            )
          )
            parseError = 'INVALID_SNAPSHOT_SCHEMA';
          else rows = snapshot.length;
        }
      }
      const record = {
        ...context,
        variant,
        mode,
        ok:
          result.closed &&
          result.status === 0 &&
          !result.hasError &&
          !parseError,
        elapsedMs: Date.now() - started,
        timeoutMs,
        status: result.status,
        signal: result.signal,
        killed: result.killed,
        childPid: result.pid ?? null,
        code: result.hasError
          ? codes.has(result.error?.code)
            ? result.error.code
            : 'CHILD_ERROR'
          : null,
        error: result.hasError
          ? 'CHILD_OPERATION_FAILED'
          : (parseError ?? (result.status !== 0 ? 'NONZERO_EXIT' : undefined)),
        operationFailed: result.hasError,
        closed: result.closed,
        cleanupCodes: (result.cleanupErrors ?? []).map((failure) =>
          codes.has(failure?.code) ? failure.code : 'CONTROL_CLEANUP_FAILED',
        ),
        spawnedMs: result.spawnedMs,
        stderrEvents: result.stderrEvents,
        observerCpuMicros: process.cpuUsage(cpuStarted),
        hostFreeMemoryBytes: freemem(),
        phase: result.phase ?? 'startup-or-script-entry',
        rows,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
      };
      results.push(record);
      if (!result.closed) {
        const failure = new Error(
          `CIM input control closure unconfirmed: ${JSON.stringify(record)}`,
        );
        // Retain the exact handle and first error without serializing untrusted
        // command/output strings through Error inspection or diagnostic records.
        Object.defineProperties(failure, {
          child: { value: result.child },
          primary: { value: result.error },
          record: { value: record },
          cleanupErrors: { value: result.cleanupErrors },
        });
        try {
          report(record);
        } catch (secondary) {
          Object.defineProperty(failure, 'reportError', { value: secondary });
        }
        throw failure;
      }
      report(record);
    }
  }
  return results;
}

function asyncControl(command, args, options, mode) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    let error;
    let hasError = false;
    const recordFailure = (failure) => {
      if (hasError) return;
      hasError = true;
      error = failure;
    };
    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let phase;
    let phaseTail = '';
    let spawnedMs = null;
    const stderrEvents = [];
    const cleanupErrors = [];
    const listeners = [];
    let settled = false;
    let stopping = false;
    let timer;
    let closureTimer;
    const listen = (emitter, event, handler) => {
      if (!emitter) return;
      emitter.on(event, handler);
      listeners.push([emitter, event, handler]);
    };
    const done = (status, signal, closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closureTimer);
      for (const [emitter, event, handler] of listeners)
        emitter.removeListener(event, handler);
      if (!closed) {
        // Release only this control's pipes/observer handles; failure retains
        // child identity and prohibits further control/fixture launches.
        for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
          try {
            stream?.destroy();
          } catch (failure) {
            cleanupErrors.push(failure);
          }
        }
        try {
          child?.unref();
        } catch (failure) {
          cleanupErrors.push(failure);
        }
      }
      resolve({
        status,
        signal,
        closed,
        child,
        pid: child?.pid ?? null,
        killed: child?.killed ?? false,
        error,
        hasError,
        cleanupErrors,
        stdout,
        stdoutBytes,
        stderrBytes,
        spawnedMs,
        stderrEvents,
        phase,
      });
    };
    const stop = (failure) => {
      recordFailure(failure);
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(timer);
      // The same finite close allowance covers timeout, stream limits and
      // transport faults. Only the directly launched handle receives a signal.
      closureTimer = setTimeout(() => done(null, null, false), 2000);
      try {
        if (!child.kill('SIGKILL'))
          cleanupErrors.push(
            new Error('Control termination request was not accepted'),
          );
      } catch (failure) {
        cleanupErrors.push(failure);
      }
    };
    // Own the finite deadline rather than leaving an uncancellable native
    // timeout behind if direct-handle termination/close cannot be confirmed.
    try {
      child =
        mode === 'spawn-ignore'
          ? spawn(command, args, {
              ...options,
              timeout: 0,
              stdio: ['ignore', 'pipe', 'pipe'],
            })
          : execFile(command, args, { ...options, timeout: 0 }, (failure) => {
              // Native callback null/undefined means successful completion;
              // explicit event/catch faults always record presence separately.
              if (failure !== null && failure !== undefined)
                recordFailure(failure);
            });
    } catch (failure) {
      recordFailure(failure);
      done(null, null, true); // No child was launched.
      return;
    }
    listen(child, 'spawn', () => {
      spawnedMs = Date.now() - started;
    });
    listen(child, 'error', (failure) => stop(failure));
    listen(child, 'close', (status, signal) => done(status, signal, true));
    listen(child.stdout, 'data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes <= limit) stdout += chunk;
      else
        stop(
          Object.assign(new Error('CIM control stdout exceeded maxBuffer'), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          }),
        );
    });
    listen(child.stderr, 'data', (chunk) => {
      const text = phaseTail + chunk;
      phase = lastPhase(text) ?? phase;
      phaseTail = text.slice(-128);
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrEvents.length < 16)
        stderrEvents.push({
          elapsedMs: Date.now() - started,
          bytes: Buffer.byteLength(chunk),
        });
      if (stderrBytes > limit)
        stop(
          Object.assign(new Error('CIM control stderr exceeded maxBuffer'), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          }),
        );
    });
    listen(child.stdout, 'error', (failure) => stop(failure));
    listen(child.stderr, 'error', (failure) => stop(failure));
    listen(child.stdin, 'error', (failure) => stop(failure));
    timer = setTimeout(
      () =>
        stop(
          Object.assign(new Error('CIM input control timed out'), {
            code: 'ETIMEDOUT',
          }),
        ),
      options.timeout,
    );
    // end() sends EOF, not input. Production execFile remains unchanged.
    if (mode === 'exec-end') {
      try {
        child.stdin?.end();
      } catch (failure) {
        stop(failure);
      }
    }
  });
}
