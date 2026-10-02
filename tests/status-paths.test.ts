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
    [...new Set(paths.routes.map((path) => path.destination.id))],
    ['in-progress', 'in-review', 'closed'],
  );
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

it('never revisits the source or an intermediate status, including self-loops', () => {
  const graph: StatusTransitionTree = {
    a: [edge('aa', 'a'), edge('ab', 'b')],
    b: [edge('bb', 'b'), edge('ba', 'a'), edge('bc', 'c')],
    c: [edge('cb', 'b'), edge('cc', 'c'), edge('cd', 'd')],
    d: [edge('da', 'a'), edge('db', 'b')],
  };
  const paths = statusPaths(status('a'), graph.a, graph);
  assert.deepEqual(
    paths.routes.map((path) => path.steps.map((step) => step.to.id)),
    [
      ['b', 'c'],
      ['b', 'c', 'd'],
    ],
  );
  assert.equal(paths.truncated, false);
});

it('ranks a longer branch before an earlier shortcut and keeps other branches', () => {
  const graph: StatusTransitionTree = {
    a: [edge('ax', 'x'), edge('ab', 'b')],
    x: [edge('xz', 'z')],
    b: [edge('bc', 'c')],
    c: [edge('cd', 'd')],
    d: [edge('de', 'e')],
  };
  assert.deepEqual(
    statusPaths(status('a'), graph.a, graph).routes.map(
      (path) => path.destination.id,
    ),
    ['c', 'd', 'e', 'z'],
  );
});

it('breaks longest-route ties by transition order rather than shortcut discovery', () => {
  const graph: StatusTransitionTree = {
    a: [edge('ab', 'b'), edge('ax', 'x')],
    b: [edge('shortcut', 'z'), edge('bc', 'c')],
    c: [edge('cd', 'd')],
    x: [edge('xy', 'y')],
    y: [edge('yz', 'z')],
  };
  const destinations = (direct = graph.a) => [
    ...new Set(
      statusPaths(status('a'), direct, graph).routes.map(
        (path) => path.destination.id,
      ),
    ),
  ];
  assert.deepEqual(destinations(), ['c', 'd', 'y', 'z']);
  assert.deepEqual(destinations([...graph.a].reverse()), ['y', 'z', 'c', 'd']);
});

it('keeps the first rank of a shared status encountered on a later branch', () => {
  const graph: StatusTransitionTree = {
    a: [edge('ab', 'b'), edge('ax', 'x')],
    b: [edge('bc', 'c')],
    c: [edge('cd', 'd')],
    x: [edge('xy', 'y')],
    y: [edge('yc', 'c')],
  };
  const paths = statusPaths(status('a'), graph.a, graph);
  assert.deepEqual(
    [...new Set(paths.routes.map((path) => path.destination.id))],
    ['y', 'c', 'd'],
  );
  assert.equal(
    paths.routes.filter((path) => path.destination.id === 'c').length,
    2,
  );
});

it('excludes required-field shortcuts and longer branches from ranking', () => {
  const graph: StatusTransitionTree = {
    a: [edge('ax', 'x', true), edge('ab', 'b')],
    x: [edge('xy', 'y')],
    y: [edge('yz', 'z')],
    z: [edge('zc', 'c')],
    b: [edge('blocked', 'd', true), edge('bc', 'c')],
    d: [edge('de', 'e')],
  };
  assert.deepEqual(
    statusPaths(status('a'), graph.a, graph).routes.map((path) =>
      path.steps.map((step) => step.id),
    ),
    [['ab', 'bc']],
  );
});

it('bounds dense cyclic graphs while retaining simple alternate routes', () => {
  const ids = Array.from({ length: 30 }, (_, index) => String(index));
  const graph: StatusTransitionTree = Object.fromEntries(
    ids.map((from) => [from, ids.map((to) => edge(`${from}-${to}`, to))]),
  );
  const paths = statusPaths(status('0'), graph['0'], graph);
  assert.equal(paths.truncated, true);
  assert.equal(paths.routes.length, 80);
  assert.ok(
    paths.routes.filter(
      (path) => path.destination.id === paths.routes[0].destination.id,
    ).length > 1,
  );
  for (const path of paths.routes) {
    const visited = ['0', ...path.steps.map((step) => step.to.id)];
    assert.equal(new Set(visited).size, visited.length);
    assert.ok(path.steps.length <= 4);
  }
  assert.deepEqual(statusPaths(status('0'), graph['0'], graph), paths);
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
