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
    let exitFailure;
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
      // execFile reports script exits through its callback. Only an observed,
      // matching unsignaled exit can establish that this was not a transport fault.
      if (
        exitFailure &&
        !(
          closed &&
          status === exitFailure.code &&
          signal === null &&
          !child.killed
        )
      )
        recordFailure(exitFailure);
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
              if (failure !== null && failure !== undefined) {
                if (
                  failure instanceof Error &&
                  Number.isSafeInteger(failure.code) &&
                  failure.code > 0 &&
                  failure.signal === null &&
                  failure.killed === false
                )
                  exitFailure = failure;
                else recordFailure(failure);
              }
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
      if (stdoutBytes <= options.maxBuffer) stdout += chunk;
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
      if (stderrBytes > options.maxBuffer)
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

// Read-only module-load comparisons, separate from required identity snapshots.
// Child-local context changes never become production settings or kill authority.
export async function runCimContextControls({
  command = 'powershell.exe',
  argsFor = (script) => [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ],
  env = process.env,
  report = (record) =>
    console.log('Windows CIM context control:', JSON.stringify(record)),
} = {}) {
  const started = Date.now();
  const results = [];
  const inherited = powershellEnvironment(env);
  const value = (key) =>
    Object.entries(inherited).find(
      ([name]) => name.toUpperCase() === key.toUpperCase(),
    )?.[1];
  const changed = (keys, additions) => ({
    ...Object.fromEntries(
      Object.entries(inherited).filter(
        ([key]) => !keys.includes(key.toUpperCase()),
      ),
    ),
    ...additions,
  });
  const contexts = [
    ['inherited', inherited, undefined, true],
    [
      'system-cwd',
      inherited,
      value('SystemRoot'),
      Boolean(value('SystemRoot')),
    ],
    [
      'cache-disabled',
      changed(['PSMODULEANALYSISCACHEPATH'], {
        PSModuleAnalysisCachePath: 'NUL',
      }),
      undefined,
      true,
    ],
    [
      'runner-temp',
      changed(['TEMP', 'TMP'], {
        TEMP: value('RUNNER_TEMP'),
        TMP: value('RUNNER_TEMP'),
      }),
      undefined,
      Boolean(value('RUNNER_TEMP')),
    ],
  ];
  for (const [mode, childEnv, cwd, available] of contexts) {
    // Four 10s operations plus four 2s close allowances fit below 60s.
    // Reserve close observation within the remaining overall allowance.
    const timeout = Math.min(10000, 58000 - (Date.now() - started));
    if (!available || timeout <= 0) {
      const record = {
        mode,
        ok: false,
        error: available ? 'CONTEXT_BUDGET_EXHAUSTED' : 'CONTEXT_UNAVAILABLE',
        closed: true,
      };
      results.push(record);
      report(record);
      continue;
    }
    const result = await asyncControl(
      command,
      argsFor(contextScript),
      {
        env: childEnv,
        cwd,
        timeout,
        windowsHide: true,
        maxBuffer: 16384,
        encoding: 'utf8',
      },
      'spawn-ignore',
    );
    let metadata;
    let complete = false;
    let schemaError = false;
    try {
      const lines = result.stdout.trim().split(/\r?\n/);
      const parsed = JSON.parse(lines[0]);
      const keys = [
        'imageHash',
        'psHomeHash',
        'cwdHash',
        'tempHash',
        'cacheHash',
        'manifestHash',
        'manifestReadable',
        'tempExists',
        'cacheParentExists',
        'version',
        'edition',
        'is64Bit',
        'dllArchitecture',
      ];
      if (
        Object.keys(parsed).sort().join(',') !== keys.sort().join(',') ||
        [
          'imageHash',
          'psHomeHash',
          'cwdHash',
          'tempHash',
          'cacheHash',
          'manifestHash',
        ].some(
          (key) =>
            !(
              parsed[key] === null ||
              (typeof parsed[key] === 'string' &&
                /^[a-f0-9]{64}$/.test(parsed[key]))
            ),
        ) ||
        ['manifestReadable', 'tempExists', 'cacheParentExists', 'is64Bit'].some(
          (key) => typeof parsed[key] !== 'boolean',
        ) ||
        typeof parsed.version !== 'string' ||
        !/^\d{1,10}(\.\d{1,10}){1,3}$/.test(parsed.version) ||
        !['Desktop', 'Core'].includes(parsed.edition) ||
        !['None', 'MSIL', 'X86', 'Amd64', 'Arm', 'unknown'].includes(
          parsed.dllArchitecture,
        ) ||
        lines.length > 2 ||
        (lines.length === 2 && lines[1] !== 'canopy-context complete')
      )
        throw new Error();
      metadata = parsed;
      complete = lines.length === 2;
    } catch {
      schemaError = true;
    }
    const record = {
      mode,
      childPid: result.pid,
      observerPid: process.pid,
      bazelTest: Boolean(env.TEST_TARGET),
      nodeTest: Boolean(env.NODE_TEST_CONTEXT),
      ok:
        result.closed &&
        !result.hasError &&
        result.status === 0 &&
        complete &&
        !schemaError,
      status: result.status,
      signal: result.signal,
      closed: result.closed,
      error: result.hasError
        ? 'CONTEXT_OPERATION_FAILED'
        : schemaError
          ? 'CONTEXT_SCHEMA_FAILED'
          : !complete || result.status !== 0
            ? 'CONTEXT_INCOMPLETE'
            : undefined,
      code: result.hasError
        ? codes.has(result.error?.code)
          ? result.error.code
          : 'CHILD_ERROR'
        : null,
      elapsedMs: Date.now() - started,
      timeoutMs: timeout,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      metadata,
      phase: result.phase ?? 'startup-or-script-entry',
    };
    results.push(record);
    if (!result.closed) {
      const failure = new Error('CIM context control closure unconfirmed');
      Object.defineProperties(failure, {
        child: { value: result.child },
        primary: { value: result.error },
        cleanupErrors: { value: result.cleanupErrors },
        record: { value: record },
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
  return results;
}

const contextScript = String.raw`
$ErrorActionPreference = 'Stop';
[Console]::Error.WriteLine('canopy-cim phase=script-entry'); [Console]::Error.Flush();
function Hash($text) {
  if ([string]::IsNullOrEmpty($text)) { return $null }
  $sha = [System.Security.Cryptography.SHA256]::Create();
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
$manifest = $PSHOME + '\Modules\CimCmdlets\CimCmdlets.psd1';
$dll = $PSHOME + '\Modules\CimCmdlets\Microsoft.Management.Infrastructure.CimCmdlets.dll';
$readable = $false; $manifestHash = $null; $architecture = 'unknown';
try { $stream = [IO.File]::OpenRead($manifest); try { $sha = [Security.Cryptography.SHA256]::Create(); try { $manifestHash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant(); $readable = $true } finally { $sha.Dispose() } } finally { $stream.Dispose() } } catch {}
try { $architecture = [Reflection.AssemblyName]::GetAssemblyName($dll).ProcessorArchitecture.ToString() } catch {}
$cache = $env:PSModuleAnalysisCachePath;
if ([string]::IsNullOrEmpty($cache)) { $cache = [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'), 'Microsoft\Windows\PowerShell\ModuleAnalysisCache') }
$temp = [IO.Path]::GetTempPath();
$metadata = @{
 imageHash = Hash ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName);
 psHomeHash = Hash $PSHOME; cwdHash = Hash ([Environment]::CurrentDirectory);
 tempHash = Hash $temp; cacheHash = Hash $cache; manifestHash = $manifestHash;
 manifestReadable = $readable; tempExists = [IO.Directory]::Exists($temp);
 cacheParentExists = [IO.Directory]::Exists([IO.Path]::GetDirectoryName($cache));
 version = $PSVersionTable.PSVersion.ToString(); edition = $PSVersionTable.PSEdition;
 is64Bit = [Environment]::Is64BitProcess; dllArchitecture = $architecture;
};
# Serialize the fixed scalar schema without autoloading the Utility module.
function Quote($text) {
  if ($null -eq $text) { return 'null' }
  return '"' + $text.Replace('\','\\').Replace('"','\"').Replace([string][char]13,'\r').Replace([string][char]10,'\n') + '"'
}
$items = @();
foreach ($key in $metadata.Keys) {
  $value = $metadata[$key];
  if ($value -is [bool]) { $encoded = $value.ToString().ToLowerInvariant() }
  else { $encoded = Quote $value }
  $items += (Quote $key) + ':' + $encoded;
}
[Console]::Out.WriteLine('{' + [string]::Join(',', $items) + '}'); [Console]::Out.Flush();
[Console]::Error.WriteLine('canopy-cim phase=module-load'); [Console]::Error.Flush();
Import-Module CimCmdlets;
[Console]::Out.WriteLine('canopy-context complete'); [Console]::Out.Flush();
`;
