import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  Connection,
  Issue,
  TreeSnapshot,
  Workspace,
} from '../shared/types';
import {
  changeTriage,
  emptyTriage,
  triageIdentity,
  type TriageAction,
} from '../shared/triage';
import type { ViewSource } from './saved-views';
import {
  inboxCandidates,
  inboxItems,
  InboxInspection,
  type InboxGraph,
} from './inbox';

type Props = {
  workspace: Workspace;
  seedGraphs?: Record<string, InboxGraph>;
  inspection: InboxInspection;
  graphs: Record<string, InboxGraph>;
  busy: boolean;
  connections: Connection[];
  sources: ViewSource[];
  totalRoots: number;
  snapshots: Record<string, TreeSnapshot>;
  errors: Record<string, string>;
  identityErrors: Record<string, string>;
  users: Record<string, { id: string }>;
  loading: ReadonlySet<string>;
  now: number;
  onChange: (update: (workspace: Workspace) => Workspace) => void;
  onSeen: (issue: Issue, source: ViewSource) => void;
  onOpen: (result: { issue: Issue; source: ViewSource }) => void;
  onRefresh: () => void;
  onMoreRoots: () => void;
};
export function InboxPanel(props: Props) {
  const candidates = useMemo(
    () => inboxCandidates(props.sources, props.snapshots, props.connections),
    [props.sources, props.snapshots, props.connections],
  );
  // Presentation-only changes must not cancel reads of the same confirmed data.
  const candidateKey = useMemo(
    () =>
      JSON.stringify(
        candidates
          .map((candidate) => [
            candidate.source.connectionId,
            candidate.issue.key,
            candidate.stamp,
          ])
          .sort(),
      ),
    [candidates],
  );
  const { inspection, graphs, busy } = props;
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [reasonFilter, setReasonFilter] = useState('');
  const filterControl = useRef<HTMLSelectElement>(null);
  const actionControl = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (actionControl.current && !actionControl.current.isConnected) {
      if (document.activeElement === document.body)
        filterControl.current?.focus();
    }
    actionControl.current = null;
  });
  const initialInspection = useRef(false);
  useEffect(() => {
    inspection.reset(candidates, props.seedGraphs);
  }, [inspection, candidateKey]);
  useEffect(() => () => inspection.cancel(), [inspection]);
  useEffect(() => {
    let live = true;
    queueMicrotask(() => {
      if (
        live &&
        !initialInspection.current &&
        candidates.length &&
        !props.loading.size
      ) {
        initialInspection.current = true;
        void inspection.load(candidates);
      }
    });
    return () => {
      live = false;
    };
  }, [inspection, candidateKey, props.loading.size]);
  const items = inboxItems(
    candidates,
    props.workspace,
    props.connections,
    props.snapshots,
    props.users,
    graphs,
    props.now,
  );
  const uninspected = candidates.filter(
    (candidate) =>
      candidate.issue.status.category !== 'done' &&
      graphs[triageIdentity(candidate.source.connectionId, candidate.issue.key)]
        ?.stamp !== candidate.stamp,
  ).length;
  const action = (
    connectionId: string,
    issueKey: string,
    action: TriageAction,
    duration = 0,
  ) => {
    actionControl.current = document.activeElement as HTMLElement;
    props.onChange((workspace) => ({
      ...workspace,
      triage: changeTriage(
        workspace.triage,
        connectionId,
        issueKey,
        action,
        Date.now(),
        duration,
      ),
    }));
  };
  const visibleItems = items.filter(
    (item) =>
      (showSnoozed || !item.snoozedUntil) &&
      (!reasonFilter ||
        item.reasons.some((reason) => reason.startsWith(reasonFilter))),
  );
  const loadingSources = props.sources.filter((source) =>
    props.loading.has(source.id),
  ).length;
  const incomplete =
    props.sources.length < props.totalRoots ||
    uninspected > 0 ||
    props.sources.some(
      (source) =>
        !props.snapshots[source.id] ||
        props.errors[source.id] ||
        props.identityErrors[source.connectionId] ||
        !props.users[source.connectionId] ||
        props.snapshots[source.id]?.warnings?.length,
    ) ||
    Object.values(graphs).some(
      (entry) =>
        entry.error ||
        !entry.graph?.groups.some(
          (group) =>
            group.kind === 'blockers' &&
            group.state === 'visible' &&
            group.items.every((item) => item.statusCategory !== undefined),
        ),
    );
  const statuses = (connection: Connection) =>
    [
      ...new Set([
        ...(props.workspace.triage?.reviewStatuses[connection.id] ?? []),
        ...candidates
          .filter(
            (item) =>
              item.source.connectionId === connection.id &&
              !item.issue.unavailableFields?.includes('status'),
          )
          .map((item) => item.issue.status.name),
        ...(props.workspace.savedViews ?? [])
          .filter(
            (view) =>
              view.connectionIds.includes(connection.id) ||
              view.roots.some((root) => root.connectionId === connection.id),
          )
          .flatMap((view) => view.filters.statuses),
      ]),
    ].sort();
  return (
    <section className="saved-view-page triage-inbox" aria-label="Triage inbox">
      <header className="saved-view-header">
        <div>
          <h1>Triage inbox</h1>
          <p>
            Unread changes, assigned work, confirmed blockers and your review
            statuses across known workspace roots.
          </p>
        </div>
        <button onClick={props.onRefresh}>
          Refresh / Retry roots and accounts
        </button>
      </header>
      <div className="inbox-overview" role="status">
        <strong>{visibleItems.length} items needing attention</strong>
        <span>
          {loadingSources
            ? `Refreshing ${loadingSources} roots…`
            : incomplete
              ? 'Coverage incomplete · review sources below'
              : 'Loaded roots checked'}{' '}
          · {props.sources.length} of {props.totalRoots} roots selected
        </span>
      </div>
      <details className="inbox-source-details">
        <summary>Sources and coverage</summary>
        <p>
          Coverage: {props.sources.length} of {props.totalRoots} known roots
          selected;{' '}
          {props.sources.filter((source) => props.snapshots[source.id]).length}{' '}
          confirmed snapshots. {candidates.length} returned issues;{' '}
          {uninspected} unfinished issues await blocker inspection. Manual tree
          refreshes and confirmed data changes invalidate affected inspections;
          unchanged background fetches preserve them. Inspect again for current
          blocker coverage. Provider visibility and tree limits apply. This
          inbox cannot establish global absence of work.
        </p>
        {props.connections
          .filter(
            (connection) =>
              !props.sources.some(
                (source) => source.connectionId === connection.id,
              ),
          )
          .map((connection) => (
            <p key={connection.id}>
              {connection.name} · {connection.id}: no selected known root. Load
              more roots or open a root/configure a repository to include this
              connection.
            </p>
          ))}
        {props.sources.length < props.totalRoots && (
          <button onClick={props.onMoreRoots}>Load 10 more roots</button>
        )}
        <ul className="inbox-coverage">
          {props.sources.map((source) => (
            <li key={source.id}>
              <strong>
                {props.connections.find(
                  (connection) => connection.id === source.connectionId,
                )?.name ?? source.connectionId}{' '}
                · {source.connectionId} · {source.rootKey}
              </strong>
              {props.loading.has(source.id)
                ? ' — Refreshing'
                : !props.snapshots[source.id]
                  ? ' — Not confirmed'
                  : ' — Last confirmed fetch ' +
                    new Date(
                      props.snapshots[source.id].fetchedAt,
                    ).toLocaleString()}
              {props.errors[source.id] && (
                <span role="alert">
                  {' '}
                  — Root unavailable: {props.errors[source.id]}{' '}
                  {props.snapshots[source.id]
                    ? '(successful snapshot retained)'
                    : '(no confirmed snapshot)'}
                </span>
              )}
              {!props.users[source.connectionId] &&
                !props.identityErrors[source.connectionId] && (
                  <span> — Assigned work unknown: account lookup pending</span>
                )}
              {props.identityErrors[source.connectionId] && (
                <span role="alert">
                  {' '}
                  — Assigned work unknown:{' '}
                  {props.identityErrors[source.connectionId]}
                </span>
              )}
              {(props.snapshots[source.id]?.warnings ?? []).map(
                (warning, index) => (
                  <p key={index}>Partial tree: {warning}</p>
                ),
              )}
            </li>
          ))}
        </ul>
        {Object.entries(graphs).flatMap(([id, entry]) => {
          const [connectionId, key] = JSON.parse(id);
          const group = entry.graph?.groups.find(
            (group) => group.kind === 'blockers',
          );
          const unknownStatus = group?.items.some(
            (item) => item.statusCategory === undefined,
          );
          return entry.error || group?.state !== 'visible' || unknownStatus
            ? [
                <p key={id} role="status">
                  {connectionId} · {key}:{' '}
                  {entry.error ??
                    group?.reason ??
                    (unknownStatus
                      ? 'Blocker target status unknown'
                      : 'Blocker coverage incomplete')}
                  . Retry blockers to inspect again.
                </p>,
              ]
            : [];
        })}
      </details>
      <div className="inbox-inspection-actions">
        <button
          disabled={busy || !uninspected}
          onClick={() => void inspection.load(candidates)}
        >
          Inspect next 20 issues ({uninspected} remaining)
        </button>{' '}
        <button
          disabled={busy}
          onClick={() => void inspection.load(candidates, true)}
        >
          Retry partial / failed blockers
        </button>{' '}
        {busy && (
          <button
            onClick={() => {
              inspection.cancel();
            }}
          >
            Cancel blocker inspection
          </button>
        )}
        {busy && (
          <p role="status">
            Inspecting blockers… successful results remain available.
          </p>
        )}
      </div>
      <details className="saved-view-settings">
        <summary>Review statuses and local history</summary>
        <p>
          Select provider status names. Saved-view status selections are offered
          as choices. These choices apply only to their connection.
        </p>
        {props.connections.map((connection) => (
          <fieldset key={connection.id}>
            <legend>
              {connection.name} · {connection.accountName ?? connection.id}
            </legend>
            {statuses(connection).map((status) => (
              <label key={status}>
                <input
                  type="checkbox"
                  checked={
                    props.workspace.triage?.reviewStatuses[
                      connection.id
                    ]?.includes(status) ?? false
                  }
                  onChange={(event) => {
                    const checked = event.target.checked;
                    props.onChange((workspace) => {
                      const triage = workspace.triage ?? emptyTriage();
                      const old = triage.reviewStatuses[connection.id] ?? [];
                      return {
                        ...workspace,
                        triage: {
                          ...triage,
                          reviewStatuses: {
                            ...triage.reviewStatuses,
                            [connection.id]: checked
                              ? [...new Set([...old, status])].slice(0, 50)
                              : old.filter((item) => item !== status),
                          },
                        },
                      };
                    });
                  }}
                />
                {status}
              </label>
            ))}
            {!statuses(connection).length && (
              <p>No confirmed statuses loaded yet.</p>
            )}
          </fieldset>
        ))}
        <p>
          Pins and snoozes save locally with the workspace. Snooze hides even
          pinned items until expiry. Preferences retain at most 500 items;
          action history retains at most 100 entries for 90 days. History
          contains identifiers and action times, and may be private.
        </p>
        <button
          onClick={() =>
            props.onChange((workspace) => ({
              ...workspace,
              triage: { ...(workspace.triage ?? emptyTriage()), history: [] },
            }))
          }
        >
          Clear local triage history
        </button>
        <ol>
          {(props.workspace.triage?.history ?? [])
            .filter((item) => item.at >= props.now - 90 * 24 * 60 * 60 * 1000)
            .slice()
            .reverse()
            .map((item, index) => (
              <li key={index}>
                {item.connectionId} · {item.issueKey} · {item.action} ·{' '}
                {new Date(item.at).toLocaleString()}
              </li>
            ))}
        </ol>
      </details>
      {props.errors.workspace && (
        <p role="alert">Workspace save failed: {props.errors.workspace}</p>
      )}
      <div className="inbox-filters">
        <label>
          Show
          <select
            ref={filterControl}
            value={reasonFilter}
            onChange={(event) => setReasonFilter(event.target.value)}
          >
            <option value="">All attention items</option>
            <option value="Unread changes">Unread changes</option>
            <option value="Assigned to you">Assigned to you</option>
            <option value="Blocked by">Blockers</option>
            <option value="Review:">Review work</option>
            <option value="Pinned locally">Pinned</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={showSnoozed}
            onChange={(event) => setShowSnoozed(event.target.checked)}
          />
          Show snoozed items ({items.filter((item) => item.snoozedUntil).length}
          )
        </label>
      </div>
      <div className="inbox-items">
        {visibleItems.map((item) => {
          const connection = props.connections.find(
            (connection) => connection.id === item.source.connectionId,
          );
          const provider =
            connection?.provider === 'github'
              ? 'GitHub'
              : connection?.provider === 'jira'
                ? 'Jira'
                : connection?.provider === 'demo'
                  ? 'Demo'
                  : 'Unknown provider';
          return (
            <article
              className="inbox-item"
              key={triageIdentity(item.source.connectionId, item.issue.key)}
            >
              <button className="inbox-open" onClick={() => props.onOpen(item)}>
                {item.issue.key} {item.issue.summary}
              </button>
              <p>
                {item.reasons.map((reason) => (
                  <span className="inbox-reason" key={reason}>
                    {reason}
                  </span>
                ))}
                {item.blockerUnknown &&
                  ' · Blocker coverage unknown / incomplete'}
              </p>
              <p className="inbox-source">
                {provider} · {connection?.name ?? item.source.connectionId} ·{' '}
                {item.source.connectionId} · roots:{' '}
                {item.roots.map((root) => root.rootKey).join(', ')}
              </p>
              <p className="inbox-timestamp">
                Last confirmed update:{' '}
                {item.issue.updated &&
                Number.isFinite(Date.parse(item.issue.updated))
                  ? new Date(item.issue.updated).toLocaleString()
                  : 'Unavailable'}{' '}
                · confirmed fetch {new Date(item.fetchedAt).toLocaleString()}
              </p>
              <div className="inbox-actions">
                <button
                  onClick={() => {
                    for (const root of item.roots)
                      props.onSeen(item.issue, root);
                    action(item.source.connectionId, item.issue.key, 'seen');
                  }}
                >
                  Mark seen
                </button>{' '}
                <button
                  onClick={() =>
                    action(
                      item.source.connectionId,
                      item.issue.key,
                      item.pinned ? 'unpin' : 'pin',
                    )
                  }
                >
                  {item.pinned ? 'Unpin' : 'Pin'}
                </button>{' '}
                {item.snoozedUntil ? (
                  <>
                    <span>
                      Snoozed until{' '}
                      {new Date(item.snoozedUntil).toLocaleString()}{' '}
                    </span>
                    <button
                      onClick={() =>
                        action(item.source.connectionId, item.issue.key, 'wake')
                      }
                    >
                      Wake now
                    </button>
                  </>
                ) : (
                  <select
                    aria-label={`Snooze ${item.issue.key}`}
                    value=""
                    onChange={(event) =>
                      action(
                        item.source.connectionId,
                        item.issue.key,
                        'snooze',
                        Number(event.target.value),
                      )
                    }
                  >
                    <option value="" disabled>
                      Snooze…
                    </option>
                    <option value={60 * 60 * 1000}>1 hour</option>
                    <option value={24 * 60 * 60 * 1000}>24 hours</option>
                    <option value={7 * 24 * 60 * 60 * 1000}>7 days</option>
                  </select>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {!visibleItems.length && (
        <div className="inbox-empty" role="status">
          <strong>
            {!props.sources.length
              ? 'Choose roots for your inbox'
              : loadingSources
                ? 'Loading your inbox…'
                : reasonFilter || items.length
                  ? 'No items match these filters'
                  : incomplete
                    ? 'No attention items in available data'
                    : 'You’re caught up in loaded roots'}
          </strong>
          <p>
            {!props.sources.length
              ? 'Open a root or configure a repository to include its issues here.'
              : loadingSources
                ? 'Confirmed items appear as roots finish loading.'
                : reasonFilter || items.length
                  ? 'Choose All attention items or show snoozed items to broaden the list.'
                  : incomplete
                    ? 'Review Sources and coverage, then retry unavailable roots or inspect remaining blockers.'
                    : 'Refresh to check for new changes. Only known, selected roots are included.'}
          </p>
        </div>
      )}
    </section>
  );
}
