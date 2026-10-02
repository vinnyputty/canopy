import type { AuthoringResult } from '../shared/authoring';

export type AuthoringDraft = {
  description?: string;
  fragments?: string;
  revision?: string;
  comment?: string;
  childSummary?: string;
  childDescription?: string;
  parent?: string;
  pending?: string;
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
    if (name === 'result') {
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
}
