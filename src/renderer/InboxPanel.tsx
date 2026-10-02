import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  onGraphs?: (entries: Record<string, InboxGraph>) => void;
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
  const [graphs, setGraphs] = useState<Record<string, InboxGraph>>({});
  const [busy, setBusy] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [inspection] = useState(
    () =>
      new InboxInspection(window.canopy, (graphs, busy) => {
        setGraphs(graphs);
        setBusy(busy);
        props.onGraphs?.(graphs);
      }),
  );
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
  ) =>
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
      <p>
        Coverage: {props.sources.length} of {props.totalRoots} known roots
        selected;{' '}
        {props.sources.filter((source) => props.snapshots[source.id]).length}{' '}
        confirmed snapshots. {candidates.length} returned issues; {uninspected}{' '}
        unfinished issues await blocker inspection. Refreshing a tree
        invalidates its inspected blockers; inspect again for current blocker
        coverage. Provider visibility and tree limits apply. This inbox cannot
        establish global absence of work.
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
            setBusy(false);
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
      <label>
        <input
          type="checkbox"
          checked={showSnoozed}
          onChange={(event) => setShowSnoozed(event.target.checked)}
        />
        Show snoozed items ({items.filter((item) => item.snoozedUntil).length})
      </label>
      <div className="inbox-items">
        {items
          .filter((item) => showSnoozed || !item.snoozedUntil)
          .map((item) => (
            <article
              className="inbox-item"
              key={triageIdentity(item.source.connectionId, item.issue.key)}
            >
              <button className="inbox-open" onClick={() => props.onOpen(item)}>
                {item.issue.key} {item.issue.summary}
              </button>
              <p>
                {item.reasons.join(' · ')}
                {item.blockerUnknown &&
                  ' · Blocker coverage unknown / incomplete'}
              </p>
              <p>
                {
                  props.connections.find(
                    (connection) => connection.id === item.source.connectionId,
                  )?.provider
                }{' '}
                ·{' '}
                {
                  props.connections.find(
                    (connection) => connection.id === item.source.connectionId,
                  )?.name
                }{' '}
                · {item.source.connectionId} · roots:{' '}
                {item.roots.map((root) => root.rootKey).join(', ')}
              </p>
              <p>
                Last confirmed update:{' '}
                {item.issue.updated &&
                Number.isFinite(Date.parse(item.issue.updated))
                  ? new Date(item.issue.updated).toLocaleString()
                  : 'Unavailable'}{' '}
                · confirmed fetch {new Date(item.fetchedAt).toLocaleString()}
              </p>
              <button
                onClick={() => {
                  for (const root of item.roots) props.onSeen(item.issue, root);
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
            </article>
          ))}
      </div>
      {!items.some((item) => showSnoozed || !item.snoozedUntil) && (
        <p>
          No matching items in confirmed loaded data. Unloaded roots,
          uninspected blockers and failures may still contain work.
        </p>
      )}
    </section>
  );
}
