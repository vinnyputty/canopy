import type { AuthoringAction, AuthoringResult } from '../shared/authoring';

export type AuthoringDraft = {
  description?: string;
  fragments?: string;
  revision?: string;
  comment?: string;
  childSummary?: string;
  childDescription?: string;
  parent?: string;
  pending?: string;
  attemptId?: string;
  attemptVersion?: string;
  editVersions?: Partial<Record<'description' | 'comment' | 'child', string>>;
  result?: AuthoringResult;
};
export function draftKey(connectionId: string, key: string) {
  // Connection IDs encode the authenticated account/site, not its display name.
  return `canopy-authoring:${JSON.stringify([connectionId, key])}`;
}
export function loadDraft(
  storage: Pick<Storage, 'getItem'>,
  connectionId: string,
  key: string,
): AuthoringDraft {
  const source = storage.getItem(draftKey(connectionId, key));
  if (!source) return {};
  const value = JSON.parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Saved authoring draft is invalid.');
  for (const [name, field] of Object.entries(value)) {
    if (name === 'editVersions') {
      if (
        !field ||
        typeof field !== 'object' ||
        Array.isArray(field) ||
        Object.entries(field).some(
          ([kind, version]) =>
            !['description', 'comment', 'child'].includes(kind) ||
            typeof version !== 'string' ||
            version.length > 100,
        )
      )
        throw new Error('Saved draft revisions are invalid.');
    } else if (name === 'result') {
      if (
        !field ||
        typeof field !== 'object' ||
        !['saved', 'rejected', 'partial', 'unknown'].includes(
          (field as AuthoringResult).state,
        ) ||
        typeof (field as AuthoringResult).message !== 'string'
      )
        throw new Error('Saved authoring result is invalid.');
    } else if (
      ![
        'description',
        'fragments',
        'revision',
        'comment',
        'childSummary',
        'childDescription',
        'parent',
        'pending',
        'attemptId',
        'attemptVersion',
      ].includes(name) ||
      typeof field !== 'string' ||
      field.length > 500_000
    )
      throw new Error('Saved authoring draft is invalid.');
  }
  if (value.fragments !== undefined) {
    const fragments = JSON.parse(value.fragments);
    if (
      !Array.isArray(fragments) ||
      fragments.length > 500 ||
      fragments.some(
        (item) =>
          !item ||
          typeof item.id !== 'string' ||
          typeof item.value !== 'string',
      )
    )
      throw new Error('Saved rich description draft is invalid.');
  }
  return value;
}
export function saveDraft(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  connectionId: string,
  key: string,
  value: AuthoringDraft,
) {
  const name = draftKey(connectionId, key);
  if (Object.keys(value).length) storage.setItem(name, JSON.stringify(value));
  else storage.removeItem(name);
  notifyDraft(name);
}

// One renderer process may have successive panes for the same account/key.
// Keep live attempts separate from durable uncertainty across process restarts.
const activeAttempts = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();
function notifyDraft(name: string) {
  for (const listener of listeners.get(name) ?? []) listener();
}
export function subscribeDraft(
  connectionId: string,
  key: string,
  listener: () => void,
) {
  const name = draftKey(connectionId, key);
  const entries = listeners.get(name) ?? new Set();
  entries.add(listener);
  listeners.set(name, entries);
  return () => {
    entries.delete(listener);
    if (!entries.size) listeners.delete(name);
  };
}
export function activeAuthoringAttempt(
  connectionId: string,
  key: string,
): boolean {
  return activeAttempts.has(draftKey(connectionId, key));
}
export function beginAuthoringAttempt(
  connectionId: string,
  key: string,
  attemptId: string,
): boolean {
  const name = draftKey(connectionId, key);
  if (activeAttempts.has(name)) return false;
  activeAttempts.set(name, attemptId);
  notifyDraft(name);
  return true;
}
export function endAuthoringAttempt(
  connectionId: string,
  key: string,
  attemptId: string,
) {
  const name = draftKey(connectionId, key);
  if (activeAttempts.get(name) !== attemptId) return;
  activeAttempts.delete(name);
  notifyDraft(name);
}

export function settleAuthoringDraft(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  connectionId: string,
  key: string,
  attemptId: string,
  before: AuthoringDraft,
  action: AuthoringAction,
  result: AuthoringResult,
): AuthoringDraft {
  const latest = loadDraft(storage, connectionId, key);
  // A stale response owns neither a newer pending attempt nor its result.
  if (latest.attemptId !== attemptId) return latest;
  const next = { ...latest, result };
  if (result.state === 'saved' || result.state === 'rejected') {
    delete next.pending;
    delete next.attemptId;
    delete next.attemptVersion;
  }
  if (result.state === 'saved') {
    const unchanged = (kind: 'description' | 'comment' | 'child') =>
      latest.editVersions?.[kind] === before.editVersions?.[kind];
    if (
      action.kind === 'comment' &&
      unchanged('comment') &&
      latest.comment === action.value
    )
      delete next.comment;
    if (
      action.kind === 'description' &&
      unchanged('description') &&
      latest.revision === action.revision &&
      (action.fragments
        ? latest.fragments === JSON.stringify(action.fragments)
        : latest.description === action.value)
    ) {
      delete next.description;
      delete next.revision;
      delete next.fragments;
    }
    if (
      action.kind === 'child' &&
      unchanged('child') &&
      latest.childSummary === action.summary &&
      (latest.childDescription ?? '') === action.description
    ) {
      delete next.childSummary;
      delete next.childDescription;
    }
  }
  saveDraft(storage, connectionId, key, next);
  return next;
}
