import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dates,
  relationships,
  snapshot,
} from '../src/exploratory/planning/fixture';
import {
  fixtureMilestones,
  planningGraph,
} from '../src/exploratory/planning/model';

test('blocker cycles exclude ordinary links and incomplete endpoints', () => {
  const graph = planningGraph(snapshot, relationships, {}, false);
  assert.deepEqual(
    graph.edges
      .filter((edge) => edge.cycle)
      .map((edge) => [edge.from, edge.to]),
    [
      ['PLAN-2', 'PLAN-3'],
      ['PLAN-3', 'PLAN-2'],
    ],
  );
  assert.equal(
    graph.edges.find((edge) => edge.from === 'EXT-1')?.unknown,
    true,
  );
  assert.ok(
    graph.unknown.some((reason) => reason.startsWith('PLAN-6 blockers:')),
  );
  assert.equal(
    graph.edges.find((edge) => edge.kind === 'related')?.cycle,
    false,
  );
  assert.equal(
    graph.edges.filter((edge) => edge.kind === 'hierarchy').length,
    5,
  );
});

test('saved filtering preserves tree context and labels filtered endpoints', () => {
  const graph = planningGraph(
    snapshot,
    relationships,
    { status: 'done' },
    false,
  );
  assert.deepEqual([...graph.nodes.keys()], ['PLAN-1', 'PLAN-5']);
  assert.ok(
    graph.edges.every(
      (edge) => graph.nodes.has(edge.from) || graph.nodes.has(edge.to),
    ),
  );
  assert.equal(graph.edges.find((edge) => edge.to === 'PLAN-2')?.unknown, true);
  assert.equal(graph.edges.filter((edge) => edge.cycle).length, 0);
  assert.deepEqual(
    fixtureMilestones(dates, new Set(graph.nodes.keys())).map(
      (item) => item.key,
    ),
    ['PLAN-5'],
  );
});

test('milestones require explicit reliability, valid calendar date, provenance and visible issue', () => {
  const visible = new Set(['PLAN-2', 'PLAN-4']);
  assert.deepEqual(
    fixtureMilestones(dates, visible).map((item) => item.key),
    ['PLAN-2'],
  );
  const base = dates[0];
  assert.deepEqual(
    fixtureMilestones(
      [
        { ...base, date: '2026-02-30' },
        { ...base, date: '2026-11-03T12:00:00Z' },
        { ...base, date: 'unknown' },
        { ...base, source: 'jira' as 'fixture' },
      ],
      visible,
    ),
    [],
  );
  assert.deepEqual(fixtureMilestones([], visible), []);
});
