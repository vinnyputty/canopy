import assert from 'node:assert/strict';

export function checkDesktopEntry(contents, executable) {
  const entries = contents.match(/^Exec=.*$/gm) ?? [];
  assert.equal(entries.length, 1, 'Expected one production desktop Exec entry');
  assert.equal(entries[0], `Exec=${executable} %U`);
}
