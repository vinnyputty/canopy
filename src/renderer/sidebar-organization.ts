import type { RootReference, Workspace } from '../shared/types';
import { sameRoot, togglePinned } from './workspace';

export const rootIdentity = (root: RootReference) =>
  JSON.stringify([root.connectionId, root.rootKey]);

export type OrganizationAction =
  | { type: 'pin' | 'park' | 'restore'; root: RootReference }
  | { type: 'move'; root: RootReference; direction: -1 | 1 }
  | { type: 'undo' };
type Undo = {
  label: string;
  pinned?: RootReference[];
  parked?: RootReference[];
};
export type SidebarSession = {
  parked: RootReference[];
  undo: Undo[];
  announcement: string;
};
export const emptySidebarSession = (): SidebarSession => ({
  parked: [],
  undo: [],
  announcement: '',
});

// Organization only touches favorites and session visibility. Tab snapshots,
// root overrides, saved views, recents, and navigation remain live during Undo.
export function organizeSidebar(
  workspace: Workspace,
  session: SidebarSession,
  action: OrganizationAction,
  connectionName?: string,
): { workspace: Workspace; session: SidebarSession } {
  if (action.type === 'undo') {
    const previous = session.undo.at(-1);
    if (!previous) return { workspace, session };
    return {
      workspace: previous.pinned
        ? {
            ...workspace,
            pinnedRoots: previous.pinned.map((root) => {
              const latest = [
                ...(workspace.pinnedRoots ?? []),
                ...workspace.tabs,
                ...(workspace.recentRoots ?? []),
              ].find((item) => sameRoot(item, root));
              return latest
                ? { ...root, summary: latest.summary ?? root.summary }
                : root;
            }),
          }
        : workspace,
      session: {
        ...session,
        parked: previous.parked ?? session.parked,
        undo: session.undo.slice(0, -1),
        announcement: `Undid ${previous.label}.`,
      },
    };
  }
  let next = workspace;
  let parked = session.parked;
  let previous: Undo;
  const key = action.root.rootKey;
  const label = `${key} · ${connectionName ?? action.root.connectionId}`;
  if (action.type === 'pin') {
    const pinned = workspace.pinnedRoots ?? [];
    previous = {
      label: `${pinned.some((root) => sameRoot(root, action.root)) ? 'unpin' : 'pin'} ${label}`,
      pinned,
    };
    next = togglePinned(workspace, action.root);
  } else if (action.type === 'move') {
    const pinned = [...(workspace.pinnedRoots ?? [])];
    const from = pinned.findIndex((root) => sameRoot(root, action.root));
    let to = from + action.direction;
    while (
      to >= 0 &&
      to < pinned.length &&
      session.parked.some((root) => sameRoot(root, pinned[to]))
    )
      to += action.direction;
    if (from < 0 || to < 0 || to >= pinned.length)
      return { workspace, session };
    [pinned[from], pinned[to]] = [pinned[to], pinned[from]];
    previous = {
      label: `move ${label} ${action.direction === -1 ? 'up' : 'down'}`,
      pinned: workspace.pinnedRoots ?? [],
    };
    next = { ...workspace, pinnedRoots: pinned };
  } else {
    const exists = parked.some((root) => sameRoot(root, action.root));
    if (exists === (action.type === 'park')) return { workspace, session };
    previous = { label: `${action.type} ${label}`, parked };
    parked =
      action.type === 'park'
        ? [
            ...parked,
            {
              connectionId: action.root.connectionId,
              rootKey: key,
              summary: action.root.summary,
            },
          ]
        : parked.filter((root) => !sameRoot(root, action.root));
  }
  return {
    workspace: next,
    session: {
      parked,
      undo: [...session.undo, previous].slice(-20),
      announcement: `${previous.label}.`,
    },
  };
}

export function sidebarRoots(workspace: Workspace, session: SidebarSession) {
  const visible = (root: RootReference) =>
    !session.parked.some((item) => sameRoot(item, root));
  return {
    active: workspace.tabs.filter(visible),
    pinned: (workspace.pinnedRoots ?? []).filter(visible),
    recent: (workspace.recentRoots ?? []).filter(visible),
    parked: session.parked.map(
      (root) =>
        [
          ...workspace.tabs,
          ...(workspace.pinnedRoots ?? []),
          ...(workspace.recentRoots ?? []),
        ].find((item) => sameRoot(item, root)) ?? root,
    ),
  };
}

export type SidebarPosition = {
  scrollTop: number;
  focus?: string;
  root?: string;
};
export function captureSidebar(element: HTMLElement): SidebarPosition {
  const focused = element.ownerDocument.activeElement as HTMLElement | null;
  return {
    scrollTop: element.scrollTop,
    ...(focused && element.contains(focused)
      ? {
          focus: focused.dataset.sidebarFocus,
          root: focused.dataset.sidebarRoot,
        }
      : {}),
  };
}
export function restoreSidebar(
  element: HTMLElement,
  position: SidebarPosition,
) {
  if (position.focus) {
    const buttons = [
      ...element.querySelectorAll<HTMLButtonElement>(
        'button[data-sidebar-focus]',
      ),
    ];
    const target =
      buttons.find(
        (button) =>
          button.dataset.sidebarFocus === position.focus && !button.disabled,
      ) ??
      buttons.find(
        (button) =>
          button.dataset.sidebarRoot === position.root &&
          button.dataset.sidebarFocus?.startsWith(
            `${position.focus!.split(':')[0]}:`,
          ) &&
          !button.disabled,
      ) ??
      buttons.find(
        (button) =>
          button.dataset.sidebarRoot === position.root && !button.disabled,
      ) ??
      buttons.find((button) => !button.disabled);
    target?.focus({ preventScroll: true });
  }
  element.scrollTop = position.scrollTop;
}

export function forgetSidebarConnections(
  session: SidebarSession,
  ids: string[],
): SidebarSession {
  if (!ids.length) return session;
  return {
    ...emptySidebarSession(),
    parked: session.parked.filter((root) => !ids.includes(root.connectionId)),
  };
}
