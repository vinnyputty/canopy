import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
const forbidden = () => {
  throw new Error('Audit reached launch/Auth before profile guard');
};
const electron = {
  app: {
    setName() {},
    setPath() {},
    commandLine: { appendSwitch() {} },
    whenReady: forbidden,
    getPath: forbidden,
    on: forbidden,
  },
  safeStorage: {
    isEncryptionAvailable: forbidden,
    decryptString: forbidden,
    encryptString: forbidden,
  },
};
const loader = Module as unknown as { _load: (...args: any[]) => any };
const original = loader._load;
loader._load = function (name, ...args) {
  return name === 'electron' ? electron : original.call(this, name, ...args);
};
assert.throws(
  () => createRequire(__filename)(process.argv[2]),
  /Supply an explicit disposable|credential-free disposable/,
);
console.log('PASS audit profile guard before launch/Auth');
