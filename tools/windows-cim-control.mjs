import { spawnSync } from 'node:child_process';
import {
  powershellEnvironment,
  windowsSnapshotScript,
} from './audit-lifecycle.mjs';

// Diagnostic comparisons run sequentially before concurrent unit/portable work.
// Failures are evidence, not a substitute for required native lifecycle tests.
export function runCimModuleControls({
  spawn = spawnSync,
  env = process.env,
  report = (record) =>
    console.log('Windows CIM module control:', JSON.stringify(record)),
} = {}) {
  const results = [];
  for (const mode of ['inherited-name', 'default-name', 'default-canonical']) {
    let script = windowsSnapshotScript();
    const metadata = String.raw`
$paths = $env:PSModulePath -split [System.IO.Path]::PathSeparator;
$ps7 = 0;
foreach ($path in $paths) { if ($path -match '\\PowerShell\\7\\') { $ps7++; } }
$manifest = $PSHOME + '\Modules\CimCmdlets\CimCmdlets.psd1';
[Console]::Error.WriteLine("canopy-cim module-resolution version=$($PSVersionTable.PSVersion) edition=$($PSVersionTable.PSEdition) paths=$($paths.Count) ps7Paths=$ps7 canonicalExists=$([System.IO.File]::Exists($manifest))");
[Console]::Error.Flush();
`;
    script = script.replace(
      'Mark "module-load" 0;',
      metadata + '\nMark "module-load" 0;',
    );
    if (mode === 'default-canonical')
      script = script.replace(
        'Import-Module CimCmdlets;',
        'Import-Module $manifest;',
      );
    const started = Date.now();
    const result = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        env:
          mode === 'inherited-name' ? { ...env } : powershellEnvironment(env),
        timeout: 15000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
      },
    );
    let rows;
    let parseError;
    if (result.status === 0 && !result.error) {
      try {
        const parsed = JSON.parse(result.stdout);
        rows = Array.isArray(parsed) ? parsed : [parsed];
        if (
          !rows.length ||
          rows.some(
            (row) =>
              !row ||
              !Number.isSafeInteger(row.pid) ||
              !Number.isSafeInteger(row.ppid) ||
              !('start' in row),
          )
        )
          throw new Error('Incomplete CIM control snapshot');
      } catch (error) {
        parseError = String(error);
      }
    }
    const record = {
      mode,
      ok: result.status === 0 && !result.error && !parseError,
      elapsedMs: Date.now() - started,
      timeoutMs: 15000,
      status: result.status,
      signal: result.signal,
      code: result.error?.code ?? null,
      error: result.error ? String(result.error) : parseError,
      phase:
        [...String(result.stderr).matchAll(/canopy-cim phase=([\w-]+)/g)].at(
          -1,
        )?.[1] ?? 'startup-or-script-entry',
      rows: rows?.length,
      stderr: String(result.stderr ?? '').slice(0, 4096),
      stdout:
        result.status === 0 && !parseError
          ? undefined
          : String(result.stdout ?? '').slice(0, 4096),
    };
    results.push(record);
    report(record);
  }
  return results;
}
