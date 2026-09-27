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

it('offers distinct simple routes to the same destination in workflow order', () => {
  const graph: StatusTransitionTree = {
    a: [edge('ab', 'b'), edge('ac', 'c')],
    b: [edge('ba', 'a'), edge('bd', 'd')],
    c: [edge('cd', 'd'), edge('ce', 'e')],
    d: [edge('de', 'e')],
    e: [edge('ea', 'a')],
  };
  const paths = statusPaths(status('a'), graph.a, graph);
  assert.deepEqual(
    paths.routes.map((path) => [
      path.destination.id,
      path.steps.map((step) => step.id),
    ]),
    [
      ['d', ['ab', 'bd']],
      ['d', ['ac', 'cd']],
      ['e', ['ac', 'ce']],
      ['e', ['ab', 'bd', 'de']],
      ['e', ['ac', 'cd', 'de']],
    ],
  );
  assert.equal(paths.truncated, false);
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
    statusPaths(status('a'), graph.a, graph).routes.map(
      (path) => path.destination.id,
    ),
    ['c', 'd', 'e'],
  );
});

it('retains a four-transition Closed route alongside a shorter Closed route', () => {
  const graph: StatusTransitionTree = {
    backlog: [edge('start', 'not-started')],
    'not-started': [
      edge('close', 'closed'),
      edge('close-again', 'closed'),
      edge('progress', 'in-progress'),
    ],
    'in-progress': [edge('review', 'in-review')],
    'in-review': [edge('approve', 'closed')],
    closed: [edge('reopen', 'backlog')],
  };
  const paths = statusPaths(status('backlog'), graph.backlog, graph);
  assert.deepEqual(
    paths.routes
      .filter((path) => path.destination.id === 'closed')
      .map((path) => path.steps.map((step) => step.to.id)),
    [
      ['not-started', 'closed'],
      ['not-started', 'in-progress', 'in-review', 'closed'],
    ],
  );
  assert.equal(paths.truncated, false);
});

it('marks a bounded route set as incomplete', () => {
  const graph: StatusTransitionTree = {
    a: ['b', 'c', 'd', 'e', 'f'].map((to) => edge(`a-${to}`, to)),
    b: [edge('b-z', 'z')],
    c: [edge('c-z', 'z')],
    d: [edge('d-z', 'z')],
    e: [edge('e-z', 'z')],
    f: [edge('f-z', 'z')],
  };
  const paths = statusPaths(status('a'), graph.a, graph);
  assert.equal(
    paths.routes.filter((path) => path.destination.id === 'z').length,
    4,
  );
  assert.equal(paths.truncated, true);
});
