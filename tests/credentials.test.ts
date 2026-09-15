import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  configureLinuxCredentialStore,
  linuxCredentialStorageError,
  secretServiceStatus,
} from '../src/main/credentials';

test('uses libsecret when Secret Service is available on an unrecognized Linux desktop', () => {
  const stores: string[] = [];
  const result = configureLinuxCredentialStore((store) => stores.push(store), {
    platform: 'linux',
    argv: ['canopy'],
    environment: { XDG_CURRENT_DESKTOP: 'sway' },
    probe: () => 'available',
  });
  assert.deepEqual(stores, ['gnome-libsecret']);
  assert.deepEqual(result, { action: 'libsecret', reason: 'secret-service' });
});

test('preserves explicit and desktop-selected Linux credential stores', () => {
  let called = false;
  const setStore = () => {
    called = true;
  };
  assert.equal(
    configureLinuxCredentialStore(setStore, {
      platform: 'linux',
      argv: ['canopy', '--password-store=basic'],
      probe: () => 'available',
    }).reason,
    'command-line',
  );
  assert.equal(
    configureLinuxCredentialStore(setStore, {
      platform: 'linux',
      argv: ['canopy'],
      environment: { XDG_CURRENT_DESKTOP: 'KDE' },
      probe: () => 'available',
    }).reason,
    'desktop',
  );
  assert.equal(called, false);
});

test('does not treat a failed Secret Service probe as confirmation that it is absent', () => {
  const calls: string[] = [];
  assert.equal(
    secretServiceStatus((file) => {
      calls.push(file);
      return { status: null, error: { code: 'ETIMEDOUT' } };
    }),
    'unknown',
  );
  assert.deepEqual(calls, ['dbus-send', 'gdbus']);
  assert.equal(
    secretServiceStatus(() => ({
      status: 1,
      stderr: 'org.freedesktop.DBus.Error.ServiceUnknown',
    })),
    'unavailable',
  );
});

test('leaves the default backend intact when Secret Service is absent or unknown', () => {
  for (const status of ['unavailable', 'unknown'] as const) {
    let called = false;
    const result = configureLinuxCredentialStore(
      () => {
        called = true;
      },
      {
        platform: 'linux',
        argv: ['canopy'],
        environment: { XDG_CURRENT_DESKTOP: 'sway' },
        probe: () => status,
      },
    );
    assert.equal(called, false);
    assert.equal(result.reason, `secret-service-${status}`);
  }
});

test('explains the Linux credential backend that failed', () => {
  assert.match(
    linuxCredentialStorageError({
      action: 'unchanged',
      reason: 'secret-service-unavailable',
    }),
    /no Secret Service keyring was found/,
  );
  assert.match(
    linuxCredentialStorageError({
      action: 'unchanged',
      reason: 'secret-service-unknown',
    }),
    /could not determine/,
  );
  assert.match(
    linuxCredentialStorageError({
      action: 'unchanged',
      reason: 'command-line',
    }),
    /--password-store backend/,
  );
});

test('reports an available provider separately from an insecure selected backend', () => {
  const selection = { action: 'libsecret', reason: 'secret-service' } as const;
  assert.match(
    linuxCredentialStorageError(selection, 'basic_text'),
    /--password-store=gnome-libsecret/,
  );
  assert.match(
    linuxCredentialStorageError(selection, 'gnome_libsecret'),
    /Unlock the keyring/,
  );
});
