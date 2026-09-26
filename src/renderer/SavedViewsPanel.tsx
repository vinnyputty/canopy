import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import type {
  Connection,
  RootReference,
  SavedIssueView,
} from '../shared/types';
import type { ViewResult, ViewSource } from './saved-views';

type Props = {
  view: SavedIssueView;
  connections: Connection[];
  availableRoots: RootReference[];
  sources: ViewSource[];
  results: ViewResult[];
  selected: string | null;
  errors: Record<string, string>;
  identityErrors: Record<string, string>;
  loading: ReadonlySet<string>;
  onSelect: (identity: string) => void;
  onOpen: (result: ViewResult) => void;
  onChange: (view: SavedIssueView) => void;
  onDelete: () => void;
  onRefresh: () => void;
};

export function SavedViewsPanel(props: Props) {
  const { view, connections, availableRoots, sources, results } = props;
  const failedSources = sources.filter(
    (source) =>
      props.errors[source.id] || props.identityErrors[source.connectionId],
  ).length;
  const [nameDraft, setNameDraft] = React.useState(view.name);
  const [statusesDraft, setStatusesDraft] = React.useState(
    view.filters.statuses.join(', '),
  );
  React.useEffect(() => {
    setNameDraft(view.name);
    setStatusesDraft(view.filters.statuses.join(', '));
  }, [view.id]);
  const patch = (value: Partial<SavedIssueView>) =>
    props.onChange({ ...view, ...value });
  const filters = (value: Partial<SavedIssueView['filters']>) =>
    patch({ filters: { ...view.filters, ...value } });
  return (
    <section className="saved-view-page" aria-label={`${view.name} saved view`}>
      <header className="saved-view-header">
        <div>
          <h1>{view.name}</h1>
          <p>
            Issues across selected roots. Open a result in its original tree.
          </p>
        </div>
        <button onClick={props.onRefresh}>
          <RefreshCw size={15} /> Refresh
        </button>
      </header>
      <details className="saved-view-settings">
        <summary>Edit view</summary>
        <div className="saved-view-form">
          <label>
            Name{' '}
            <input
              aria-label="View name"
              value={nameDraft}
              maxLength={100}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={() =>
                nameDraft.trim()
                  ? patch({ name: nameDraft.trim() })
                  : setNameDraft(view.name)
              }
            />
          </label>
          <fieldset>
            <legend>Sources</legend>
            {connections.map((connection) => {
              const roots = availableRoots.filter(
                (root) => root.connectionId === connection.id,
              );
              return (
                <div key={connection.id} className="saved-source-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={view.connectionIds.includes(connection.id)}
                      onChange={(event) =>
                        patch({
                          connectionIds: event.target.checked
                            ? [...view.connectionIds, connection.id]
                            : view.connectionIds.filter(
                                (id) => id !== connection.id,
                              ),
                        })
                      }
                    />
                    All configured roots on {connection.name}
                  </label>
                  {roots.length ? (
                    roots.map((root) => (
                      <label key={root.rootKey}>
                        <input
                          type="checkbox"
                          checked={view.roots.some(
                            (item) =>
                              item.connectionId === root.connectionId &&
                              item.rootKey === root.rootKey,
                          )}
                          onChange={(event) =>
                            patch({
                              roots: event.target.checked
                                ? [...view.roots, root]
                                : view.roots.filter(
                                    (item) =>
                                      item.connectionId !== root.connectionId ||
                                      item.rootKey !== root.rootKey,
                                  ),
                            })
                          }
                        />
                        {root.rootKey} {root.summary ? `· ${root.summary}` : ''}
                      </label>
                    ))
                  ) : (
                    <small>
                      No configured roots on this connection. Open or pin a root
                      first.
                    </small>
                  )}
                </div>
              );
            })}
          </fieldset>
          <div className="saved-view-controls">
            <label>
              Assignee{' '}
              <select
                value={view.filters.assignee}
                onChange={(event) =>
                  filters({
                    assignee: event.target
                      .value as SavedIssueView['filters']['assignee'],
                  })
                }
              >
                <option value="any">Anyone</option>
                <option value="me">Assigned to me</option>
                <option value="unassigned">Unassigned</option>
              </select>
            </label>
            <label>
              Status names{' '}
              <input
                aria-label="Status names"
                value={statusesDraft}
                maxLength={5049}
                placeholder="Any status"
                onChange={(event) => setStatusesDraft(event.target.value)}
                onBlur={() =>
                  filters({
                    statuses: statusesDraft
                      .split(',')
                      .map((name) => name.trim().slice(0, 100))
                      .filter(Boolean)
                      .slice(0, 50),
                  })
                }
              />
              <small>Comma separated, exact names, case insensitive</small>
            </label>
            <label>
              Priority name{' '}
              <input
                value={view.filters.priority}
                maxLength={100}
                placeholder="Any priority"
                onChange={(event) => filters({ priority: event.target.value })}
              />
            </label>
            <label>
              Sort by{' '}
              <select
                value={view.sort.column}
                onChange={(event) =>
                  patch({
                    sort: {
                      ...view.sort,
                      column: event.target
                        .value as SavedIssueView['sort']['column'],
                    },
                  })
                }
              >
                {['key', 'summary', 'status', 'priority', 'assignee'].map(
                  (column) => (
                    <option key={column} value={column}>
                      {column}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label>
              Direction{' '}
              <select
                value={view.sort.direction}
                onChange={(event) =>
                  patch({
                    sort: {
                      ...view.sort,
                      direction: event.target.value as 'asc' | 'desc',
                    },
                  })
                }
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={view.filters.hideDone}
                onChange={(event) =>
                  filters({ hideDone: event.target.checked })
                }
              />{' '}
              Hide done
            </label>
          </div>
          <button className="text-button" onClick={props.onDelete}>
            Remove view
          </button>
        </div>
      </details>
      {!sources.length && (
        <p className="saved-view-notice">
          Choose at least one root or connection in Edit view. A connection
          includes its configured roots.
        </p>
      )}
      {view.connectionIds
        .filter(
          (id) => !availableRoots.some((root) => root.connectionId === id),
        )
        .map((id) => (
          <p className="saved-view-notice" key={id}>
            {connections.find((connection) => connection.id === id)?.name ?? id}{' '}
            has no configured roots.
          </p>
        ))}
      {sources.map((source) => {
        const connection = connections.find(
          (item) => item.id === source.connectionId,
        );
        const error =
          props.errors[source.id] ?? props.identityErrors[source.connectionId];
        return error ? (
          <div className="saved-view-error" role="alert" key={source.id}>
            <AlertCircle size={14} /> {connection?.name ?? source.connectionId}{' '}
            · {source.rootKey}: {error}
          </div>
        ) : null;
      })}
      <div
        className="saved-view-list"
        role="listbox"
        aria-label={`${view.name} results`}
      >
        {results.map((result) => {
          const connection = connections.find(
            (item) => item.id === result.source.connectionId,
          );
          const identity = JSON.stringify([
            result.source.connectionId,
            result.issue.id,
          ]);
          return (
            <button
              key={identity}
              role="option"
              aria-selected={identity === props.selected}
              className={identity === props.selected ? 'selected' : ''}
              onClick={() => props.onSelect(identity)}
              onDoubleClick={() => props.onOpen(result)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') props.onOpen(result);
              }}
            >
              <strong>{result.issue.key}</strong>
              <span>{result.issue.summary}</span>
              <small>
                {connection?.provider ?? 'Unknown provider'} ·{' '}
                {connection?.name ?? result.source.connectionId} ·{' '}
                {result.source.rootKey} · {result.issue.status.name}
              </small>
              <span
                className="saved-view-open"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onOpen(result);
                }}
              >
                Open in tree
              </span>
            </button>
          );
        })}
        {!results.length && sources.length > 0 && (
          <p className="saved-view-notice">
            {sources.some((source) => props.loading.has(source.id))
              ? 'Loading issues…'
              : failedSources === sources.length
                ? 'Couldn’t load issues from any selected root. Review the errors above and retry.'
                : failedSources > 0
                  ? 'No matching issues from the available roots. Some roots could not be loaded.'
                  : 'No matching issues.'}
          </p>
        )}
      </div>
    </section>
  );
}
