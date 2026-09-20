import type { Issue, IssuePatch } from '../shared/types';

const LIMIT = 50;
const MAX_AGE = 5 * 60 * 1000;
type Fields = Partial<
  Pick<Issue, 'summary' | 'priority' | 'assignee' | 'status'>
>;
type Changed = {
  key: string;
  id?: number;
  at: number;
  fields?: Fields;
  uncertain: boolean;
};
type Move = {
  key: string;
  parent: string;
  anchor: string;
  position: 'before' | 'after';
  at: number;
};
type Recent = { changes: Changed[]; moves: Move[] };

// One instance belongs to one authenticated provider, shared by overlapping trees.
export class JiraConsistency {
  private changes = new Map<string, Changed>();
  private moves: Move[] = [];

  private prune() {
    const cutoff = Date.now() - MAX_AGE;
    for (const [key, change] of this.changes)
      if (change.at <= cutoff) this.changes.delete(key);
    this.moves = this.moves.filter(
      (move) => move.at > cutoff && this.changes.has(move.key),
    );
  }
  snapshot(): Recent {
    this.prune();
    return { changes: [...this.changes.values()], moves: [...this.moves] };
  }
  ids() {
    return this.snapshot().changes.flatMap((change) =>
      change.id === undefined ? [] : [change.id],
    );
  }
  changed(key: string, id?: unknown, fields?: Fields) {
    this.prune();
    key = key.toUpperCase();
    const previous = this.changes.get(key);
    const number = Number(id ?? previous?.id);
    this.changes.delete(key);
    this.changes.set(key, {
      key,
      ...(Number.isSafeInteger(number) && number > 0 ? { id: number } : {}),
      at: Date.now(),
      fields: fields ?? previous?.fields,
      uncertain: fields === undefined,
    });
    if (this.changes.size > LIMIT)
      this.changes.delete(this.changes.keys().next().value!);
    this.prune();
  }
  confirm(issue: Issue, patch: IssuePatch) {
    const previous = this.changes.get(issue.key.toUpperCase());
    if (!previous) return;
    const fields: Fields = { ...previous.fields };
    if (patch.summary !== undefined) fields.summary = issue.summary;
    if (patch.priorityId !== undefined) fields.priority = issue.priority;
    if (patch.assigneeId !== undefined) fields.assignee = issue.assignee;
    if (patch.transitionId !== undefined) fields.status = issue.status;
    const id = Number(issue.id);
    this.changes.set(issue.key.toUpperCase(), {
      ...previous,
      ...(Number.isSafeInteger(id) && id > 0 ? { id } : {}),
      fields,
      uncertain: false,
    });
  }
  disagrees(issue: Issue, recent: Recent) {
    const change = recent.changes.find(
      (change) => change.key === issue.key.toUpperCase(),
    );
    return (
      !!change &&
      change.at > Date.now() - MAX_AGE &&
      (change.uncertain ||
        Object.entries(change.fields ?? {}).some(
          ([field, value]) =>
            JSON.stringify(issue[field as keyof Fields]) !==
            JSON.stringify(value),
        ))
    );
  }
  moved(issue: Issue, anchor: string, position: 'before' | 'after') {
    const previous = this.changes.get(issue.key.toUpperCase());
    this.changed(issue.key, issue.id, previous ? previous.fields : {});
    if (previous?.uncertain)
      this.changes.get(issue.key.toUpperCase())!.uncertain = true;
    this.moves.push({
      key: issue.key.toUpperCase(),
      parent: issue.parentKey!,
      anchor,
      position,
      at: Date.now(),
    });
    if (this.moves.length > LIMIT) this.moves.shift();
  }
  rank(
    issues: Issue[],
    recent: Recent,
  ): { issues: Issue[]; parents: string[] } {
    const parents: string[] = [];
    for (const parent of new Set(recent.moves.map((move) => move.parent))) {
      const moves = recent.moves.filter(
        (move) => move.parent === parent && move.at > Date.now() - MAX_AGE,
      );
      const siblings = issues.filter((issue) => issue.parentKey === parent);
      const ordered = [...siblings];
      for (const move of moves) {
        const moving = ordered.find((issue) => issue.key === move.key);
        const anchor = ordered.find((issue) => issue.key === move.anchor);
        if (!moving || !anchor) continue;
        ordered.splice(ordered.indexOf(moving), 1);
        ordered.splice(
          ordered.indexOf(anchor) + (move.position === 'after' ? 1 : 0),
          0,
          moving,
        );
      }
      if (ordered.some((issue, index) => issue !== siblings[index])) {
        parents.push(parent);
        let index = 0;
        issues = issues.map((issue) =>
          issue.parentKey === parent ? ordered[index++]! : issue,
        );
      } else if (
        siblings.length &&
        moves.every(
          (move) =>
            siblings.some((issue) => issue.key === move.key) &&
            siblings.some((issue) => issue.key === move.anchor),
        )
      ) {
        // Retire only this request's moves; concurrent writes retain their protection.
        this.moves = this.moves.filter((move) => !moves.includes(move));
      }
    }
    return { issues, parents };
  }
}
