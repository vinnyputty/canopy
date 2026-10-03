import { validateTrust } from './macos-release.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const platforms = [
  {
    platform: 'darwin',
    arch: 'arm64',
    artifact: 'mac-arm64',
    formats: [
      ['arm64', 'dmg'],
      ['arm64', 'zip'],
    ],
  },
  {
    platform: 'win32',
    arch: 'x64',
    artifact: 'win-x64',
    formats: [['x64', 'exe']],
  },
  {
    platform: 'linux',
    arch: 'x64',
    artifact: 'linux-x64',
    formats: [
      ['x86_64', 'AppImage'],
      ['amd64', 'deb'],
    ],
  },
];
export const signedPlatforms = [
  platforms[0],
  {
    platform: 'darwin',
    arch: 'x64',
    artifact: 'mac-x64',
    formats: [
      ['x64', 'dmg'],
      ['x64', 'zip'],
    ],
  },
  ...platforms.slice(1),
];
export function validateTag(tag, version) {
  const semver =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
  if (
    typeof version !== 'string' ||
    version !== version.trim() ||
    !semver.test(version) ||
    version
      .split('-')
      .slice(1)
      .join('-')
      .split('.')
      .some((part) => /^0\d+$/.test(part)) ||
    tag !== `v${version}`
  )
    throw new Error(`Tag ${tag} must match app version v${version}`);
  return version;
}
export function assetNames(version, row) {
  const os = row.artifact.split('-')[0];
  return row.formats.map(
    ([arch, ext]) => `Canopy-${version}-${os}-${arch}.${ext}`,
  );
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
function equalNames(actual, expected) {
  if (
    JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())
  )
    throw new Error(`Unexpected asset set: ${actual.join(', ')}`);
}
function validateMacPublisher(assets) {
  const publishers = new Set();
  for (const asset of assets.filter((item) => item.name.includes('-mac-'))) {
    const trust = validateTrust(
      asset.macosTrust,
      asset.name.includes('-arm64.') ? 'arm64' : 'x64',
    );
    publishers.add(
      JSON.stringify([
        trust.identity,
        trust.teamId,
        trust.certificateSha1.toLowerCase(),
      ]),
    );
  }
  if (publishers.size !== 1)
    throw new Error('macOS publisher differs across release assets');
}
export async function assemble(
  input,
  output,
  tag,
  version,
  commit,
  runUrl,
  signing = 'unsigned',
) {
  if (!['unsigned', 'signed'].includes(signing))
    throw new Error('Invalid signing mode');
  const matrix = signing === 'signed' ? signedPlatforms : platforms;
  validateTag(tag, version);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid source commit');
  equalNames(
    await readdir(input),
    matrix.map((row) => `Canopy-${row.artifact}`),
  );
  const assets = [];
  // Validate the entire matrix before making any file eligible for release.
  for (const row of matrix) {
    const directory = join(input, `Canopy-${row.artifact}`);
    if (!(await lstat(directory)).isDirectory())
      throw new Error('Unsafe artifact directory');
    const names = assetNames(version, row);
    equalNames(await readdir(directory), [...names, 'release-checks.json']);
    const report = await json(join(directory, 'release-checks.json'));
    if (
      report.version !== version ||
      report.commit !== commit ||
      report.platform !== row.platform ||
      report.arch !== row.arch ||
      report.nativeDesktopChecks !== 'pending'
    )
      throw new Error(`Report identity mismatch: ${row.artifact}`);
    equalNames(
      report.checks.map((check) => check.artifact),
      names,
    );
    const macosTrust =
      row.platform === 'darwin' && signing === 'signed'
        ? validateTrust(report.macosTrust, row.arch)
        : undefined;
    for (const check of report.checks) {
      if (!(await lstat(join(directory, check.artifact))).isFile())
        throw new Error('Unsafe artifact');
      const bytes = await readFile(join(directory, check.artifact));
      if (!bytes.length || hash(bytes) !== check.sha256)
        throw new Error(`Hash mismatch: ${check.artifact}`);
      assets.push({
        name: check.artifact,
        sha256: check.sha256,
        source: join(directory, check.artifact),
        ...(macosTrust ? { macosTrust } : {}),
      });
    }
  }
  if (signing === 'signed') validateMacPublisher(assets);
  await mkdir(output); // Refuse stale output from another invocation.
  for (const asset of assets) await cp(asset.source, join(output, asset.name));
  const manifest = {
    tag,
    version,
    commit,
    runUrl,
    macosSigning: signing,
    nativeDesktopChecks: 'pending',
    assets: assets.map(({ name, sha256, macosTrust }) => ({
      name,
      sha256,
      ...(macosTrust ? { macosTrust } : {}),
    })),
  };
  await writeFile(
    join(output, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    join(output, 'SHA256SUMS'),
    assets.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join(''),
  );
  await writeFile(
    join(output, 'release-notes.md'),
    `Canopy ${version}\n\nSource: ${commit}\n[Verified build](${runUrl})\n\n${signing === 'signed' ? 'Developer ID signed/notarized macOS candidates; Windows/Linux test builds' : 'Unsigned test builds'} awaiting native qualification. Public release is blocked.\n\n- macOS 15 ${signing === 'signed' ? 'arm64/x64' : 'arm64'}: DMG (copy to /Applications) or ZIP. ${signing === 'signed' ? 'Developer ID signatures and notarization verified; native qualification pending.' : 'Developer ID signing/notarization pending.'}\n- Windows 11 x64: NSIS EXE. Native installation and signing/SmartScreen qualification pending.\n- Ubuntu 24.04 x64: DEB or AppImage. AppImage needs FUSE 2 (libfuse2t64); credentials need an unlocked Secret Service/KWallet and session D-Bus. Native sandbox/desktop qualification pending.\n\nOther OS/CPU combinations are unqualified. See docs/platforms.md and docs/releases.md at this source commit for installation, limitations, and native release gates. Verify downloads against SHA256SUMS.\n`,
  );
  return manifest;
}
export async function verifyDownloads(directory, tag, version, commit) {
  validateTag(tag, version);
  const manifest = await json(join(directory, 'release-manifest.json'));
  if (
    manifest.tag !== tag ||
    manifest.version !== version ||
    manifest.commit !== commit ||
    !/^[a-f0-9]{40}$/.test(commit) ||
    manifest.nativeDesktopChecks !== 'pending'
  )
    throw new Error('Release manifest identity mismatch');
  if (!['unsigned', 'signed'].includes(manifest.macosSigning))
    throw new Error('Invalid manifest signing mode');
  const matrix =
    manifest.macosSigning === 'signed' ? signedPlatforms : platforms;
  const names = matrix.flatMap((row) => assetNames(version, row));
  equalNames(
    manifest.assets.map((asset) => asset.name),
    names,
  );
  equalNames(await readdir(directory), [
    ...names,
    'SHA256SUMS',
    'release-manifest.json',
  ]);
  const sums = manifest.assets
    .map(({ name, sha256 }) => `${sha256}  ${name}\n`)
    .join('');
  if ((await readFile(join(directory, 'SHA256SUMS'), 'utf8')) !== sums)
    throw new Error('Checksum manifest mismatch');
  if (manifest.macosSigning === 'signed') validateMacPublisher(manifest.assets);
  for (const asset of manifest.assets) {
    if (!(await lstat(join(directory, asset.name))).isFile())
      throw new Error('Unsafe artifact');
    const bytes = await readFile(join(directory, asset.name));
    if (!bytes.length || hash(bytes) !== asset.sha256)
      throw new Error(`Hash mismatch: ${asset.name}`);
  }
  return manifest;
}
export async function qualify(manifest, path) {
  if (manifest.macosSigning !== 'signed')
    throw new Error('Unsigned macOS distribution cannot publish');
  validateMacPublisher(manifest.assets);
  const evidence = await json(path);
  if (
    evidence.tag !== manifest.tag ||
    evidence.commit !== manifest.commit ||
    evidence.status !== 'passed' ||
    !evidence.evidenceUrl
  )
    throw new Error('Native qualification pending or mismatched');
  equalNames(
    evidence.assets.map((asset) => asset.name),
    manifest.assets.map((asset) => asset.name),
  );
  for (const asset of manifest.assets) {
    const result = evidence.assets.find((item) => item.name === asset.name);
    if (
      result.sha256 !== asset.sha256 ||
      result.nativeChecks !== 'passed' ||
      !result.tester ||
      !result.osBuild ||
      !result.date ||
      !result.evidenceUrl ||
      !result.signingPolicy
    )
      throw new Error(`Native qualification pending: ${asset.name}`);
    if (
      asset.name.includes('-mac-') &&
      result.signingPolicy !== 'Developer ID signed and notarized'
    )
      throw new Error(`macOS distribution trust pending: ${asset.name}`);
    if (
      asset.macosTrust &&
      (result.teamId !== asset.macosTrust.teamId ||
        result.identity !== asset.macosTrust.identity ||
        result.certificateSha1 !== asset.macosTrust.certificateSha1)
    )
      throw new Error(`Native signing identity mismatch: ${asset.name}`);
  }
  return evidence;
}
function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 60000 });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`gh ${args[0]} failed (${result.status})`);
  return result.stdout;
}
function runGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 60000 });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`git ${args[0]} failed (${result.status})`);
  return result.stdout;
}
export function resolveTagSource(tag, git = runGit) {
  // Validate syntax before constructing a Git revision; the dispatch version is irrelevant.
  validateTag(tag, typeof tag === 'string' ? tag.slice(1) : undefined);
  const commit = git([
    'rev-parse',
    '--verify',
    '--end-of-options',
    `refs/tags/${tag}^{commit}`,
  ]).trim();
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error('Invalid tagged source commit');
  const { version } = JSON.parse(git(['show', `${commit}:package.json`]));
  validateTag(tag, version);
  return { commit, version };
}

