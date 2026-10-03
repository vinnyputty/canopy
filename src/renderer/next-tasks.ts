import { relationshipBlockers } from './relationships';
import type {
  Issue,
  IssueRelationships,
  Relationship,
  TreeSnapshot,
} from '../shared/types';
import { buildIssueTree, type IssueNode } from './tree';

export type NextTaskCriterion =
  'priority' | 'rank' | 'status' | 'assignment' | 'blocked';
export type BlockerState = 'clear' | 'blocked' | 'unknown';
export type NextTask = {
  issue: Issue;
  parents: Issue[];
  blocker: BlockerState;
  blockers: string[];
  blockerDetails: Relationship[];
  incomplete: boolean;
  blockerReason?: string;
  rankPath: number[];
};

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

function comparePath(a: number[], b: number[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

/** Build a flat task list from the complete root, independent of tree filters or expansion. */
export function nextTasks(
  snapshot: TreeSnapshot,
  provider: 'jira' | 'github' | 'demo',
  criterion: NextTaskCriterion,
  accountId?: string,
  assignedToMe = false,
  priorityOrder?: string[],
  relationships?: Record<string, IssueRelationships>,
): NextTask[] {
  const root = buildIssueTree(snapshot.issues, snapshot.rootKey);
  if (!root) return [];
  const byKey = new Map(snapshot.issues.map((issue) => [issue.key, issue]));
  const tasks: NextTask[] = [];
  const pending: { node: IssueNode; parents: Issue[]; rankPath: number[] }[] = [
    { node: root, parents: [], rankPath: [] },
  ];
  while (pending.length) {
    const { node, parents, rankPath } = pending.pop()!;
    const { issue } = node;
    if (
      issue.status.category !== 'done' &&
      !(
        provider === 'github' &&
        issue.key === snapshot.rootKey &&
        issue.type === 'Repository'
      ) &&
      (!assignedToMe || (accountId && issue.assignee?.id === accountId))
    ) {
      tasks.push({
        issue,
        parents,
        rankPath,
        ...relationshipBlockers(
          provider === 'github' ? { ...issue, linksAvailable: false } : issue,
          relationships?.[issue.key],
          byKey,
        ),
      });
    }
    for (let index = node.children.length - 1; index >= 0; index--)
      pending.push({
        node: node.children[index],
        parents: [...parents, issue],
        rankPath: [...rankPath, index],
      });
  }

  const criterionOrder = (a: NextTask, b: NextTask) => {
    switch (criterion) {
      case 'priority': {
        if (!priorityOrder) break;
        const index = (task: NextTask) => {
          const found = task.issue.priority
            ? priorityOrder.indexOf(task.issue.priority.id)
            : -1;
          return found < 0 ? Infinity : found;
        };
        return index(a) - index(b);
      }
      case 'status': {
        const order = { new: 0, indeterminate: 1, done: 2 };
        return (
          order[a.issue.status.category] - order[b.issue.status.category] ||
          collator.compare(a.issue.status.name, b.issue.status.name)
        );
      }
      case 'assignment': {
        const order = (task: NextTask) =>
          task.issue.assignee?.id === accountId
            ? 0
            : task.issue.assignee
              ? 1
              : 2;
        return (
          order(a) - order(b) ||
          collator.compare(
            a.issue.assignee?.name ?? '',
            b.issue.assignee?.name ?? '',
          )
        );
      }
      case 'blocked':
        break;
      case 'rank':
        break;
    }
    return 0;
  };
  const blockerOrder = { clear: 0, unknown: 1, blocked: 2 };
  return tasks.sort(
    (a, b) =>
      blockerOrder[a.blocker] - blockerOrder[b.blocker] ||
      criterionOrder(a, b) ||
      comparePath(a.rankPath, b.rankPath) ||
      collator.compare(a.issue.key, b.issue.key),
  );
}
