import type { TableColumn } from '../shared/types';
import type { IssueNode } from './tree';

export type EditField = 'summary' | 'priority' | 'assignee' | 'status';

export function nextEditableCell(
  rows: IssueNode[],
  columns: TableColumn[],
  key: string,
  field: EditField,
  direction: -1 | 1,
): { key: string; field: EditField } | null {
  const fields: EditField[] = columns.map((column) =>
    column === 'issue' ? 'summary' : column,
  );
  const row = rows.findIndex((node) => node.issue.key === key);
  const column = fields.indexOf(field);
  if (row < 0 || column < 0 || !fields.length) return null;
  const index = row * fields.length + column + direction;
  const target = rows[Math.floor(index / fields.length)];
  return target
    ? { key: target.issue.key, field: fields[index % fields.length] }
    : null;
}

// Preserve the sibling slots of active/pending rows while other rows still sort.
// Ancestors are protected by the caller so an edited descendant stays in place.
export function retainEditingOrder(
  next: IssueNode | null,
  previous: IssueNode | null | undefined,
  retained: ReadonlySet<string>,
): IssueNode | null {
  if (
    !next ||
    !previous ||
    next.issue.key !== previous.issue.key ||
    !retained.size
  )
    return next;
  const pending = [{ next, previous }],
    order: { next: IssueNode; previous: IssueNode }[] = [];
  const results = new Map<IssueNode, IssueNode>();
  while (pending.length) {
    const pair = pending.pop()!;
    order.push(pair);
    const prior = new Map(
      pair.previous.children.map((child) => [child.issue.key, child]),
    );
    for (const child of pair.next.children) {
      const old = prior.get(child.issue.key);
      if (old) pending.push({ next: child, previous: old });
    }
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const { next: current, previous: old } = order[i];
    const prior = new Map(
      old.children.map((child) => [child.issue.key, child]),
    );
    const children = current.children.map(
      (child) => results.get(child) ?? child,
    );
    const pinned = new Map(
      children
        .filter(
          (child) =>
            retained.has(child.issue.key) && prior.has(child.issue.key),
        )
        .map((child) => [child.issue.key, child]),
    );
    const ordered = children.filter((child) => !pinned.has(child.issue.key));
    old.children.forEach((child, index) => {
      const node = pinned.get(child.issue.key);
      if (node) ordered.splice(Math.min(index, ordered.length), 0, node);
    });
    results.set(current, { ...current, children: ordered });
  }
  return results.get(next)!;
}
