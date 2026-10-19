import { useEffect, useRef, useState } from 'react';
import type {
  Connection,
  HandoffDelivery,
  HandoffState,
  TabState,
  TreeSnapshot,
  Workspace,
} from '../shared/types';
import { resolveWorkHandoff, type WorkHandoff } from '../shared/work-handoff';
import { ancestorPath, buildIssueTree } from './tree';
import { rootView } from './table-view';
import { sameRoot } from './workspace';
import { configuredRoots, viewSources } from './saved-views';

export const HANDOFF_REJECTION =
  'Canopy could not open the command. Use an existing connection, confirmed issue root or saved view and try again.';

export function handoffNavigation(
  intent: WorkHandoff,
  connections: Connection[],
  workspace: Workspace,
  snapshots: { connectionId: string; snapshot: TreeSnapshot }[],
  createId: () => string,
): { kind: 'view'; viewId: string } | { kind: 'issue'; tab: TabState } {
  const target = resolveWorkHandoff(intent, connections, workspace, snapshots);
  if (target.kind === 'view') {
    const view = workspace.savedViews!.find((view) => view.id === target.view)!;
    const sources = viewSources(view, configuredRoots(workspace, connections));
    if (
      !sources.length ||
      sources.some(
        (source) =>
          !snapshots.some(
            (item) =>
              item.connectionId === source.connectionId &&
              item.snapshot.rootKey === source.rootKey,
          ),
      )
    )
      throw new Error('Saved view data is unavailable.');
    return { kind: 'view', viewId: target.view };
  }
  const source = { connectionId: target.connection, rootKey: target.root };
  const snapshot = snapshots.find(
    (item) =>
      item.connectionId === target.connection &&
      item.snapshot.rootKey === target.root,
  )!.snapshot;
  const path = ancestorPath(
    buildIssueTree(snapshot.issues, target.root),
    target.key,
  );
  if (!path.length)
    throw new Error('Issue is unavailable in the root hierarchy.');
  const existing = workspace.tabs.find((tab) => sameRoot(tab, source));
  const view = rootView(workspace, source);
  const tab = existing ?? {
    ...source,
    id: createId(),
    expanded: [],
    hideDone: view.hideDone,
    filters: view.filters,
    scrollTop: 0,
  };
  return {
    kind: 'issue',
    tab: {
      ...tab,
      selectedKey: target.key,
      focusKey: undefined,
      expanded: [
        ...new Set([...tab.expanded, ...path.map((node) => node.issue.key)]),
      ],
    },
  };
}

/** Acknowledge after React commits navigation; no polling, stale session or async navigation. */
export function useWorkHandoff(
  enabled: boolean,
  navigate: (intent: WorkHandoff) => void,
  reject: () => void,
): void {
  const handlers = useRef({ navigate, reject });
  handlers.current = { navigate, reject };
  const session = useRef<string | undefined>(undefined);
  const lastId = useRef<string | undefined>(undefined);
  const [delivery, setDelivery] = useState<HandoffDelivery | null>(null);
  const [completed, setCompleted] = useState<{
    delivery: HandoffDelivery;
    result: 'opened' | 'rejected';
  } | null>(null);
  useEffect(() => {
    let live = true;
    let early: HandoffState | undefined;
    const receive = (state: HandoffState) => {
      if (!live) return;
      if (state.session === '' && state.rejected) {
        handlers.current.reject();
        return;
      }
      if (!session.current) {
        early =
          early?.session === state.session
            ? {
                ...early,
                ...state,
                rejected: early.rejected || state.rejected,
                delivery:
                  state.canceledId === early.delivery?.id
                    ? undefined
                    : (state.delivery ?? early.delivery),
              }
            : state;
        return;
      }
      if (session.current !== state.session) return;
      if (state.rejected) handlers.current.reject();
      if (state.canceledId)
        setDelivery((current) =>
          current?.id === state.canceledId ? null : current,
        );
      if (
        state.delivery &&
        state.delivery.session === state.session &&
        state.delivery.id !== lastId.current
      )
        setDelivery(state.delivery);
    };
    const unsubscribe = window.canopy.onHandoff(receive);
    if (enabled)
      void window.canopy
        .handoffReady(crypto.randomUUID())
        .then((state) => {
          if (!live) {
            void window.canopy.handoffCancel(state.session).catch(() => {});
            return;
          }
          session.current = state.session;
          receive(state);
          if (early) receive(early);
          early = undefined;
        })
        .catch(() => {
          if (live) handlers.current.reject();
        });
    return () => {
      live = false;
      unsubscribe();
      const owner = session.current;
      session.current = undefined;
      if (owner) void window.canopy.handoffCancel(owner).catch(() => {});
    };
  }, [enabled]);
  useEffect(() => {
    if (
      !delivery ||
      delivery.session !== session.current ||
      delivery.id === lastId.current
    )
      return;
    lastId.current = delivery.id;
    let result: 'opened' | 'rejected' = 'rejected';
    try {
      if (delivery.expiresAt <= Date.now()) throw new Error('Expired command.');
      handlers.current.navigate(delivery.intent);
      result = 'opened';
    } catch {
      handlers.current.reject();
    }
    setDelivery(null);
    setCompleted({ delivery, result });
  }, [delivery]);
  useEffect(() => {
    if (!completed || completed.delivery.session !== session.current) return;
    const { delivery, result } = completed;
    setCompleted(null);
    void window.canopy
      .handoffAck(delivery.session, delivery.id, result)
      .catch(() => {
        if (session.current === delivery.session) handlers.current.reject();
      });
  }, [completed]);
}
