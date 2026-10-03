import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveTagSource, validateTag } from './release.mjs';

export const windowsSigningPolicy = 'Authenticode signed and timestamped';
export const publicRoot =
  '5367F20C7ADE0E2BCA790915056D086B720C33C1FA2A2661ACF787E3292E1270';
export const publicTrustEku = '1.3.6.1.4.1.311.97.1.0';
const regions = [
  'brs',
  'cus',
  'eus',
  'jpe',
  'krc',
  'ncus',
  'neu',
  'plc',
  'scus',
  'swn',
  'wcus',
  'weu',
  'wus',
  'wus2',
  'wus3',
];
export function servicePolicy(env) {
  let policy;
  try {
    policy = JSON.parse(env.CANOPY_WINDOWS_POLICY);
  } catch {
    throw new Error('Windows service policy required');
  }
  validateService(policy);
  return policy;
}
export function validateService(policy) {
  const keys = [
    'service',
    'profileType',
    'auth',
    'endpoint',
    'account',
    'profile',
    'profileEku',
    'subject',
    'tenantId',
    'clientId',
  ];
  if (
    !policy ||
    Object.keys(policy).length !== keys.length ||
    Object.keys(policy).some((key) => !keys.includes(key))
  )
    throw new Error('Invalid Windows public service policy fields');
  if (
    policy?.service !== 'Microsoft Artifact Signing' ||
    policy.profileType !== 'PublicTrust' ||
    policy.auth !== 'EnvironmentCredential' ||
    !regions.some(
      (region) => policy.endpoint === `https://${region}.codesigning.azure.net`,
    ) ||
    !/^[a-zA-Z0-9-]{3,24}$/.test(policy.account ?? '') ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(policy.profile ?? '') ||
    !/^1\.3\.6\.1\.4\.1\.311\.97\.(?:[2-9]\d*|1\d+)(?:\.\d+)+$/.test(
      policy.profileEku ?? '',
    ) ||
    typeof policy.subject !== 'string' ||
    !policy.subject.startsWith('CN=') ||
    /[\r\n]/.test(policy.subject) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      policy.tenantId ?? '',
    ) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      policy.clientId ?? '',
    )
  )
    throw new Error(
      'Invalid Windows public service/profile/identity/authentication policy',
    );
}
export function signingConfig(env, platform, version, hook) {
  if (env.CANOPY_WINDOWS_SIGN !== '1') return {};
  const policy = servicePolicy(env);
  if (
    platform !== 'win32' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    env.GITHUB_EVENT_NAME !== 'push' ||
    env.GITHUB_REPOSITORY !== 'vinnyputty/canopy' ||
    env.GITHUB_REF !== `refs/tags/v${version}` ||
    env.GITHUB_WORKFLOW_REF !==
      `vinnyputty/canopy/.github/workflows/ci.yml@refs/tags/v${version}` ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
  )
    throw new Error(
      'Windows signing requires the reviewed protected hosted tag workflow',
    );
  validateTag(env.GITHUB_REF.slice('refs/tags/'.length), version);
  if (
    env.AZURE_TENANT_ID !== policy.tenantId ||
    env.AZURE_CLIENT_ID !== policy.clientId ||
    !env.AZURE_CLIENT_SECRET ||
    !env.CANOPY_SIGNTOOL ||
    !env.CANOPY_SIGN_DLIB ||
    env.AZURE_CLIENT_CERTIFICATE_PATH ||
    env.AZURE_USERNAME ||
    env.AZURE_PASSWORD ||
    (env.AZURE_AUTHORITY_HOST &&
      env.AZURE_AUTHORITY_HOST !== 'https://login.microsoftonline.com/')
  )
    throw new Error(
      'Scoped service principal credentials and signing tools required',
    );
  return {
    forceCodeSigning: true,
    win: { signtoolOptions: { sign: hook, signingHashAlgorithms: ['sha256'] } },
  };
}
export function validateSignature(record, sha256, identity) {
  validateService(identity);
  const time = Date.parse(record?.verifiedAt);
  if (
    record?.status !== 'Valid' ||
    record.timestamp !== true ||
    record.revocation !== 'online' ||
    record.rootSha256 !== publicRoot ||
    record.timestampRootSha256 !== publicRoot ||
    !/^[A-F0-9]{40}$/.test(record.timestampThumbprint ?? '') ||
    !Number.isFinite(Date.parse(record.timestampNotBefore)) ||
    !Number.isFinite(Date.parse(record.timestampNotAfter)) ||
    time < Date.parse(record.timestampNotBefore) ||
    time > Date.parse(record.timestampNotAfter) ||
    !Array.isArray(record.ekus) ||
    !record.ekus.includes(publicTrustEku) ||
    !record.ekus?.includes('1.3.6.1.5.5.7.3.3') ||
    !record.ekus?.includes(identity.profileEku) ||
    !Number.isFinite(time) ||
    !Number.isFinite(Date.parse(record.notBefore)) ||
    !Number.isFinite(Date.parse(record.notAfter)) ||
    time < Date.parse(record.notBefore) ||
    time > Date.parse(record.notAfter) ||
    time > Date.now() + 300000 ||
    record.subject !== identity.subject ||
    !/^[A-F0-9]{40}$/.test(record.thumbprint ?? '') ||
    record.sha256 !== sha256 ||
    !/^[a-f0-9]{64}$/.test(sha256 ?? '')
  )
    throw new Error(
      'Windows signature trust, publisher, timestamp or hash mismatch',
    );
}
export function validateWindowsReport(report, installerHash) {
  if (report?.policy !== windowsSigningPolicy)
    throw new Error('Windows signing pending');
  validateSignature(report.installer, installerHash, report.service);
  validateSignature(
    report.executable,
    report.executable?.sha256,
    report.service,
  );
}
export function command(command, args, env = process.env, spawn = spawnSync) {
  const result = spawn(command, args, {
    env,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error('Windows bounded tool failed; preserve native evidence');
  return result.stdout;
}
export function verificationEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/^(AZURE_|CSC_|WIN_CSC_|CANOPY_WINDOWS_PFX|GH_TOKEN|GITHUB_TOKEN)/.test(
          key.toUpperCase(),
        ),
    ),
  );
}
const root = dirname(fileURLToPath(import.meta.url));
export function nativeOperation(
  request,
  env = process.env,
  run = command,
  platform = process.platform,
) {
  if (platform !== 'win32')
    throw new Error('Actual Windows operation requires Windows');
  return JSON.parse(
    run(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        join(root, 'windows-native.ps1'),
      ],
      { ...env, CANOPY_NATIVE_REQUEST: JSON.stringify(request) },
    ),
  );
}
export function authenticode(
  path,
  _mode = 'verify',
  run = command,
  platform = process.platform,
) {
  const result = nativeOperation(
    { operation: 'verify', path: resolve(path) },
    verificationEnv(process.env),
    run,
    platform,
  );
  if (result.ok === false)
    throw new Error('Actual Windows trust verification failed');
  return result;
}
export function signingSource(
  env,
  version,
  git = (args) =>
    command(
      'git',
      ['-C', env.BUILD_WORKSPACE_DIRECTORY ?? process.cwd(), ...args],
      verificationEnv(env),
    ),
) {
  const source = resolveTagSource(`v${version}`, git);
  if (
    source.commit !== env.GITHUB_SHA ||
    git(['rev-parse', 'HEAD']).trim() !== source.commit ||
    source.version !== version ||
    git(['status', '--porcelain', '--untracked-files=no']).trim()
  )
    throw new Error('Signing checkout and tagged source differ');
  return source;
}
export async function signWithService(
  path,
  version,
  {
    env = process.env,
    platform = process.platform,
    run = nativeOperation,
    inspect = authenticode,
    source = signingSource,
  } = {},
) {
  signingConfig(env, platform, version, () => {});
  source(env, version);
  const policy = servicePolicy(env);
  const owned = await mkdtemp(join(tmpdir(), 'canopy-service-sign-'));
  // Only EnvironmentCredential may authenticate. No interactive, local cache, CLI or managed identity fallback.
  const metadata = {
    Endpoint: policy.endpoint,
    CodeSigningAccountName: policy.account,
    CertificateProfileName: policy.profile,
    ExcludeCredentials: [
      'ManagedIdentityCredential',
      'WorkloadIdentityCredential',
      'SharedTokenCacheCredential',
      'VisualStudioCredential',
      'VisualStudioCodeCredential',
      'AzureCliCredential',
      'AzurePowerShellCredential',
      'AzureDeveloperCliCredential',
      'InteractiveBrowserCredential',
    ],
  };
  const childEnv = {
    ...verificationEnv(env),
    AZURE_TENANT_ID: policy.tenantId,
    AZURE_CLIENT_ID: policy.clientId,
    AZURE_CLIENT_SECRET: env.AZURE_CLIENT_SECRET,
    AZURE_AUTHORITY_HOST: 'https://login.microsoftonline.com/',
  };
  try {
    const metadataPath = join(owned, 'metadata.json');
    await writeFile(metadataPath, JSON.stringify(metadata), {
      mode: 0o600,
      flag: 'wx',
    });
    const result = run(
      {
        operation: 'run',
        file: env.CANOPY_SIGNTOOL,
        args: [
          'sign',
          '/fd',
          'SHA256',
          '/tr',
          'http://timestamp.acs.microsoft.com',
          '/td',
          'SHA256',
          '/dlib',
          env.CANOPY_SIGN_DLIB,
          '/dmdf',
          metadataPath,
          resolve(path),
        ],
        timeoutMs: 90000,
      },
      childEnv,
    );
    if (!result?.ok || result.ownedAbsent !== true)
      throw new Error('Cloud signing or owned process cleanup failed');
    const record = inspect(path);
    validateSignature(
      record,
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
      policy,
    );
    return record;
  } finally {
    for (const key of Object.keys(childEnv))
      if (/^AZURE_/i.test(key)) delete childEnv[key];
    await rm(owned, { recursive: true, force: true });
  }
}
// Capture only signing inputs; builder/module loads and unrelated children see the scrubbed environment.
export function prepareWindowsSigning(
  env,
  platform,
  version,
  dependencies = {},
) {
  const credentials = {};
  let ambiguous = false;
  for (const key of Object.keys(env)) {
    if (/^AZURE_/i.test(key)) {
      const canonical = key.toUpperCase();
      if (Object.hasOwn(credentials, canonical)) ambiguous = true;
      credentials[canonical] = env[key];
      delete env[key];
    } else if (
      /^(?:WIN_)?CSC_(?:LINK|KEY_PASSWORD)$|^CANOPY_WINDOWS_PFX/i.test(key)
    ) {
      delete env[key];
    }
  }
  const privateEnv = { ...verificationEnv(env), ...credentials };
  for (const key of Object.keys(credentials)) delete credentials[key];
  let closed = false;
  const close = () => {
    closed = true;
    for (const key of Object.keys(privateEnv))
      if (/^AZURE_/i.test(key)) delete privateEnv[key];
  };
  try {
    if (ambiguous)
      throw new Error('Ambiguous Windows signing environment aliases');
    const hook = async (configuration) => {
      if (closed) throw new Error('Windows signing scope closed');
      return signWithService(configuration.path, version, {
        ...dependencies,
        env: privateEnv,
        platform,
      });
    };
    return {
      config: signingConfig(privateEnv, platform, version, hook),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
function extractionTool(tool, args, env) {
  const result = nativeOperation(
    { operation: 'run', file: tool, args, timeoutMs: 90000 },
    env,
  );
  if (!result?.ok || result.ownedAbsent !== true)
    throw new Error('Owned extraction process failed');
}
export async function verifyWindowsInstaller(
  path,
  expected,
  inspect = authenticode,
  run = extractionTool,
) {
  const identity = servicePolicy(process.env);
  const sha256 = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  const installer = inspect(path);
  validateSignature(installer, sha256, identity);
  const temporary = await mkdtemp(join(tmpdir(), 'canopy-authenticode-'));
  try {
    run(
      '7z',
      ['x', '-y', `-o${temporary}`, resolve(path)],
      verificationEnv(process.env),
    );
    run(
      '7z',
      [
        'x',
        '-y',
        `-o${join(temporary, 'app')}`,
        join(temporary, '$PLUGINSDIR', 'app-64.7z'),
      ],
      verificationEnv(process.env),
    );
    const executablePath = join(temporary, 'app', 'Canopy.exe');
    const executableHash = createHash('sha256')
      .update(await readFile(executablePath))
      .digest('hex');
    const executable = inspect(executablePath);
    validateSignature(executable, executableHash, identity);
    const report = {
      policy: windowsSigningPolicy,
      service: identity,
      installer,
      executable,
    };
    if (expected) {
      validateWindowsReport(expected, sha256);
      if (
        Object.keys(identity).some(
          (key) => expected.service[key] !== identity[key],
        ) ||
        expected.installer.thumbprint !== installer.thumbprint ||
        expected.executable.thumbprint !== executable.thumbprint ||
        expected.executable.sha256 !== executableHash
      )
        throw new Error(
          'Windows signature report differs from downloaded bytes',
        );
    }
    if (
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex') !== sha256
    )
      throw new Error(
        'Windows installer changed during signature verification',
      );
    return report;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, directory] = process.argv.slice(2);
  if (mode === 'verify') {
    await verifyWindowsInstaller(directory);
    process.exit(0);
  }
  if (mode !== 'report') throw new Error('Unknown Windows signing command');
  const path = join(directory, 'release-checks.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  if (
    report.platform !== 'win32' ||
    report.arch !== 'x64' ||
    report.checks.length !== 1
  )
    throw new Error('Windows report identity mismatch');
  validateTag(`v${report.version}`, report.version);
  const name = `Canopy-${report.version}-win-x64.exe`;
  if (report.checks[0].artifact !== name)
    throw new Error('Unexpected Windows installer');
  report.windowsSigning = await verifyWindowsInstaller(join(directory, name));
  validateWindowsReport(report.windowsSigning, report.checks[0].sha256);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}
