import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';

const driverURL = new URL('../tools/perf-desktop.mjs', import.meta.url);
const source = readFileSync(driverURL, 'utf8');
const ast = ts.createSourceFile(
  'driver.mjs',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const boundary = ast.statements.find((statement) =>
  statement.getText(ast).includes("import('./audit-lifecycle.mjs')"),
);
assert.ok(boundary);
// Execute the actual launcher prefix, including real FS/hash checks. This stops
// at its runtime boundary, never imports Electron/Playwright, and launches nothing.
const prefix = source
  .slice(0, boundary.getStart(ast))
  .replaceAll('import.meta.url', 'driverURL');
const code = ts.transpileModule(
  `(async () => {${prefix}\nreturn 'guard-complete';})()`,
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText;
const require = createRequire(import.meta.url);
const hash = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const harnessFiles = [
  'tests/fixtures/performance-main.ts',
  'tests/fixtures/large-trees.ts',
  'tests/fixtures/performance-preload.ts',
  'tests/fixtures/performance-ui.ts',
  'tools/perf-desktop.mjs',
  'tools/audit-lifecycle.mjs',
  'tools/prepare-perf-desktop.mjs',
];
const bundleFiles = [
  'performance-main.cjs',
  'production-preload.cjs',
  'preload.cjs',
  'renderer/app.js',
  'renderer/app.css',
  'renderer/audit.js',
  'renderer/index.html',
];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'canopy-perf-approval-'));
  const base = '5cdf719fac9650f9ef31d41d880942af657ff98b',
    candidate = 'c'.repeat(40);
  const harness = Object.fromEntries(
    harnessFiles.map((file) => [
      file,
      hash(readFileSync(new URL(`../${file}`, import.meta.url))),
    ]),
  );
  const builds = ['base', 'candidate'].map((label) => {
    const stage = join(directory, label);
    const files = Object.fromEntries(
      bundleFiles.map((file) => {
        const bytes = `${label}/${file}`;
        mkdirSync(join(stage, 'dist', file, '..'), { recursive: true });
        writeFileSync(join(stage, 'dist', file), bytes);
        return [file, hash(bytes)];
      }),
    );
    return { label, source: label === 'base' ? base : candidate, stage, files };
  });
  const counts = ['jira', 'github'].flatMap((provider) =>
    ['wide', 'tiered', 'deep'].map((shape) => ({
      provider,
      shape,
      root: `${provider}/${shape}`,
      keyboardNextKey: 'second',
      treeMiddleKey: 'middle',
      treeLastKey: 'last',
      savedMiddleKey: 'middle',
      savedLastKey: 'last',
      treeMembersSha256: 'a'.repeat(64),
      filterMembersSha256: 'b'.repeat(64),
      savedMembersSha256: 'c'.repeat(64),
      issues: 100,
      expandedRows: 90,
      collapsedRows: 1,
      filterRows: 20,
      savedRows: 270,
    })),
  );
  const manifest = {
    base,
    candidate,
    harnessSource: candidate,
    harness,
    builds,
    scenarios: builds.map((build) => ({
      label: build.label,
      source: build.source,
      counts,
    })),
  };
  const path = join(directory, 'manifest.json');
  const env: Record<string, string> = {
    CANOPY_PERF_PAIR: path,
    CANOPY_DESKTOP_TOKEN: 'source-test-only-never-launch',
    CANOPY_ELECTRON_PATH: 'not-an-executable',
    CANOPY_PERF_APPROVED_BASE: base,
    CANOPY_PERF_APPROVED_HEAD: candidate,
    CANOPY_PERF_APPROVED_MANIFEST_SHA256: '',
  };
  const save = () => {
    const bytes = JSON.stringify(manifest);
    writeFileSync(path, bytes);
    env.CANOPY_PERF_APPROVED_MANIFEST_SHA256 = hash(bytes);
  };
  save();
  let runtimeImports = 0;
  const execute = () =>
    vm.runInNewContext(code, {
      process: { env },
      driverURL: driverURL.href,
      URL,
      require: (name: string) => {
        if (name === 'electron' || name === '@playwright/test') {
          runtimeImports++;
          throw new Error('Runtime import forbidden');
        }
        return require(name);
      },
    }) as Promise<string>;
  return {
    directory,
    manifest,
    env,
    path,
    save,
    execute,
    runtimeImports: () => runtimeImports,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('actual launcher accepts explicitly approved current-main pair metadata without entering the desktop runtime', async () => {
  const state = fixture();
  try {
    assert.equal(await state.execute(), 'guard-complete');
    assert.equal(state.runtimeImports(), 0);
  } finally {
    state.cleanup();
  }
});

for (const field of [
  'CANOPY_DESKTOP_TOKEN',
  'CANOPY_PERF_APPROVED_BASE',
  'CANOPY_PERF_APPROVED_HEAD',
  'CANOPY_PERF_APPROVED_MANIFEST_SHA256',
]) {
  test(`actual launcher rejects missing ${field} before runtime import`, async () => {
    const state = fixture();
    try {
      delete state.env[field];
      await assert.rejects(state.execute(), /required|Fresh source approval/);
      assert.equal(state.runtimeImports(), 0);
    } finally {
      state.cleanup();
    }
  });
}

test('actual launcher rejects manifest bytes, approved head and approved base tampering before runtime import', async () => {
  for (const kind of ['manifest', 'head', 'base']) {
    const state = fixture();
    try {
      if (kind === 'manifest')
        writeFileSync(
          state.path,
          JSON.stringify({ ...state.manifest, base: 'b'.repeat(40) }),
        );
      else
        state.env[
          kind === 'head'
            ? 'CANOPY_PERF_APPROVED_HEAD'
            : 'CANOPY_PERF_APPROVED_BASE'
        ] = 'a'.repeat(40);
      await assert.rejects(state.execute(), /manifest changed|source mismatch/);
      assert.equal(state.runtimeImports(), 0);
    } finally {
      state.cleanup();
    }
  }
});

test('actual launcher enforces paired source ownership, required hashes and all deep/full-row conditions even on a newly sealed manifest', async () => {
  for (const kind of [
    'harness-source',
    'build-source',
    'missing-harness',
    'missing-bundle',
    'missing-deep',
    'empty-rows',
  ]) {
    const state = fixture();
    try {
      if (kind === 'harness-source')
        state.manifest.harnessSource = 'a'.repeat(40);
      if (kind === 'build-source')
        state.manifest.builds[0].source = 'a'.repeat(40);
      if (kind === 'missing-harness')
        delete state.manifest.harness[harnessFiles[0]];
      if (kind === 'missing-bundle')
        delete state.manifest.builds[0].files[bundleFiles[0]];
      if (kind === 'missing-deep') state.manifest.scenarios[0].counts.pop();
      if (kind === 'empty-rows')
        state.manifest.scenarios[0].counts[0].expandedRows = 0;
      state.save();
      await assert.rejects(
        state.execute(),
        /source mismatch|Incomplete approved|ownership|conditions changed/,
      );
      assert.equal(state.runtimeImports(), 0);
    } finally {
      state.cleanup();
    }
  }
});

test('actual launcher verifies approved harness and prepared bundle bytes before runtime import', async () => {
  for (const kind of ['harness', 'bundle']) {
    const state = fixture();
    try {
      if (kind === 'harness') {
        state.manifest.harness[harnessFiles[0]] = '0'.repeat(64);
        state.save();
      } else
        writeFileSync(
          join(state.manifest.builds[0].stage, 'dist', bundleFiles[0]),
          'changed',
        );
      await assert.rejects(
        state.execute(),
        /Approved harness changed|Prepared bundle changed/,
      );
      assert.equal(state.runtimeImports(), 0);
    } finally {
      state.cleanup();
    }
  }
});
