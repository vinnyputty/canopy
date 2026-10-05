import type {
  Issue,
  IssueRelationships,
  TreeSnapshot,
} from '../../shared/types';
import { issueRelationships } from '../../shared/relationships';
import type { FixtureDate } from './model';
const issue = (
  key: string,
  summary: string,
  parentKey?: string,
  done = false,
): Issue => ({
  id: key,
  key,
  summary,
  parentKey,
  type: parentKey ? 'Task' : 'Epic',
  priority: null,
  assignee: null,
  status: {
    id: done ? 'done' : 'open',
    name: done ? 'Done' : 'Open',
    category: done ? 'done' : 'new',
  },
  links: [],
  linksAvailable: true,
});
const issues = [
  issue('PLAN-1', 'Ship release'),
  issue('PLAN-2', 'Prepare API', 'PLAN-1'),
  issue('PLAN-3', 'Build interface', 'PLAN-1'),
  issue('PLAN-4', 'Security review', 'PLAN-1'),
  issue('PLAN-5', 'Write guide', 'PLAN-1', true),
  issue('PLAN-6', 'Rollout', 'PLAN-1'),
];
issues[1].links = [
  {
    key: 'PLAN-3',
    summary: 'Build interface',
    relationship: 'blocks',
    statusCategory: 'new',
  },
];
issues[2].links = [
  {
    key: 'PLAN-2',
    summary: 'Prepare API',
    relationship: 'blocks',
    statusCategory: 'new',
  },
  {
    key: 'PLAN-5',
    summary: 'Write guide',
    relationship: 'relates to',
    statusCategory: 'done',
  },
];
issues[3].links = [
  { key: 'EXT-1', summary: 'External approval', relationship: 'is blocked by' },
];
issues[5].linksAvailable = false;
export const snapshot: TreeSnapshot = {
  rootKey: 'PLAN-1',
  issues,
  fetchedAt: 0,
  warnings: [],
};
export const relationships: IssueRelationships[] = issues.map((item) => {
  const graph = issueRelationships(item);
  // The fixture has a complete local hierarchy; links retain their own coverage states.
  graph.groups = graph.groups.filter(
    (group) => group.kind !== 'parent' && group.kind !== 'children',
  );
  return graph;
});
export const dates: FixtureDate[] = [
  {
    key: 'PLAN-2',
    date: '2026-11-03',
    field: 'due',
    source: 'fixture',
    reliable: true,
  },
  {
    key: 'PLAN-3',
    date: '2026-11-05',
    field: 'due',
    source: 'fixture',
    reliable: true,
  },
  {
    key: 'PLAN-5',
    date: '2026-11-04',
    field: 'due',
    source: 'fixture',
    reliable: true,
  },
  {
    key: 'PLAN-6',
    date: '2026-11-10',
    field: 'milestone',
    source: 'fixture',
    reliable: true,
  },
  {
    key: 'PLAN-4',
    date: '2026-11-01',
    field: 'due',
    source: 'fixture',
    reliable: false,
  },
];
