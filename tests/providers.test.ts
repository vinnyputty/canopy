import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Providers } from '../src/main/providers';
import type { Connection } from '../src/shared/types';

it('retains providers per connection and discards only replaced or disconnected credentials', () => {
  const a: Connection = {
    id: 'a',
    name: 'A',
    url: 'https://a.atlassian.net',
    provider: 'jira',
  };
  const b = { ...a, id: 'b' };
  let connections = [a, b];
  const registry = new Providers(
    () => [...connections],
    (_connection, current) => ({ current }),
  );
  const first = registry.get('a');
  const other = registry.get('b');
  assert.equal(registry.get('a'), first);
  connections = [{ ...a }, b];
  registry.reconcile();
  assert.notEqual(registry.get('a'), first);
  assert.equal(registry.get('b'), other);
  assert.throws(first.current, /connection changed/);
  connections = [connections[0]];
  registry.remove('b');
  assert.throws(() => registry.get('b'), /connection is unavailable/);
  assert.throws(other.current, /connection changed/);
});
