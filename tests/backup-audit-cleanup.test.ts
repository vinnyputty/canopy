import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import childProcess, { type ChildProcess } from 'node:child_process';
import { build } from 'esbuild';
import { disposeProcess } from './fixtures/owned-process';

// Bundle each actual harness. Only Playwright/provider UI is substituted;
// AuditOwner captures real disposable Node launches and performs real shutdown.
const state = globalThis as typeof globalThis & {
  backupProbe: {
    child?: ChildProcess;
    unrelated?: ChildProcess;
    directory?: string;
    pending?: Set<Promise<unknown>>;
    primary: unknown;
    release?: () => void;
    writer?: Promise<unknown>;
    write?: (...args: unknown[]) => Promise<unknown>;
    descendant?: number;
  };
};
for (const harness of ['smoke-backup', 'smoke-backup-cases'])
  for (const scenario of [
    'normal',
    'reject-close',
    'pending-close',
    'failed-launch',
    'missing-capture',
    'mismatch',
    'pending-writer',
    'cleanup-fault',
    'parent-exit',
    'pending-launch',
    'refused-signal',
    'unreadable-scope',
    ...(harness === 'smoke-backup-cases'
      ? ['reject-diagnostic', 'pending-diagnostic']
      : []),
  ])
    test(`${harness}: actual launch/cleanup ${scenario}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'canopy-backup-control-'));
      const previousArgs = process.argv;
      state.backupProbe = { primary: new Error('PRIMARY evidence failure') };
      const probe = state.backupProbe;
      const unrelated = childProcess.spawn(
        process.execPath,
        ['-e', 'setInterval(()=>{},1000)'],
        { stdio: 'ignore' },
      );
      probe.unrelated = unrelated;
      try {
        const bundled = await build({
          entryPoints: [`tools/${harness}.mjs`],
          bundle: true,
          platform: 'node',
          format: 'esm',
          write: false,
          plugins: [
            {
              name: 'owned-node-harness',
              setup(b) {
                b.onResolve({ filter: /^@playwright\/test$/ }, () => ({
                  path: 'playwright',
                  namespace: 'mock',
                }));
                b.onResolve(
                  { filter: /^\.\/smoke-(search|refresh)\.mjs$/ },
                  () => ({ path: 'surrounding', namespace: 'mock' }),
                );
                b.onLoad({ filter: /.*/, namespace: 'mock' }, (a) => ({
                  contents:
                    a.path !== 'playwright'
                      ? 'export async function auditSearch(){};export async function auditRefresh(){};'
                      : `import cp from 'node:child_process'; import {once} from 'node:events'; import {writeFile} from 'node:fs/promises';
                export const expect=()=>({toBe(){}});
                export const _electron={launch:async(options)=>{
                  const s=globalThis.backupProbe;
                  ${scenario === 'missing-capture' ? 'throw s.primary;' : ''}
                  s.child=cp.spawn(options.executablePath,['-e',"process.on('message',(m)=>{if(m==='spawn-descendant'){const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.once('spawn',()=>process.send(c.pid));}else process.exit(0)});setInterval(()=>{},1000)"],{detached:process.platform!=='win32',env:options.env,stdio:['ignore','ignore','ignore','ipc']});
                  await once(s.child,'spawn');
                  ${scenario === 'parent-exit' ? `s.child.send('spawn-descendant');[s.descendant]=await once(s.child,'message');` : ''}
                  ${scenario === 'failed-launch' ? 'throw s.primary;' : scenario === 'pending-launch' ? 'return new Promise(r=>s.release=()=>r({process:()=>s.child}));' : ''}
                  return {process:()=>${scenario === 'mismatch' ? 's.unrelated' : 's.child'},evaluate:async()=>true,
                    firstWindow:async()=>{
                      ${scenario === 'pending-writer' ? "s.writer=s.write(s.directory+'/late.txt','owned delayed write');" : ''}
                      ${scenario === 'unreadable-scope' ? 'globalThis.backupProbe.owner.scopes[0].valid=false;' : ''}
                      ${scenario.includes('diagnostic') ? `return {on(){throw s.primary},isClosed(){return false},locator(){return {innerText:async()=>{${scenario === 'pending-diagnostic' ? 'return new Promise(r=>s.release=()=>r("late diagnostic"));' : 'throw Error("DIAGNOSTIC fault");'}}}}};` : 'throw s.primary;'}
                    },close:async()=>{
                      ${scenario === 'parent-exit' ? "const ended=once(s.child,'exit');s.child.send('exit');await ended;throw Error('PARENT close failed after exit');" : scenario === 'reject-close' || scenario === 'refused-signal' ? 'throw Error("CLOSE fault");' : scenario === 'pending-close' ? 'return new Promise(r=>s.release=r);' : "const ended=once(s.child,'exit');s.child.send('exit');await ended;"}
                    }};
                }};`,
                }));
                b.onLoad(
                  { filter: /smoke-backup(?:-cases)?\.mjs$/ },
                  async (a) => ({
                    contents: (await readFile(a.path, 'utf8'))
                      .replace(
                        'executable: resolve(runtime)',
                        'executable: resolve(runtime), graceMs:1000, killMs:3000, operationMs:3000' +
                          (scenario === 'refused-signal'
                            ? ", signalGroup:()=>{throw Error('OWNED signal refused')}"
                            : ''),
                      )
                      .replace(
                        '30000,',
                        scenario === 'pending-launch' ? '150,' : '30000,',
                      )
                      .replace(
                        'let confirmed = false;',
                        'globalThis.backupProbe.pending=pending; globalThis.backupProbe.write=writeFile; globalThis.backupProbe.owner=owner; let confirmed = false;',
                      ),
                    loader: 'js',
                  }),
                );
                b.onLoad(
                  { filter: /backup-audit-cleanup\.mjs$/ },
                  async (a) => ({
                    contents: (await readFile(a.path, 'utf8')).replace(
                      'timeoutMs = 5000',
                      'timeoutMs = 3000',
                    ),
                    loader: 'js',
                  }),
                );
                b.onResolve({ filter: /^node:fs\/promises$/ }, (a) =>
                  a.namespace === 'fs-probe'
                    ? undefined
                    : { path: 'fs', namespace: 'fs-probe' },
                );
                b.onLoad({ filter: /.*/, namespace: 'fs-probe' }, () => ({
                  contents: `export * from 'node:fs/promises'; import {mkdtemp as actual,rm as actualRm,writeFile as actualWrite} from 'node:fs/promises'; export async function mkdtemp(...args){const path=await actual(...args);globalThis.backupProbe.directory=path;return path;} export async function writeFile(...args){${scenario === 'pending-writer' ? 'await new Promise(r=>globalThis.backupProbe.release=r);' : ''}return actualWrite(...args);} export async function rm(...args){${scenario === 'cleanup-fault' ? 'throw Error("REMOVAL fault");' : 'return actualRm(...args);'}}`,
                }));
              },
            },
          ],
        });
        const file = join(directory, 'harness.mjs');
        await writeFile(file, bundled.outputFiles[0].contents);
        process.argv = [
          process.argv[0],
          file,
          '/tmp/owned-node-stage-unused',
          process.execPath,
        ];
        let caught: unknown;
        try {
          await import(pathToFileURL(file).href);
        } catch (error) {
          caught = error;
        }
        if (scenario === 'normal') assert.equal(caught, probe.primary);
        else {
          assert.ok(caught instanceof AggregateError);
          if (scenario === 'mismatch' || scenario === 'pending-launch') {
            assert.match(
              String(caught.cause),
              /does not match|launch timed out/,
            );
            assert.equal(caught.errors[0], caught.cause);
          } else {
            assert.equal(caught.cause, probe.primary);
            assert.equal(caught.errors[0], probe.primary);
          }
        }
        const retained = [
          'pending-close',
          'failed-launch',
          'missing-capture',
          'mismatch',
          'pending-writer',
          'cleanup-fault',
          'pending-diagnostic',
          'pending-launch',
          'refused-signal',
          'unreadable-scope',
        ].includes(scenario);
        if (retained) await access(probe.directory!);
        else await assert.rejects(access(probe.directory!), { code: 'ENOENT' });
        if (
          probe.child &&
          scenario !== 'refused-signal' &&
          scenario !== 'unreadable-scope'
        )
          assert.ok(
            probe.child.exitCode !== null || probe.child.signalCode !== null,
          );
        assert.equal(unrelated.exitCode, null);
        assert.equal(unrelated.signalCode, null);
        if (probe.release) {
          probe.release();
          await Promise.allSettled([...(probe.pending ?? [])]);
          await probe.writer;
        }
        if (probe.descendant)
          assert.throws(() => process.kill(probe.descendant!, 0), {
            code: 'ESRCH',
          });
        if (scenario === 'pending-writer')
          assert.equal(
            await readFile(join(probe.directory!, 'late.txt'), 'utf8'),
            'owned delayed write',
          );
      } finally {
        process.argv = previousArgs;
        await disposeProcess(probe.child);
        await disposeProcess(unrelated);
        if (probe.directory)
          await rm(probe.directory, { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
      }
    });

// Actual catch/finally retains raw falsy primaries with shared AggregateError order.
for (const primary of [undefined, null, false, 0])
  test(`missing backup owner retains caught ${String(primary)}`, async () => {
    const bundled = await build({
      entryPoints: ['tools/backup-audit-cleanup.mjs'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
    });
    const directory = await mkdtemp(join(tmpdir(), 'canopy-backup-errors-'));
    try {
      const file = join(directory, 'adapter.mjs');
      await writeFile(file, bundled.outputFiles[0].contents);
      const { finishBackupAudit } = await import(pathToFileURL(file).href);
      await assert.rejects(
        finishBackupAudit({ directory, failure: primary, failed: true }),
        (error: AggregateError) =>
          error.cause === primary && error.errors[0] === primary,
      );
      await access(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

// Execute each production catch/finally with healthy and forced Node shutdown,
// including raw primaries plus a real profile-removal denial.
for (const harness of ['smoke-backup', 'smoke-backup-cases'])
  for (const mode of [
    'healthy',
    'forced',
    'fresh-error',
    undefined,
    null,
    false,
    0,
  ])
    test(`${harness}: source finally ${String(mode)} ordering and outcome`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'canopy-backup-finally-'));
      const adapter = await build({
        entryPoints: ['tools/backup-audit-cleanup.mjs'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false,
        plugins: [
          {
            name: 'removal-denial',
            setup(b) {
              if (
                mode === 'healthy' ||
                mode === 'forced' ||
                mode === 'fresh-error'
              )
                return;
              b.onResolve({ filter: /^node:fs\/promises$/ }, () => ({
                path: 'fs',
                namespace: 'deny',
              }));
              b.onLoad({ filter: /.*/, namespace: 'deny' }, () => ({
                contents:
                  "export async function rm(){throw Error('PROFILE removal denied')}",
              }));
            },
          },
        ],
      });
      const file = join(directory, 'cleanup.mjs');
      await writeFile(file, adapter.outputFiles[0].contents);
      const { finishBackupAudit } = await import(pathToFileURL(file).href);
      const { AuditOwner } = await import('../tools/audit-lifecycle.mjs');
      const owner = new AuditOwner({
        profile: directory,
        executable: process.execPath,
        graceMs: 1000,
        killMs: 3000,
        operationMs: 3000,
      });
      let child: ChildProcess | undefined;
      try {
        await owner.launch(async () => {
          child = childProcess.spawn(
            process.execPath,
            [
              '-e',
              "process.on('message',()=>process.exit(0));setInterval(()=>{},1000)",
            ],
            {
              env: { ...process.env, CANOPY_USER_DATA: directory },
              detached: process.platform !== 'win32',
              stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            },
          );
          await new Promise<void>((resolve, reject) => {
            child!.once('spawn', resolve);
            child!.once('error', reject);
          });
          return child;
        });
        owner.confirm(child!);
        if (mode === 'fresh-error') {
          const shutdown = owner.shutdown.bind(owner);
          let calls = 0;
          owner.shutdown = async (close) => {
            const result = await shutdown(close);
            if (++calls === 2)
              result.errors.push(new Error('FRESH shutdown fault'));
            return result;
          };
        }
        const text = await readFile(`tools/${harness}.mjs`, 'utf8');
        const tail = text.slice(text.lastIndexOf('} catch (error) {') + 2);
        const AsyncFunction = Object.getPrototypeOf(
          async function () {},
        ).constructor;
        const run = new AsyncFunction(
          'owner',
          'confirmed',
          'pending',
          'app',
          'directory',
          'page',
          'finishBackupAudit',
          'primary',
          'success',
          `let failure;let failed=false;try {if(!success)throw primary;} ${tail}`,
        );
        const app = {
          close: async () => {
            if (mode === 'forced') throw Error('GRACEFUL close refused');
            await new Promise<void>((resolve, reject) => {
              child!.once('exit', () => resolve());
              child!.once('error', reject);
              child!.send('normal');
            });
          },
        };
        const operation = run(
          owner,
          true,
          new Set(),
          app,
          directory,
          undefined,
          finishBackupAudit,
          mode,
          mode === 'healthy' || mode === 'forced' || mode === 'fresh-error',
        );
        if (mode === 'healthy') await operation;
        else
          await assert.rejects(operation, (error: AggregateError) => {
            assert.ok(error instanceof AggregateError);
            if (mode === 'forced') assert.match(error.message, /close refused/);
            else if (mode === 'fresh-error')
              assert.match(error.message, /Fresh audit shutdown failed/);
            else {
              assert.equal(error.cause, mode);
              assert.equal(error.errors[0], mode);
              assert.match(error.errors[1].message, /removal denied/);
            }
            return true;
          });
        if (mode === 'healthy' || mode === 'forced' || mode === 'fresh-error')
          await assert.rejects(access(directory), { code: 'ENOENT' });
        else await access(directory);
      } finally {
        owner.restore();
        await disposeProcess(child);
        await rm(directory, { recursive: true, force: true });
      }
    });
