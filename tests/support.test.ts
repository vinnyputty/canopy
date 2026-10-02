import assert from 'node:assert/strict';
import { it } from 'node:test';
import { supportLinks, supportUrl } from '../src/shared/support';

it('opens only named public support destinations', () => {
  for (const [id, link] of Object.entries(supportLinks)) {
    assert.equal(supportUrl(id), link.url);
    const url = new URL(supportUrl(id));
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'github.com');
    assert.ok(url.pathname.startsWith('/vinnyputty/canopy'));
  }
  for (const value of [
    'toString',
    '__proto__',
    'https://example.com',
    null,
    {},
    1,
  ])
    assert.throws(() => supportUrl(value), /Unknown support link/);
});
