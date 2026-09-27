import type {
  Choice,
  DevelopmentLinks,
  EditOptions,
  Issue,
  IssuePatch,
  IssuePreview,
  TreeSnapshot,
} from '../shared/types';

const priorities: Choice[] = ['Highest', 'High', 'Medium', 'Low', 'Lowest'].map(
  (name, i) => ({ id: String(i + 1), name }),
);
const assignees: Choice[] = [
  { id: 'alex', name: 'Alex Morgan' },
  { id: 'sam', name: 'Sam Rivera' },
  { id: 'jordan', name: 'Jordan Lee' },
];
const statuses: Issue['status'][] = [
  { id: 'todo', name: 'To Do', category: 'new' },
  { id: 'progress', name: 'In Progress', category: 'indeterminate' },
  { id: 'done', name: 'Done', category: 'done' },
];
const details: Record<number, { description: string; comment: string }> = {
  100: {
    description:
      'A focused desktop workspace for planning work across an issue hierarchy. Follow the stories below from navigation through editing and release.',
    comment: 'The first release is ready for a guided walkthrough.',
  },
  108: {
    description:
      'A completed parent can still contain work in progress. Keep the path to unfinished descendants visible when Hide done is on, so the next task stays easy to find.',
    comment:
      'The tree now retains the parent path while hiding completed sibling work.',
  },
  111: {
    description:
      'Edit priority, owner, status, and title directly in the tree. The latest change can be undone after it is saved.',
    comment:
      'Try raising the priority, then use Undo to restore the original value.',
  },
  200: {
    description:
      'Keyboard navigation and linked trees help you move between related work without losing the original tab.',
    comment: 'The shortcut guide is available from the sidebar.',
  },
};
function issue(
  n: number,
  summary: string,
  type: string,
  parent?: number,
  status = 0,
  priority = 2,
  assignee = 0,
): Issue {
  return {
    id: String(n),
    key: `CAN-${n}`,
    summary,
    type,
    ...(parent ? { parentKey: `CAN-${parent}` } : {}),
    status: statuses[status],
    priority: priorities[priority],
    assignee: assignees[assignee],
    links: [],
  };
}
export const demoSeeds: Issue[] = [
  issue(100, 'A calmer place to get things done', 'Epic', undefined, 1, 1),
  issue(101, 'Build the workspace foundation', 'Story', 100, 1, 1),
  issue(102, 'Design the navigation shell', 'Task', 101, 2, 2, 1),
  issue(103, 'Create the tab experience', 'Task', 101, 1, 1),
  issue(104, 'Restore tabs when the app opens', 'Sub-task', 103, 2, 2),
  issue(105, 'Preserve scroll and selection', 'Sub-task', 103, 1, 2, 2),
  issue(106, 'Make room for every issue', 'Story', 100, 1, 0, 1),
  issue(107, 'Explore nested issue trees', 'Task', 106, 1, 1, 1),
  issue(108, 'Keep unfinished descendants visible', 'Sub-task', 107, 0, 2, 2),
  issue(109, 'Add linked issue references', 'Task', 106, 0, 3),
  issue(110, 'Keep the details in sync', 'Story', 100, 0, 2, 2),
  issue(111, 'Edit an issue without leaving the tree', 'Task', 110, 0, 1, 2),
  issue(112, 'Refresh quietly in the background', 'Task', 110, 0, 2),
  issue(113, 'Ship the first preview', 'Story', 100, 2, 3),
  issue(114, 'Package the desktop app', 'Task', 113, 2, 2, 1),
  issue(200, 'Polish the keyboard experience', 'Epic', undefined, 1, 2, 1),
  issue(201, 'Remap commands to feel at home', 'Story', 200, 1, 2),
  issue(202, 'Navigate trees with arrow keys', 'Task', 201, 0, 2, 2),
];
demoSeeds[8].links = [
  {
    key: 'CAN-200',
    summary: 'Polish the keyboard experience',
    relationship: 'relates to',
  },
];

