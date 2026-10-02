import React, { useLayoutEffect, useRef } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Pause,
  Pin,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react';
import type { Connection, RootReference, Workspace } from '../shared/types';
import { sameRoot } from './workspace';
import {
  captureSidebar,
  restoreSidebar,
  rootIdentity,
  sidebarRoots,
  type OrganizationAction,
  type SidebarPosition,
  type SidebarSession,
} from './sidebar-organization';

export function SidebarWork({
  workspace,
  connections,
  session,
  onOrganize,
  onOpen,
  onSelectTab,
  onSelectView,
  onCreateView,
  onOpenPicker,
}: {
  workspace: Workspace;
  connections: Connection[];
  session: SidebarSession;
  onOrganize: (action: OrganizationAction) => void;
  onOpen: (root: RootReference) => void;
  onSelectTab: (id: string) => void;
  onSelectView: (id: string) => void;
  onCreateView: () => void;
  onOpenPicker: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const pendingPosition = useRef<SidebarPosition | null>(null);
  const scroll = useRef(0);
  useLayoutEffect(() => {
    const body = container.current?.closest<HTMLElement>('.sidebar-body');
    if (!body) return;
    if (pendingPosition.current) {
      restoreSidebar(body, pendingPosition.current);
      pendingPosition.current = null;
    } else body.scrollTop = scroll.current;
    scroll.current = body.scrollTop;
  });
  React.useEffect(() => {
    const body = container.current?.closest<HTMLElement>('.sidebar-body');
    if (!body) return;
    const remember = () => {
      scroll.current = body.scrollTop;
    };
    body.addEventListener('scroll', remember);
    return () => body.removeEventListener('scroll', remember);
  }, []);
  const organize = (action: OrganizationAction) => {
    const body = container.current?.closest<HTMLElement>('.sidebar-body');
    if (body) pendingPosition.current = captureSidebar(body);
    onOrganize(action);
  };
  const roots = sidebarRoots(workspace, session);
  const active = workspace.tabs.find((tab) => tab.id === workspace.activeTabId);
  const context = (root: RootReference) => {
    const connection = connections.find(
      (item) => item.id === root.connectionId,
    );
    return connection
      ? `${connection.provider === 'github' ? 'GitHub' : 'Jira'} · ${connection.name}`
      : 'Unavailable connection';
  };
  const heading = (name: string, count: number, action?: React.ReactNode) => (
    <div className="side-heading">
      <h2>
        {name}{' '}
        <span className="side-count" aria-label={`${count} items`}>
          {count}
        </span>
      </h2>
      {action}
    </div>
  );
  const rootRow = (
    root: RootReference,
    section: 'active' | 'pinned' | 'recent' | 'parked',
    index: number,
  ) => {
    const identity = rootIdentity(root);
    const pinned = workspace.pinnedRoots?.some((item) => sameRoot(item, root));
    const selected =
      !workspace.activeSavedViewId && active && sameRoot(active, root);
    const name = `${root.rootKey} · ${context(root)}`;
    const attributes = (action: string) => ({
      'data-sidebar-focus': `${section}:${identity}:${action}`,
      'data-sidebar-root': identity,
    });
    const button = (
      label: string,
      action: OrganizationAction,
      icon: React.ReactNode,
      disabled = false,
    ) => (
      <button
        className="icon-button"
        {...attributes(
          action.type === 'move' ? `move:${action.direction}` : action.type,
        )}
        aria-label={`${label} ${name}`}
        title={`${label} ${name}`}
        disabled={disabled}
        onClick={() => organize(action)}
      >
        {icon}
      </button>
    );

    return (
      <li className="sidebar-root" key={identity}>
        <button
          className={`side-tab ${selected ? 'active' : ''}`}
          {...attributes('open')}
          aria-current={selected ? 'page' : undefined}
          aria-label={`Open ${name}${root.summary ? `: ${root.summary}` : ''}`}
          title={`${root.rootKey}: ${root.summary ?? ''} · ${connections.find((item) => item.id === root.connectionId)?.name ?? 'Unavailable connection'}`}
          onClick={() =>
            section === 'active'
              ? onSelectTab(roots.active[index].id)
              : onOpen(root)
          }
        >
          <span>
            <b>{root.rootKey}</b>
            <small>{root.summary ?? root.rootKey}</small>
            <small className="root-context">{context(root)}</small>
          </span>
        </button>
        <div className="sidebar-root-actions">
          {section === 'parked' ? (
            button(
              'Restore to sidebar',
              { type: 'restore', root },
              <RotateCcw size={13} />,
            )
          ) : (
            <>
              {button(
                pinned ? 'Unpin' : 'Pin',
                { type: 'pin', root },
                pinned ? <X size={13} /> : <Pin size={13} />,
              )}
              {button(
                'Park for this session',
                { type: 'park', root },
                <Pause size={13} />,
              )}
              {section === 'pinned' && (
                <>
                  {button(
                    'Move favorite up',
                    { type: 'move', root, direction: -1 },
                    <ArrowUp size={13} />,
                    index === 0,
                  )}
                  {button(
                    'Move favorite down',
                    { type: 'move', root, direction: 1 },
                    <ArrowDown size={13} />,
                    index === roots.pinned.length - 1,
                  )}
                </>
              )}
            </>
          )}
        </div>
      </li>
    );
  };
  return (
    <div ref={container} className="sidebar-work">
      <div className="sidebar-organization">
        <button
          className="secondary"
          data-sidebar-focus="undo"
          disabled={!session.undo.length}
          aria-label={
            session.undo.length
              ? `Undo ${session.undo.at(-1)!.label}`
              : 'Undo sidebar organization'
          }
          onClick={() => organize({ type: 'undo' })}
        >
          Undo
        </button>
        <span role="status" className="sr-only">
          {session.announcement}
        </span>
      </div>
      {heading(
        'ACTIVE TABS',
        roots.active.length,
        <button
          className="icon-button"
          aria-label="Open issue"
          onClick={onOpenPicker}
        >
          <Plus size={15} />
        </button>,
      )}
      <nav aria-label="Active tabs">
        <ul className="side-tabs">
          {roots.active.map((root, index) => rootRow(root, 'active', index))}
        </ul>
        {!roots.active.length && (
          <p className="sidebar-empty">No active roots in the sidebar.</p>
        )}
      </nav>
      {heading('PINNED ROOTS', roots.pinned.length)}
      <nav aria-label="Pinned roots">
        <ul className="side-tabs">
          {roots.pinned.map((root, index) => rootRow(root, 'pinned', index))}
        </ul>
      </nav>
      {heading(
        'SAVED VIEWS',
        workspace.savedViews?.length ?? 0,
        <button
          className="icon-button"
          aria-label="Create saved view"
          onClick={onCreateView}
        >
          <Plus size={15} />
        </button>,
      )}
      <nav aria-label="Saved views">
        <ul className="side-tabs">
          {(workspace.savedViews ?? []).map((view) => {
            const ids = new Set([
              ...view.connectionIds,
              ...view.roots.map((root) => root.connectionId),
            ]);
            const description =
              [...ids]
                .map((id) => context({ connectionId: id, rootKey: '' }))
                .join(', ') || 'Choose sources in Edit view';
            return (
              <li key={view.id}>
                <button
                  className={`side-tab ${view.id === workspace.activeSavedViewId ? 'active' : ''}`}
                  aria-current={
                    view.id === workspace.activeSavedViewId ? 'page' : undefined
                  }
                  aria-label={`Saved view: ${view.name}`}
                  aria-describedby={`sidebar-view-context-${view.id}`}
                  title={`${view.name} · ${description}`}
                  onClick={() => onSelectView(view.id)}
                >
                  <span>
                    <b>{view.name}</b>
                    <small id={`sidebar-view-context-${view.id}`}>
                      {description}
                    </small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      {heading('RECENT ROOTS', roots.recent.length)}
      <nav aria-label="Recent roots">
        <ul className="side-tabs">
          {roots.recent.map((root, index) => rootRow(root, 'recent', index))}
        </ul>
      </nav>
      {heading('PARKED ROOTS', roots.parked.length)}
      <p className="sidebar-empty">
        Parking lasts until restart. Tabs stay open; saved views keep their
        roots.
      </p>
      <nav aria-label="Parked roots">
        <ul className="side-tabs">
          {roots.parked.map((root, index) => rootRow(root, 'parked', index))}
        </ul>
      </nav>
    </div>
  );
}
