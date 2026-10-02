import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { resolveTagSource, validateTag } from './release.mjs';

// Never include child output or arguments in errors: imports can contain key material.
export function command(name, args, options = {}) {
  const childEnv = { ...(options.env ?? process.env) };
  for (const key of [
    'MAC_CERTIFICATE_P12',
    'MAC_CERTIFICATE_PASSWORD',
    'MAC_NOTARY_KEY',
  ])
    delete childEnv[key];
  const result = spawnSync(name, args, {
    encoding: 'utf8',
    timeout: 1800000,
    ...options,
    env: childEnv,
  });
  if (result.error || result.status !== 0) throw new Error(`${name} failed`);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}
export function signingGate(
  env,
  platform,
  arch,
  version,
  git = (args) => command('git', args),
) {
  if (
    platform !== 'darwin' ||
    !['arm64', 'x64'].includes(arch) ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.CANOPY_SIGNED_RELEASE !== '1' ||
    env.GITHUB_REF !== `refs/tags/${env.RELEASE_TAG}`
  )
    throw new Error('Protected tagged signing runner required');
  validateTag(env.RELEASE_TAG, version);
  const source = resolveTagSource(env.RELEASE_TAG, git);
  if (
    source.commit !== env.GITHUB_SHA ||
    source.version !== version ||
    git(['rev-parse', 'HEAD']).trim() !== source.commit
  )
    throw new Error('Signing source mismatch');
  if (
    !/^[A-Z0-9]{10}$/.test(env.MAC_TEAM_ID ?? '') ||
    !env.MAC_IDENTITY?.startsWith('Developer ID Application: ') ||
    !env.MAC_IDENTITY.endsWith(` (${env.MAC_TEAM_ID})`) ||
    /[\r\n]/.test(env.MAC_IDENTITY)
  )
    throw new Error('Stable Developer ID identity required');
  for (const key of [
    'MAC_CERTIFICATE_P12',
    'MAC_CERTIFICATE_PASSWORD',
    'MAC_NOTARY_KEY',
  ])
    if (!env[key]) throw new Error(`Missing ${key}`);
  if (
    !/^[A-Z0-9]{10}$/.test(env.MAC_NOTARY_KEY_ID ?? '') ||
    !/^[a-f0-9-]{36}$/i.test(env.MAC_NOTARY_ISSUER ?? '')
  )
    throw new Error('Notary API identity required');
  for (const key of [
    'CSC_LINK',
    'CSC_NAME',
    'CSC_KEY_PASSWORD',
    'CSC_KEYCHAIN',
    'APPLE_ID',
    'APPLE_API_KEY',
    'APPLE_KEYCHAIN_PROFILE',
    'DEBUG',
  ])
    if (env[key])
      throw new Error('Inherited signing/debug configuration rejected');
  return source;
}
export function validateTrust(trust, arch) {
  if (
    trust?.status !== 'verified' ||
    trust.arch !== arch ||
    !/^[A-Z0-9]{10}$/.test(trust.teamId ?? '') ||
    !trust.identity?.startsWith('Developer ID Application: ') ||
    !trust.identity.endsWith(` (${trust.teamId})`) ||
    !/^[a-f0-9]{40}$/i.test(trust.certificateSha1 ?? '') ||
    trust.appSignature !== 'passed' ||
    trust.hardenedRuntime !== 'passed' ||
    trust.gatekeeper !== 'passed' ||
    trust.appStaple !== 'passed' ||
    trust.dmgSignature !== 'passed' ||
    trust.dmgStaple !== 'passed' ||
    trust.zipPayload !== 'passed' ||
    !Array.isArray(trust.submissions) ||
    trust.submissions.length !== 2 ||
    trust.submissions.some(
      (item) =>
        item.status !== 'Accepted' || !/^[a-f0-9-]{36}$/i.test(item.id ?? ''),
    )
  )
    throw new Error('Verified macOS distribution trust required');
  return trust;
}
export async function containedAppRoot(payload) {
  const app = join(payload, 'Canopy.app');
  if (!(await lstat(app)).isDirectory())
    throw new Error('Distributed app root must be a real directory');
  const boundary = await realpath(payload);
  const resolved = await realpath(app);
  const path = relative(boundary, resolved);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new Error('Distributed app root escapes its payload');
  return app;
}
export async function signedPackages({
  env,
  arch,
  version,
  projectDir,
  output,
  build,
  run = command,
}) {
  const scratch = await mkdtemp(join(tmpdir(), 'canopy-signing-'));
  const keychain = join(scratch, 'signing.keychain-db');
  // This disposable keychain lives in a private 0700 directory on the gated VM.
  // Its empty password is not a credential; real P12 passwords use an env pipe.
  // Login keychain contents stay untouched; the runner search list is restored.
  let failure;
  let searchList;
  let keychainAttempted = false;
  try {
    await writeFile(
      join(scratch, 'certificate.p12'),
      Buffer.from(env.MAC_CERTIFICATE_P12, 'base64'),
      { mode: 0o600 },
    );
    await writeFile(join(scratch, 'notary.p8'), env.MAC_NOTARY_KEY, {
      mode: 0o600,
    });
    run(
      'openssl',
      [
        'pkcs12',
        '-in',
        join(scratch, 'certificate.p12'),
        '-out',
        join(scratch, 'identity.pem'),
        '-nodes',
        '-passin',
        'env:CANOPY_P12_PASSWORD',
      ],
      {
        env: {
          PATH: process.env.PATH,
          CANOPY_P12_PASSWORD: env.MAC_CERTIFICATE_PASSWORD,
        },
      },
    );
    // Scratch is mkdtemp's private 0700 directory; the unencrypted PEM never leaves it.
    await chmod(join(scratch, 'identity.pem'), 0o600);
    run('openssl', [
      'pkcs12',
      '-export',
      '-keypbe',
      'PBE-SHA1-3DES',
      '-certpbe',
      'PBE-SHA1-3DES',
      '-macalg',
      'sha1',
      '-in',
      join(scratch, 'identity.pem'),
      '-out',
      join(scratch, 'import.p12'),
      '-passout',
      'pass:',
    ]);
    await chmod(join(scratch, 'import.p12'), 0o600);
    const listing = run('security', ['list-keychains', '-d', 'user']);
    searchList = [...listing.matchAll(/"([^"]+)"/g)].map((item) => item[1]);
    if (!searchList.length)
      throw new Error('Cannot preserve runner keychain search list');
    keychainAttempted = true;
    run('security', ['create-keychain', '-p', '', keychain]);
    run('security', ['set-keychain-settings', '-lut', '21600', keychain]);
    run('security', ['unlock-keychain', '-p', '', keychain]);
    run('security', [
      'list-keychains',
      '-d',
      'user',
      '-s',
      keychain,
      ...searchList,
    ]);
    run('security', [
      'import',
      join(scratch, 'import.p12'),
      '-k',
      keychain,
      '-P',
      '',
      '-T',
      '/usr/bin/codesign',
    ]);
    run('security', [
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:,codesign:',
      '-s',
      '-k',
      '',
      keychain,
    ]);
    const identities = run('security', [
      'find-identity',
      '-v',
      '-p',
      'codesigning',
      keychain,
    ]);
    const matches = [
      ...identities.matchAll(/\b([A-Fa-f0-9]{40}) "([^"]+)"/g),
    ].filter((item) => item[2] === env.MAC_IDENTITY);
    if (matches.length !== 1)
      throw new Error('Exact valid Developer ID certificate required');
    const certificateSha1 = matches[0][1].toLowerCase();
    const auth = [
      '--key',
      join(scratch, 'notary.p8'),
      '--key-id',
      env.MAC_NOTARY_KEY_ID,
      '--issuer',
      env.MAC_NOTARY_ISSUER,
    ];
    const submissions = [];
    const notarize = (path) => {
      const response = JSON.parse(
        run('xcrun', [
          'notarytool',
          'submit',
          path,
          ...auth,
          '--wait',
          '--timeout',
          '20m',
          '--output-format',
          'json',
        ]),
      );
      if (
        response.status !== 'Accepted' ||
        !/^[a-f0-9-]{36}$/i.test(response.id ?? '')
      )
        throw new Error('Notarization was not accepted');
      submissions.push({ id: response.id, status: response.status });
    };
    const staple = (path) => {
      run('xcrun', ['stapler', 'staple', path]);
      run('xcrun', ['stapler', 'validate', path]);
    };
    const verifySignature = (path, app = false) => {
      run('codesign', [
        '--verify',
        '--strict',
        ...(app ? ['--deep'] : []),
        '--verbose=2',
        path,
      ]);
      const display = run('codesign', ['--display', '--verbose=4', path]);
      if (
        !display.includes(`Authority=${env.MAC_IDENTITY}\n`) ||
        !display.includes(`TeamIdentifier=${env.MAC_TEAM_ID}\n`) ||
        !/Timestamp=/.test(display) ||
        (app &&
          (!/flags=.*\bruntime\b/.test(display) ||
            !display.includes('Identifier=app.canopy.desktop\n')))
      )
        throw new Error('Signed identity/runtime mismatch');
      const cert = join(scratch, 'cert-');
      run('codesign', ['--display', '--extract-certificates', cert, path]);
    };
    // Signature verification plus certificate pinning is performed for every container/payload.
    const verify = async (path, app = false) => {
      await rm(join(scratch, 'cert-0'), { force: true });
      verifySignature(path, app);
      const bytes = await readFile(join(scratch, 'cert-0'));
      if (createHash('sha1').update(bytes).digest('hex') !== certificateSha1)
        throw new Error('Certificate fingerprint mismatch');
      if (app) {
        const cpu = run('lipo', [
          '-archs',
          join(path, 'Contents/MacOS/Canopy'),
        ]).trim();
        if (cpu !== (arch === 'x64' ? 'x86_64' : 'arm64'))
          throw new Error('Signed architecture mismatch');
        run('spctl', ['--assess', '--type', 'execute', '--verbose=4', path]);
        run('xcrun', ['stapler', 'validate', path]);
      }
    };
    // Notarize/staple the app before builder creates either distribution container.
    const oldKeychain = process.env.CSC_KEYCHAIN;
    process.env.CSC_KEYCHAIN = keychain;
    try {
      await build({
        projectDir,
        publish: 'never',
        config: {
          forceCodeSigning: true,
          directories: { output },
          mac: {
            identity: certificateSha1.toUpperCase(),
            hardenedRuntime: true,
            notarize: false,
            target: [
              { target: 'dmg', arch: [arch] },
              { target: 'zip', arch: [arch] },
            ],
          },
          dmg: { sign: true },
          afterSign: async ({ appOutDir }) => {
            const app = join(appOutDir, 'Canopy.app');
            const archive = join(scratch, 'notary.zip');
            run('ditto', [
              '-c',
              '-k',
              '--sequesterRsrc',
              '--keepParent',
              app,
              archive,
            ]);
            notarize(archive);
            staple(app);
            await verify(app, true);
          },
        },
      });
    } finally {
      if (oldKeychain === undefined) delete process.env.CSC_KEYCHAIN;
      else process.env.CSC_KEYCHAIN = oldKeychain;
    }
    const dmg = join(output, `Canopy-${version}-mac-${arch}.dmg`);
    const zip = join(output, `Canopy-${version}-mac-${arch}.zip`);
    for (const path of [dmg, zip]) {
      const info = await lstat(path);
      if (!info.isFile() || !info.size)
        throw new Error('Unsafe signed artifact');
    }
    await verify(dmg);
    notarize(dmg);
    staple(dmg);
    await verify(dmg);
    run('spctl', [
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      '--verbose=4',
      dmg,
    ]);
    const extracted = join(scratch, 'zip');
    await mkdir(extracted);
    run('ditto', ['-x', '-k', zip, extracted]);
    if (
      JSON.stringify(await readdir(extracted)) !==
      JSON.stringify(['Canopy.app'])
    )
      throw new Error('Unexpected ZIP payload');
    await verify(await containedAppRoot(extracted), true);
    const mount = join(scratch, 'mount');
    await mkdir(mount);
    try {
      run('hdiutil', [
        'attach',
        '-readonly',
        '-nobrowse',
        '-mountpoint',
        mount,
        dmg,
      ]);
      const app = join(scratch, 'dmg-app', 'Canopy.app');
      const source = await containedAppRoot(mount);
      await cp(source, app, {
        recursive: true,
        verbatimSymlinks: true,
      });
      await verify(app, true);
    } finally {
      run('hdiutil', ['detach', mount]);
    }
    const trust = validateTrust(
      {
        status: 'verified',
        arch,
        identity: env.MAC_IDENTITY,
        teamId: env.MAC_TEAM_ID,
        certificateSha1,
        appSignature: 'passed',
        hardenedRuntime: 'passed',
        gatekeeper: 'passed',
        appStaple: 'passed',
        dmgSignature: 'passed',
        dmgStaple: 'passed',
        zipPayload: 'passed',
        submissions,
      },
      arch,
    );
    const assets = [];
    for (const path of [dmg, zip])
      assets.push({
        name: path.split('/').at(-1),
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      });
    return { trust, assets };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    let cleanupFailed = false;
    try {
      if (searchList)
        run('security', ['list-keychains', '-d', 'user', '-s', ...searchList]);
    } catch {
      cleanupFailed = true;
    }
    try {
      if (keychainAttempted) run('security', ['delete-keychain', keychain]);
    } catch {
      cleanupFailed = true;
    }
    await rm(scratch, { recursive: true, force: true });
    if (cleanupFailed)
      throw new Error(
        failure
          ? 'Signing failed; keychain cleanup also failed'
          : 'Signing keychain cleanup failed',
      );
  }
}