export class DemoProvider {
  private previewRetryPending = false;
  constructor(
    private issues = structuredClone(demoSeeds),
    private persist: (issues: Issue[]) => Promise<void> = async () => {},
    private previewFailureOnce = false,
  ) {}
  private get(key: string) {
    const found = this.issues.find((i) => i.key === key.toUpperCase());
    if (!found)
      throw new Error(
        'Issue not found. Try CAN-100 or CAN-200 in the demo workspace.',
      );
    return found;
  }
  async tree(rootKey: string): Promise<TreeSnapshot> {
    const root = this.get(rootKey);
    const included = new Set([root.key]);
    for (let previous = 0; previous !== included.size;) {
      previous = included.size;
      for (const i of this.issues)
        if (i.parentKey && included.has(i.parentKey)) included.add(i.key);
    }
    return {
      rootKey: root.key,
      issues: structuredClone(this.issues.filter((i) => included.has(i.key))),
      fetchedAt: Date.now(),
      warnings: [],
      ranking: {
        state: 'supported',
        issueKeys: [...included].filter((key) => key !== root.key),
      },
    };
  }
  async priorityOrder(keys: string[]) {
    const ids = new Set(keys.map((key) => this.get(key).priority?.id));
    return priorities
      .filter((priority) => ids.has(priority.id))
      .map((priority) => priority.id);
  }
  async preview(key: string): Promise<IssuePreview> {
    const commentsError =
      key === 'CAN-108' && this.previewFailureOnce
        ? 'Comments temporarily unavailable.'
        : undefined;
    if (commentsError) {
      this.previewFailureOnce = false;
      this.previewRetryPending = true;
    } else if (key === 'CAN-108' && this.previewRetryPending) {
      this.previewRetryPending = false;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    return {
      ...(commentsError ? { commentsError } : {}),
      issue: structuredClone(this.get(key)),
      description:
        details[Number(key.split('-')[1])]?.description ??
        `${this.get(key).summary}. This work belongs to the Canopy desktop workspace.`,
      comments: [
        {
          id: 'demo-comment',
          author: 'Alex Morgan',
          created: '2026-01-01T12:00:00Z',
          body:
            details[Number(key.split('-')[1])]?.comment ??
            'The team is tracking this work in the issue tree.',
        },
      ],
      totalComments: 1,
    };
  }
  async development(_key: string): Promise<DevelopmentLinks> {
    return {
      state: 'unavailable',
      reason: 'Development links are unavailable in the demo workspace.',
      branches: {
        state: 'unavailable',
        reason: 'Development integration is unavailable.',
      },
      pullRequests: [],
      commits: [],
    };
  }
  async search(query: string, nextPageToken?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const offset = Number(nextPageToken ?? 0);
    const matches = this.issues.filter((i) =>
      `${i.key} ${i.summary}`.toLowerCase().includes(query.toLowerCase()),
    );
    return {
      issues: structuredClone(matches.slice(offset, offset + 25)),
      ...(offset + 25 < matches.length
        ? { nextPageToken: String(offset + 25) }
        : {}),
    };
  }
  async priorities(_key: string, _refresh = false) {
    return priorities;
  }
  async cachedUsers() {
    return assignees;
  }
  async assignees(_key: string, query = '', _startAt = 0, _refresh = false) {
    return {
      users: assignees.filter((a) =>
        a.name.toLowerCase().includes(query.toLowerCase()),
      ),
    };
  }
  async validateAssignee(
    _key: string,
    id: string,
    _refresh = false,
  ): Promise<Choice | null> {
    const user = assignees.find((user) => user.id === id);
    if (!user) throw new Error('This person is not assignable to this issue.');
    return user;
  }
  async transitions(
    _key: string,
    _refresh = false,
  ): Promise<EditOptions['transitions']> {
    return statuses.map((s) => ({
      id: s.id,
      name: s.name,
      requiresFields: false,
      to: s,
    }));
  }
  async update(key: string, patch: IssuePatch) {
    const i = this.get(key);
    if (patch.summary !== undefined) {
      if (!patch.summary.trim()) throw new Error('Summary cannot be empty.');
      i.summary = patch.summary.trim();
    }
    if (patch.priorityId !== undefined) {
      const priority = priorities.find((p) => p.id === patch.priorityId);
      if (!priority) throw new Error('Unknown priority.');
      i.priority = priority;
    }
    if (patch.assigneeId !== undefined) {
      const assignee = assignees.find((a) => a.id === patch.assigneeId);
      if (patch.assigneeId !== null && !assignee)
        throw new Error('Unknown assignee.');
      i.assignee = assignee ?? null;
    }
    if (patch.transitionId !== undefined) {
      const status = statuses.find((s) => s.id === patch.transitionId);
      if (!status) throw new Error('Unknown transition.');
      i.status = status;
    }
    await this.persist(this.issues);
    return structuredClone(i);
  }
  async rank(
    key: string,
    beforeKey: string,
    position: 'before' | 'after' = 'before',
  ) {
    const issue = this.get(key),
      before = this.get(beforeKey);
    if (!issue.parentKey || issue.parentKey !== before.parentKey)
      throw new Error('Only siblings can be reordered.');
    if (key === beforeKey) return;
    this.issues.splice(this.issues.indexOf(issue), 1);
    this.issues.splice(
      this.issues.indexOf(before) + (position === 'after' ? 1 : 0),
      0,
      issue,
    );
    await this.persist(this.issues);
  }
}
