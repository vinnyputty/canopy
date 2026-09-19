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
  const prior = new Map(
    previous.children.map((child) => [child.issue.key, child]),
  );
  const children = next.children.map((child) =>
    retainEditingOrder(child, prior.get(child.issue.key), retained)!,
  );
  const pinned = new Map(
    children
      .filter(
        (child) => retained.has(child.issue.key) && prior.has(child.issue.key),
      )
      .map((child) => [child.issue.key, child]),
  );
  const ordered = children.filter((child) => !pinned.has(child.issue.key));
  previous.children.forEach((child, index) => {
    const node = pinned.get(child.issue.key);
    if (node) ordered.splice(Math.min(index, ordered.length), 0, node);
  });
  return { ...next, children: ordered };
}
