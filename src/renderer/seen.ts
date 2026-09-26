import type {
  Issue,
  SeenIssue,
  SeenRoot,
  SeenValue,
  TreeSnapshot,
} from '../shared/types';

export const MAX_SEEN_ROOTS = 12;
export const MAX_SEEN_ISSUES = 1000;
const MAX_VALUE = 300;
const MAX_LABELS = 20;
const MAX_SEEN_BYTES = 2_000_000;

export function seenRootKey(connectionId: string, rootKey: string) {
  return `${connectionId}:${rootKey}`;
}

function clipped(value: string) {
  return value.slice(0, MAX_VALUE);
}

export function issueFields(issue: Issue): Record<string, SeenValue> {
  const unavailable = new Set(issue.unavailableFields);
  const fields: Record<string, SeenValue> = {};
  if (!unavailable.has('summary')) fields.Summary = clipped(issue.summary);
  if (!unavailable.has('type')) fields.Type = clipped(issue.type);
  if (!unavailable.has('parent')) fields.Parent = issue.parentKey ?? null;
  if (!unavailable.has('priority'))
    fields.Priority = issue.priority?.name
      ? clipped(issue.priority.name)
      : null;
  if (!unavailable.has('assignee'))
    fields.Assignee = issue.assignee?.name
      ? clipped(issue.assignee.name)
      : null;
  if (!unavailable.has('status')) fields.Status = clipped(issue.status.name);
  if (
    issue.labels &&
    issue.labels.length <= MAX_LABELS &&
    !unavailable.has('labels')
  )
    fields.Labels = issue.labels.map((label) => label.name.slice(0, 80)).sort();
  return fields;
}

function capture(issue: Issue, now: number): SeenIssue {
  return {
    seenAt: now,
    fields: issueFields(issue),
    ...(issue.commentCount !== undefined &&
    Number.isSafeInteger(issue.commentCount) &&
    issue.commentCount >= 0
      ? { commentCount: issue.commentCount }
      : {}),
  };
}

export function seedOrExtend(
  root: SeenRoot | undefined,
  snapshot: TreeSnapshot,
): SeenRoot {
  const issues = { ...root?.issues };
  for (const issue of snapshot.issues.slice(0, MAX_SEEN_ISSUES)) {
    const previous = issues[issue.key];
    const current = capture(issue, snapshot.fetchedAt);
    issues[issue.key] = previous
      ? {
          ...previous,
          fields: { ...current.fields, ...previous.fields },
          commentCount: previous.commentCount ?? current.commentCount,
        }
      : current;
  }
  return { touchedAt: snapshot.fetchedAt, issues };
}

export function boundRoots(
  roots: Record<string, SeenRoot>,
): Record<string, SeenRoot> {
  const bounded: Record<string, SeenRoot> = {};
  let bytes = 0;
  for (const [key, root] of Object.entries(roots)
    .sort((a, b) => b[1].touchedAt - a[1].touchedAt)
    .slice(0, MAX_SEEN_ROOTS)) {
    const issues: SeenRoot['issues'] = {};
    for (const [issueKey, issue] of Object.entries(root.issues)
      .sort((a, b) => b[1].seenAt - a[1].seenAt)
      .slice(0, MAX_SEEN_ISSUES)) {
      const size = JSON.stringify([issueKey, issue]).length;
      if (bytes + size > MAX_SEEN_BYTES) break;
      issues[issueKey] = issue;
      bytes += size;
    }
    bounded[key] = { ...root, issues };
  }
  return bounded;
}

export function markIssueSeen(
  root: SeenRoot,
  issue: Issue,
  now: number,
): SeenRoot {
  return {
    ...root,
    touchedAt: now,
    issues: { ...root.issues, [issue.key]: capture(issue, now) },
  };
}

export function markRootSeen(
  snapshot: TreeSnapshot,
  previous?: SeenRoot,
  now = Date.now(),
): SeenRoot {
  return {
    touchedAt: now,
    issues: {
      ...previous?.issues,
      ...Object.fromEntries(
        snapshot.issues
          .slice(0, MAX_SEEN_ISSUES)
          .map((issue) => [issue.key, capture(issue, now)]),
      ),
    },
  };
}

export function reconcileOwnEdit(
  roots: Record<string, SeenRoot>,
  connectionId: string,
  issue: Issue,
  written: string[],
): Record<string, SeenRoot> {
  const fields = issueFields(issue);
  const next = { ...roots };
  for (const [rootKey, root] of Object.entries(roots)) {
    if (!rootKey.startsWith(`${connectionId}:`) || !root.issues[issue.key])
      continue;
    const previous = root.issues[issue.key];
    const updated = { ...previous.fields };
    for (const name of written)
      if (name in fields) updated[name] = fields[name];
    next[rootKey] = {
      ...root,
      issues: { ...root.issues, [issue.key]: { ...previous, fields: updated } },
    };
  }
  return next;
}

export function unseenChanges(baseline: SeenIssue | undefined, issue: Issue) {
  if (!baseline)
    return {
      fields: [] as { name: string; before: SeenValue; after: SeenValue }[],
      comments: 0,
    };
  const current = issueFields(issue);
  const fields = Object.entries(current).flatMap(([name, after]) => {
    if (!(name in baseline.fields)) return [];
    const before = baseline.fields[name];
    return JSON.stringify(before) === JSON.stringify(after)
      ? []
      : [{ name, before, after }];
  });
  const comments =
    baseline.commentCount !== undefined && issue.commentCount !== undefined
      ? Math.max(0, issue.commentCount - baseline.commentCount)
      : 0;
  return { fields, comments };
}
