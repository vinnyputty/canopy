import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { callback, declaration, execute, sourceFile } from './source-probe';

const source = sourceFile(
  new URL('../tools/benchmark-large-trees.mjs', import.meta.url),
);
const head = execute(declaration(source, 'benchmarkHead').getText(), {
  existsSync,
  join,
  execFileSync,
});
test('benchmark attributes the measured repository and requires archive identity even inside another repository', () => {
  const directory = mkdtempSync(join(tmpdir(), 'canopy-benchmark-source-'));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const repository = (name: string) => {
    const cwd = join(directory, name);
    mkdirSync(cwd);
    git(cwd, 'init', '-q');
    writeFileSync(join(cwd, 'identity'), name);
    git(cwd, 'add', 'identity');
    git(
      cwd,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      name,
    );
    return cwd;
  };
  try {
    const normal = repository('normal');
    const override = repository('override');
    const metadata = (env: Record<string, string | undefined>) => {
      const process = { env };
      const measuredSource = execute(
        callback(source, 'source').replace(
          'import.meta.url',
          JSON.stringify(
            pathToFileURL(join(normal, 'tools/benchmark-large-trees.mjs')).href,
          ),
        ),
        { resolve, process, fileURLToPath, URL },
      );
      return execute(callback(source, 'head'), {
        source: measuredSource,
        process,
        benchmarkHead: head,
      });
    };
    assert.equal(metadata({}), git(normal, 'rev-parse', 'HEAD'));
    assert.equal(
      metadata({ CANOPY_PERF_SOURCE: override }),
      git(override, 'rev-parse', 'HEAD'),
    );
    assert.equal(
      metadata({ CANOPY_PERF_SOURCE: override, CANOPY_PERF_HEAD: 'explicit' }),
      'explicit',
    );
    assert.equal(head(normal), git(normal, 'rev-parse', 'HEAD'));
    assert.equal(head(override), git(override, 'rev-parse', 'HEAD'));
    assert.notEqual(head(normal), head(override));
    assert.equal(head(override, 'explicit'), 'explicit');
    const archive = join(normal, 'archive');
    mkdirSync(archive);
    assert.throws(
      () => metadata({ CANOPY_PERF_SOURCE: archive }),
      /CANOPY_PERF_HEAD/,
    );
    assert.equal(
      metadata({
        CANOPY_PERF_SOURCE: archive,
        CANOPY_PERF_HEAD: 'archive-head',
      }),
      'archive-head',
    );
    assert.throws(() => head(archive), /CANOPY_PERF_HEAD/);
    assert.equal(head(archive, 'archive-head'), 'archive-head');
    const standalone = join(directory, 'standalone');
    mkdirSync(standalone);
    assert.throws(() => head(standalone), /CANOPY_PERF_HEAD/);
    assert.equal(head(standalone, 'standalone-head'), 'standalone-head');
    const broken = join(directory, 'broken');
    mkdirSync(broken);
    writeFileSync(join(broken, '.git'), 'gitdir: missing\n');
    assert.throws(() => head(broken));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
