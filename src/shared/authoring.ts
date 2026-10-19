import type { Choice } from './types';

export type AuthoringField = {
  id: string;
  name: string;
  kind: 'text' | 'date' | 'choice' | 'choices';
  value: string;
  choices?: Choice[];
  required?: boolean;
};
export type AuthoringOptions = {
  description: {
    editable: boolean;
    value: string;
    revision: string;
    fragments?: { id: string; value: string }[];
    reason?: string;
  };
  comment: { allowed: boolean; reason?: string };
  parent: { allowed: boolean; reason?: string };
  createChild: boolean;
  fields: AuthoringField[];
  attachments: { id: string; name: string; size?: number; url: string }[];
  handoffs: string[];
};
export type ParentPlan = {
  key: string;
  parentKey: string | null;
  previousParent: string | null;
  revision: string;
  effects: string[];
};
export type AuthoringAction =
  | {
      kind: 'description';
      value: string;
      revision: string;
      fragments?: { id: string; value: string }[];
    }
  | { kind: 'comment'; value: string }
  | { kind: 'field'; id: string; value: string; previous: string }
  | { kind: 'parent'; plan: ParentPlan }
  | { kind: 'child'; summary: string; description: string };
export type AuthoringResult = {
  state: 'saved' | 'rejected' | 'unknown' | 'partial';
  message: string;
  key?: string;
};

/** Preserve text verbatim; HTML and provider documents are never accepted from IPC. */
export function authoringAction(value: unknown): AuthoringAction {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid authoring action.');
  const input = value as Record<string, any>;
  const string = (value: unknown, limit = 100_000) => {
    if (
      typeof value !== 'string' ||
      value.length > limit ||
      value.includes('\0')
    )
      throw new Error('Invalid authoring text.');
    return value;
  };
  switch (input.kind) {
    case 'description': {
      if (
        input.fragments !== undefined &&
        (!Array.isArray(input.fragments) ||
          input.fragments.length > 500 ||
          input.fragments.reduce(
            (sum: number, item: any) =>
              sum +
              (typeof item?.value === 'string' ? item.value.length : 100_001),
            0,
          ) > 100_000)
      )
        throw new Error('Invalid description fragments.');
      return {
        kind: input.kind,
        value: string(input.value),
        revision: string(input.revision, 500_000),
        ...(input.fragments
          ? {
              fragments: input.fragments.map((item: any) => ({
                id: string(item.id, 500),
                value: string(item.value),
              })),
            }
          : {}),
      };
    }
    case 'comment': {
      const value = string(input.value);
      if (!value.trim()) throw new Error('Write a comment first.');
      return { kind: input.kind, value };
    }
    case 'field':
      return {
        kind: input.kind,
        id: string(input.id, 100),
        value: string(input.value),
        previous: string(input.previous),
      };
    case 'child': {
      const summary = string(input.summary, 255).trim();
      if (!summary) throw new Error('Enter a child title.');
      return {
        kind: input.kind,
        summary,
        description: string(input.description),
      };
    }
    case 'parent': {
      const plan = input.plan;
      if (!plan || !Array.isArray(plan.effects))
        throw new Error('Preview the hierarchy change first.');
      return {
        kind: input.kind,
        plan: {
          key: string(plan.key, 500),
          parentKey:
            plan.parentKey === null ? null : string(plan.parentKey, 500),
          previousParent:
            plan.previousParent === null
              ? null
              : string(plan.previousParent, 500),
          revision: string(plan.revision, 100_000),
          effects: plan.effects.map((effect: unknown) => string(effect, 2000)),
        },
      };
    }
    default:
      throw new Error('Unsupported authoring action.');
  }
}
