import assert from 'node:assert/strict';
import { it } from 'node:test';
import { statusPaths } from '../src/renderer/status-paths';
import type { Status, StatusTransitionTree } from '../src/shared/types';

const status = (id: string): Status => ({ id, name: id, category: 'new' });
const edge = (id: string, to: string, requiresFields = false) => ({
  id,
  name: id,
  to: status(to),
  requiresFields,
});

it('offers one shortest simple path per non-direct destination in workflow order', () => {
  const graph: StatusTransitionTree = {
    a: [edge('ab', 'b'), edge('ac', 'c')],
    b: [edge('ba', 'a'), edge('bd', 'd')],
    c: [edge('cd', 'd'), edge('ce', 'e')],
    d: [edge('de', 'e')],
    e: [edge('ea', 'a')],
  };
  const paths = statusPaths(status('a'), graph.a, graph);
  assert.deepEqual(
    paths.map((path) => [
      path.destination.id,
      path.steps.map((step) => step.id),
    ]),
    [
      ['d', ['ab', 'bd']],
      ['e', ['ac', 'ce']],
    ],
  );
});

it('skips required-field steps and respects the path length limit', () => {
  const graph: StatusTransitionTree = {
    a: [edge('ab', 'b'), edge('blocked', 'x', true)],
    b: [edge('bc', 'c')],
    c: [edge('cd', 'd')],
    d: [edge('de', 'e')],
    e: [edge('ef', 'f')],
  };
  assert.deepEqual(
    statusPaths(status('a'), graph.a, graph).map((path) => path.destination.id),
    ['c', 'd', 'e'],
  );
});
