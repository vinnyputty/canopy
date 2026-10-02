import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createRequire, Module } from 'node:module';
const forbidden = () => {
  throw new Error('Audit reached launch/Auth before profile guard');
};
let runtimeImports = 0;
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
  if (name === 'electron') {
    runtimeImports++;
    return electron;
  }
  if (name === 'node:fs')
    return {
      ...fs,
      rmSync(path: string, options: fs.RmDirOptions) {
        // Test-only containment: a regression must never delete a real root/temp
        // root. Allow cleanup only for parent-owned disposable paths; unlink owned
        // symlinks without traversing their read-only escape targets.
        const root = process.env.CANOPY_GUARD_TEST_ROOT;
        assert.ok(root && isAbsolute(root));
        const child = relative(root, resolve(path));
        assert.ok(
          child &&
            child !== '..' &&
            !child.startsWith(`..${sep}`) &&
            !isAbsolute(child),
          'Cleanup outside parent-owned fixture',
        );
        if (fs.existsSync(path) && fs.lstatSync(path).isSymbolicLink())
          fs.unlinkSync(path);
        else fs.rmSync(path, options);
      },
    };
  return original.call(this, name, ...args);
};
assert.throws(
  () => createRequire(__filename)(process.argv[2]),
  /Supply an explicit disposable|credential-free disposable|ENOENT|ENOTDIR/,
);
assert.equal(
  runtimeImports,
  0,
  'Rejected profile must not import Electron/main runtime side effects',
);
console.log('PASS audit profile guard before launch/Auth');
