import type { Workspace } from './types';

export type TriageAction = 'pin' | 'unpin' | 'snooze' | 'wake' | 'seen';
export type TriagePreference = {
  connectionId: string;
  issueKey: string;
  touchedAt: number;
  pinned: boolean;
  snoozedUntil?: number;
};
export type TriageState = {
  version: 1;
  items: TriagePreference[];
  reviewStatuses: Record<string, string[]>;
  history: {
    connectionId: string;
    issueKey: string;
    action: TriageAction;
    at: number;
  }[];
};
export const MAX_TRIAGE_ITEMS = 500;
export const MAX_TRIAGE_HISTORY = 100;
export const TRIAGE_RETENTION = 90 * 24 * 60 * 60 * 1000;
export const emptyTriage = (): TriageState => ({
  version: 1,
  items: [],
  reviewStatuses: {},
  history: [],
});
export const triageIdentity = (connectionId: string, issueKey: string) =>
  JSON.stringify([connectionId, issueKey]);
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 500;
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const time = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 8_640_000_000_000_000;
export function validTriage(value: unknown): value is TriageState {
  if (
    !record(value) ||
    !keys(value, ['version', 'items', 'reviewStatuses', 'history']) ||
    value.version !== 1 ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_TRIAGE_ITEMS ||
    !Array.isArray(value.history) ||
    value.history.length > MAX_TRIAGE_HISTORY ||
    !record(value.reviewStatuses) ||
    Object.keys(value.reviewStatuses).length > 100
  )
    return false;
  const identity = (item: unknown) =>
    record(item) && text(item.connectionId) && text(item.issueKey);
  return (
    value.items.every(
      (item) =>
        identity(item) &&
        record(item) &&
        keys(item, [
          'connectionId',
          'issueKey',
          'touchedAt',
          'pinned',
          'snoozedUntil',
        ]) &&
        time(item.touchedAt) &&
        typeof item.pinned === 'boolean' &&
        (item.snoozedUntil === undefined || time(item.snoozedUntil)),
    ) &&
    new Set(
      value.items.map((item) =>
        triageIdentity(item.connectionId, item.issueKey),
      ),
    ).size === value.items.length &&
    value.history.every(
      (item) =>
        identity(item) &&
        record(item) &&
        keys(item, ['connectionId', 'issueKey', 'action', 'at']) &&
        time(item.at) &&
        typeof item.action === 'string' &&
        ['pin', 'unpin', 'snooze', 'wake', 'seen'].includes(item.action),
    ) &&
    Object.entries(value.reviewStatuses).every(
      ([id, statuses]) =>
        text(id) &&
        Array.isArray(statuses) &&
        statuses.length <= 50 &&
        statuses.every(text) &&
        new Set(statuses).size === statuses.length,
    )
  );
}
export function recoverTriage(value: unknown, now = Date.now()): TriageState {
  if (!validTriage(value)) return emptyTriage();
  return {
    ...value,
    items: value.items.flatMap((item) => {
      const snoozedUntil =
        item.snoozedUntil && item.snoozedUntil > now
          ? item.snoozedUntil
          : undefined;
      return item.pinned || snoozedUntil ? [{ ...item, snoozedUntil }] : [];
    }),
    history: value.history
      .filter((item) => item.at <= now && item.at >= now - TRIAGE_RETENTION)
      .slice(-MAX_TRIAGE_HISTORY),
  };
}
export function changeTriage(
  value: TriageState | undefined,
  connectionId: string,
  issueKey: string,
  action: TriageAction,
  now = Date.now(),
  duration = 0,
): TriageState {
  const state = recoverTriage(value, now);
  const old = state.items.find(
    (item) => item.connectionId === connectionId && item.issueKey === issueKey,
  );
  const item: TriagePreference = {
    connectionId,
    issueKey,
    touchedAt: now,
    pinned: old?.pinned ?? false,
    snoozedUntil: old?.snoozedUntil,
  };
  if (action === 'pin' || action === 'unpin') item.pinned = action === 'pin';
  if (action === 'snooze') item.snoozedUntil = now + duration;
  if (action === 'wake') item.snoozedUntil = undefined;
  const items = state.items.filter(
    (item) => item.connectionId !== connectionId || item.issueKey !== issueKey,
  );
  if (item.pinned || item.snoozedUntil) items.push(item);
  return {
    ...state,
    items: items
      .sort((a, b) => b.touchedAt - a.touchedAt)
      .slice(0, MAX_TRIAGE_ITEMS),
    history: [
      ...state.history,
      { connectionId, issueKey, action, at: now },
    ].slice(-MAX_TRIAGE_HISTORY),
  };
}
export function removeTriageConnection(
  value: Workspace['triage'],
  id: string,
): TriageState {
  const state = recoverTriage(value);
  const reviewStatuses = { ...state.reviewStatuses };
  delete reviewStatuses[id];
  return {
    ...state,
    reviewStatuses,
    items: state.items.filter((item) => item.connectionId !== id),
    history: state.history.filter((item) => item.connectionId !== id),
  };
}
