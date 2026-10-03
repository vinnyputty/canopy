import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  command,
  prepareWindowsSigning,
  verificationEnv,
} from './windows-signing.mjs';
import { fixtureEnv, fixtureSignature } from './windows-signing-fixture.mjs';

const source = await readFile(
  new URL('./desktop.mjs', import.meta.url),
  'utf8',
);
const boundary = source.slice(
  source.indexOf('  const { prepareWindowsSigning }'),
  source.lastIndexOf('\n}'),
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction(
  'loadSigning',
  'process',
  'manifest',
  'require',
  'staging',
  'workspace',
  'join',
  boundary.replace(
    "await import('./windows-signing.mjs')",
    'await loadSigning()',
  ),
);
const noAzure = (env) =>
  assert.ok(Object.keys(env).every((key) => !/^azure_/i.test(key)));

test('real desktop builder-load/build/hook boundary scopes synthetic credentials on success and failures', async () => {
  const owned = await mkdtemp(join(tmpdir(), 'canopy-sign-scope-'));
  const path = join(owned, 'fixture.exe');
  await writeFile(path, 'fixture');
  const sha256 = createHash('sha256').update('fixture').digest('hex');
  try {
    for (const failure of [
      null,
      'load',
      'build',
      'sign',
      'verify',
      'policy',
      'source',
    ]) {
      const env = {
        ...fixtureEnv,
        PATH: 'fixture-path',
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      };
      if (failure === 'policy') env.CANOPY_WINDOWS_POLICY = '{}';
      let hook,
        signingChild,
        signCalls = 0,
        loadCalls = 0;
      const primary = new Error(`synthetic ${failure} failure`);
      const loadSigning = async () => ({
        prepareWindowsSigning: (input, platform, version) =>
          prepareWindowsSigning(input, platform, version, {
            source: (privateEnv) => {
              assert.equal(
                privateEnv.AZURE_CLIENT_SECRET,
                fixtureEnv.AZURE_CLIENT_SECRET,
              );
              noAzure(verificationEnv(privateEnv));
              if (failure === 'source') throw primary;
            },
            run: (request, childEnv) => {
              signCalls++;
              signingChild = childEnv;
              assert.equal(
                childEnv.AZURE_CLIENT_SECRET,
                fixtureEnv.AZURE_CLIENT_SECRET,
              );
              assert.deepEqual(
                Object.keys(childEnv)
                  .filter((key) => /^AZURE_/.test(key))
                  .sort(),
                [
                  'AZURE_AUTHORITY_HOST',
                  'AZURE_CLIENT_ID',
                  'AZURE_CLIENT_SECRET',
                  'AZURE_TENANT_ID',
                ],
              );
              assert.ok(
                !JSON.stringify(request).includes(
                  fixtureEnv.AZURE_CLIENT_SECRET,
                ),
              );
              if (failure === 'sign') throw primary;
              return { ok: true, ownedAbsent: true };
            },
            inspect: () => {
              noAzure(env);
              if (failure === 'verify') throw primary;
              return fixtureSignature(sha256);
            },
          }),
      });
      const require = (name) => {
        loadCalls++;
        noAzure(env);
        assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
        if (failure === 'load') throw primary;
        if (name === 'electron/package.json') return { version: '44.3.0' };
        assert.equal(name, 'electron-builder');
        return {
          build: async (options) => {
            noAzure(env);
            // Actual command wrapper's unrelated-child env is the now scrubbed ambient env.
            command('fixture', [], env, (_command, _args, options) => {
              noAzure(options.env);
              return { status: 0, stdout: '' };
            });
            hook = options.config.win.signtoolOptions.sign;
            if (failure === 'build') throw primary;
            await hook({ path });
          },
        };
      };
      const action = execute(
        loadSigning,
        { env, platform: 'win32' },
        { version: '0.1.0' },
        require,
        owned,
        owned,
        join,
      );
      if (failure === null) await action;
      else if (failure === 'policy')
        await assert.rejects(action, /policy fields/);
      else await assert.rejects(action, (error) => error === primary);
      noAzure(env);
      if (signingChild) noAzure(signingChild);
      if (hook) await assert.rejects(hook({ path }), /scope closed/);
      if (failure === 'policy') assert.equal(loadCalls, 0);
      assert.equal(
        signCalls,
        [null, 'sign', 'verify'].includes(failure) ? 1 : 0,
      );
    }
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
});
test('Windows case aliases normalize captured identities and scrub aliases; ambiguous aliases fail before builder', () => {
  const env = { ...fixtureEnv };
  for (const key of [
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
  ]) {
    env[key.toLowerCase()] = env[key];
    delete env[key];
  }
  const scope = prepareWindowsSigning(env, 'win32', '0.1.0');
  noAzure(env);
  scope.close();
  const collision = {
    ...fixtureEnv,
    azure_client_secret: 'other-synthetic-value',
  };
  assert.throws(
    () => prepareWindowsSigning(collision, 'win32', '0.1.0'),
    /Ambiguous/,
  );
  noAzure(collision);
  const legacy = {
    azure_client_secret: 'synthetic',
    CSC_LINK: 'synthetic',
    WIN_CSC_KEY_PASSWORD: 'synthetic',
    CANOPY_WINDOWS_PFX: 'synthetic',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    PATH: 'kept',
  };
  const unsigned = prepareWindowsSigning(legacy, 'linux', '0.1.0');
  assert.deepEqual(unsigned.config, {});
  assert.deepEqual(legacy, {
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    PATH: 'kept',
  });
  unsigned.close();
});
