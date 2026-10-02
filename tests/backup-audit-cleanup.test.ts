import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

for (const harness of ['smoke-backup', 'smoke-backup-cases'])
  for (const close of ['reject', 'hang'])
    for (const diagnostic of harness === 'smoke-backup-cases'
      ? ['none', 'reject', 'hang']
      : ['none'])
      test(`${harness} preserves primary failure with ${close}ing close / ${diagnostic} diagnostics and removes its owned profile`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'canopy-cleanup-test-'));
        const previousArgs = process.argv;
        try {
          const bundled = await build({
            entryPoints: [`tools/${harness}.mjs`],
            bundle: true,
            platform: 'node',
            format: 'esm',
            write: false,
            plugins: [
              {
                name: 'node-only-audit',
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
                      a.path === 'playwright'
                        ? `export const _electron={launch:async()=>({evaluate:async()=>true,firstWindow:async()=>{globalThis.auditPrimary=new Error('PRIMARY evidence failure');${diagnostic === 'none' ? 'throw globalThis.auditPrimary;' : `return {on(){throw globalThis.auditPrimary;},isClosed(){return false;},locator(){return {innerText:async()=>{${diagnostic === 'reject' ? "throw Error('SECONDARY diagnostics failure');" : 'return new Promise(()=>{});'}}};}};`}},close:async()=>{${close === 'reject' ? "throw Error('SECONDARY close failure');" : 'return new Promise(()=>{});'}}})};export const expect=()=>({toBe(){}});`
                        : 'export async function auditSearch(){};export async function auditRefresh(){};',
                  }));
                  b.onLoad(
                    { filter: /backup-audit-cleanup\.mjs$/ },
                    async (a) => ({
                      contents: (await readFile(a.path, 'utf8')).replace(
                        'timeoutMs = 5000',
                        'timeoutMs = 250',
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
                    contents:
                      "export * from 'node:fs/promises';import {mkdtemp as actual} from 'node:fs/promises';export async function mkdtemp(...args){const path=await actual(...args);globalThis.auditOwnedDirectory=path;return path;}",
                  }));
                },
              },
            ],
          });
          const file = join(directory, `${harness}.mjs`);
          await writeFile(file, bundled.outputFiles[0].contents);
          process.argv = [
            process.argv[0],
            file,
            '/tmp/fake-stage',
            '/tmp/fake-runtime',
          ];
          await assert.rejects(
            import(pathToFileURL(file).href),
            (error) =>
              error === (globalThis as Record<string, unknown>).auditPrimary,
          );
          const owned = (globalThis as Record<string, unknown>)
            .auditOwnedDirectory as string;
          assert.ok(owned.includes('canopy-backup-'));
          await assert.rejects(stat(owned), { code: 'ENOENT' });
        } finally {
          process.argv = previousArgs;
          await rm(directory, { recursive: true, force: true });
        }
      });

// Load the same helper without launching Electron; exercise a real owned Node process.
test('bounded close kills only the owned hung process and reports cleanup failure without a primary failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-owned-cleanup-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
  });
  const unrelated = spawn(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    { stdio: 'ignore' },
  );
  try {
    const result = await build({
      entryPoints: ['tools/backup-audit-cleanup.mjs'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
    });
    const file = join(directory, 'cleanup.mjs');
    await writeFile(file, result.outputFiles[0].contents);
    const { finishBackupAudit } = await import(pathToFileURL(file).href);
    await assert.rejects(
      finishBackupAudit({
        app: { process: () => child, close: () => new Promise(() => {}) },
        directory,
        timeoutMs: 200,
      }),
      /cleanup failed/,
    );
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    unrelated.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});