export async function publish(
  directory,
  tag,
  version,
  commit,
  evidence,
  notes,
  gh = runGh,
) {
  const manifest = await verifyDownloads(directory, tag, version, commit);
  await qualify(manifest, evidence);
  await readFile(notes, 'utf8');
  // Resolve the live ref after artifact/native verification, not the checkout snapshot.
  const endpoint = `repos/{owner}/{repo}/git/ref/tags/${manifest.tag}`;
  const ref = JSON.parse(gh(['api', endpoint]));
  if (ref.ref !== `refs/tags/${manifest.tag}`)
    throw new Error('Remote tag identity mismatch');
  let object = ref.object;
  const seen = new Set();
  while (
    object?.type === 'tag' &&
    /^[a-f0-9]{40}$/.test(object.sha) &&
    !seen.has(object.sha)
  ) {
    seen.add(object.sha);
    object = JSON.parse(
      gh(['api', `repos/{owner}/{repo}/git/tags/${object.sha}`]),
    ).object;
  }
  if (object?.type !== 'commit' || object.sha !== manifest.commit)
    throw new Error('Remote tag commit differs from verified manifest');
  // Require the live ref's identity immediately before editing either tag form.
  const current = JSON.parse(gh(['api', endpoint]));
  if (
    current.ref !== ref.ref ||
    current.object?.type !== ref.object.type ||
    current.object?.sha !== ref.object.sha
  )
    throw new Error('Remote tag changed during verification');
  gh([
    'release',
    'edit',
    manifest.tag,
    '--tag',
    manifest.tag,
    '--notes-file',
    notes,
    '--draft=false',
    '--verify-tag',
  ]);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'tag')
    validateTag(args[0], (await json('package.json')).version);
  else if (mode === 'tag-source') {
    const { commit, version } = resolveTagSource(args[0]);
    console.log(`${commit} ${version}`);
  } else if (mode === 'assemble') await assemble(...args);
  else if (mode === 'verify') await verifyDownloads(...args);
  else if (mode === 'publish') await publish(...args);
  else if (mode === 'qualify') {
    const [directory, tag, version, commit, evidence] = args;
    await qualify(
      await verifyDownloads(directory, tag, version, commit),
      evidence,
    );
  } else throw new Error(`Unknown release command: ${mode}`);
}
