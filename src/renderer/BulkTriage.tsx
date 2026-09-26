import React, { useEffect, useRef, useState } from 'react';
import type { CanopyAPI, Choice, Connection, Issue } from '../shared/types';
import {
  bulkChoices,
  executeBulkIssue,
  planBulk,
  type BulkAction,
  type BulkCandidate,
  type BulkChoice,
  type BulkResult,
} from './bulk-triage';

export type BulkOperation = {
  action: BulkAction;
  choice: BulkChoice | null;
  results: BulkResult[];
  working: boolean;
};
type ChangeOperation = (
  change: (current: BulkOperation | null) => BulkOperation | null,
) => void;

export function BulkTriage({
  api,
  connection,
  issues,
  currentUser,
  update,
  undo,
  canUndo,
  onClear,
  operation,
  onOperation,
  copy,
}: {
  api: CanopyAPI;
  connection: Connection;
  issues: Issue[];
  currentUser?: Choice;
  update: (
    key: string,
    patch: NonNullable<BulkCandidate['patch']>,
    choice: BulkChoice | null,
  ) => Promise<boolean>;
  undo: (key: string) => Promise<boolean>;
  canUndo: (key: string) => boolean;
  onClear: () => void;
  operation: BulkOperation | null;
  onOperation: ChangeOperation;
  copy: (issues: Issue[]) => Promise<boolean>;
}) {
  const [action, setAction] = useState<BulkAction>('assignee');
  const [choices, setChoices] = useState<BulkChoice[]>([]);
  const [chosen, setChosen] = useState<string>('');
  const [query, setQuery] = useState('');
  const [nextStartAt, setNextStartAt] = useState<number>();
  const searchSequence = useRef(0);
  const applying = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<BulkCandidate[] | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<'copied' | 'failed' | null>(
    null,
  );
  const working = operation?.working ?? false;
  const selectionId = issues.map((issue) => issue.key).join('\n');
  const available = choices.find((value) => value.id === chosen) ?? null;
  const initialUsers = [
    currentUser,
    ...issues.map((issue) => issue.assignee),
  ].filter((value): value is Choice => Boolean(value));
  useEffect(() => {
    let live = true;
    setChosen('');
    setPreview(null);
    setError('');
    setNextStartAt(undefined);
    searchSequence.current += 1;
    if (action === 'assignee') {
      setChoices([
        ...new Map(initialUsers.map((value) => [value.id, value])).values(),
      ]);
      return;
    }
    setLoading(true);
    void bulkChoices(api, connection, issues, action)
      .then((values) => {
        if (live) {
          setChoices(values);
          setLoading(false);
        }
      })
      .catch((failure) => {
        if (live) {
          setError(String(failure));
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [action, api, connection.id, selectionId]);
  const search = async (more = false) => {
    const sequence = ++searchSequence.current;
    setLoading(true);
    setError('');
    try {
      const page = await api.assignees(
        connection.id,
        issues[0].key,
        query,
        more ? nextStartAt : 0,
      );
      if (sequence !== searchSequence.current) return;
      setNextStartAt(page.nextStartAt);
      setChoices((current) => [
        ...new Map(
          [...(more ? current : initialUsers), ...page.users].map((value) => [
            value.id,
            value,
          ]),
        ).values(),
      ]);
    } catch (failure) {
      if (sequence === searchSequence.current) setError(String(failure));
    } finally {
      if (sequence === searchSequence.current) setLoading(false);
    }
  };
  const makePreview = async () => {
    if (operation) return;
    setLoading(true);
    setError('');
    setPreview(null);
    try {
      setPreview(await planBulk(api, connection, issues, action, available));
    } catch (failure) {
      setError(String(failure));
    } finally {
      setLoading(false);
    }
  };
  const apply = async () => {
    if (!preview || operation || applying.current) return;
    applying.current = true;
    const next: BulkResult[] = preview.map(({ issue, patch, reason }) => ({
      issue,
      state: patch ? 'pending' : 'failed',
      reason,
    }));
    onOperation(() => ({
      action,
      choice: available,
      results: next,
      working: true,
    }));
    setPreview(null);
    try {
      for (let index = 0; index < preview.length; index++) {
        if (!preview[index].patch) continue;
        // Recheck every issue immediately before its write: Jira transition IDs are issue-specific.
        next[index] = await executeBulkIssue(
          api,
          connection,
          preview[index].issue,
          action,
          available,
          update,
        );
        onOperation((current) =>
          current ? { ...current, results: [...next] } : null,
        );
      }
    } finally {
      applying.current = false;
      onOperation((current) =>
        current ? { ...current, working: false } : null,
      );
    }
  };
  const retry = async (issue: Issue) => {
    if (!operation) return;
    onOperation((current) =>
      current
        ? {
            ...current,
            working: true,
            results: current.results.map((result) =>
              result.issue.key === issue.key
                ? { ...result, state: 'pending' }
                : result,
            ),
          }
        : null,
    );
    try {
      const result = await executeBulkIssue(
        api,
        connection,
        issue,
        operation.action,
        operation.choice,
        update,
      );
      onOperation((current) =>
        current
          ? {
              ...current,
              results: current.results.map((value) =>
                value.issue.key === issue.key ? result : value,
              ),
            }
          : null,
      );
    } finally {
      onOperation((current) =>
        current ? { ...current, working: false } : null,
      );
    }
  };
  const undoOne = async (issue: Issue) => {
    onOperation((current) =>
      current
        ? {
            ...current,
            working: true,
            results: current.results.map((value) =>
              value.issue.key === issue.key
                ? { ...value, state: 'undoing' }
                : value,
            ),
          }
        : null,
    );
    try {
      const success = await undo(issue.key);
      onOperation((current) =>
        current
          ? {
              ...current,
              results: current.results.map((value) =>
                value.issue.key === issue.key
                  ? {
                      issue,
                      state: success ? 'undone' : 'undo-failed',
                      reason: success
                        ? undefined
                        : 'Undo failed. Refresh and review this issue.',
                    }
                  : value,
              ),
            }
          : null,
      );
    } catch (failure) {
      onOperation((current) =>
        current
          ? {
              ...current,
              results: current.results.map((value) =>
                value.issue.key === issue.key
                  ? {
                      issue,
                      state: 'undo-failed',
                      reason:
                        failure instanceof Error
                          ? `Undo failed: ${failure.message}`
                          : `Undo failed: ${String(failure)}`,
                    }
                  : value,
              ),
            }
          : null,
      );
    } finally {
      onOperation((current) =>
        current ? { ...current, working: false } : null,
      );
    }
  };
  return (
    <section className="bulk-triage" aria-label="Bulk triage">
      <header>
        <strong>
          {issues.length > 1
            ? `${issues.length} issues selected`
            : 'Bulk triage results'}
        </strong>
        {issues.length > 1 && (
          <button onClick={onClear}>Clear selection</button>
        )}
        {operation && (
          <button disabled={working} onClick={() => onOperation(() => null)}>
            Dismiss results
          </button>
        )}
      </header>
      {issues.length > 1 && (
        <>
          <div className="bulk-controls">
            <label>
              Action{' '}
              <select
                value={action}
                disabled={working}
                onChange={(event) =>
                  setAction(event.target.value as BulkAction)
                }
              >
                <option value="assignee">Assign</option>
                {connection.provider !== 'github' && (
                  <option value="priority">Change priority</option>
                )}
                <option value="status">Transition</option>
              </select>
            </label>
            {action === 'assignee' && (
              <>
                <input
                  aria-label="Search assignees"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setNextStartAt(undefined);
                    searchSequence.current += 1;
                    setLoading(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void search();
                  }}
                  placeholder="Search people"
                />
                <button disabled={loading} onClick={() => void search()}>
                  Search
                </button>
                {nextStartAt !== undefined && (
                  <button disabled={loading} onClick={() => void search(true)}>
                    Load more
                  </button>
                )}
              </>
            )}
            <label>
              Value{' '}
              <select
                aria-label="Bulk value"
                value={chosen}
                disabled={loading || working}
                onChange={(event) => {
                  setChosen(event.target.value);
                  setPreview(null);
                }}
              >
                <option value="">
                  {action === 'assignee' ? 'Unassigned' : 'Choose…'}
                </option>
                {choices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={
                loading ||
                working ||
                Boolean(operation) ||
                (action !== 'assignee' && !available)
              }
              onClick={() => void makePreview()}
            >
              Preview changes
            </button>
            <button
              disabled={loading || working}
              onClick={async () => {
                setCopyFeedback(null);
                try {
                  setCopyFeedback((await copy(issues)) ? 'copied' : 'failed');
                } catch {
                  setCopyFeedback('failed');
                }
              }}
            >
              Copy keys and summaries
            </button>
          </div>
          {copyFeedback === 'copied' && (
            <p role="status">Copied {issues.length} issues.</p>
          )}
          {copyFeedback === 'failed' && (
            <p role="alert">Couldn’t copy selected issues.</p>
          )}
          {operation && (
            <p role="status">
              Dismiss results before starting another bulk change.
            </p>
          )}
          {loading && <p role="status">Checking available choices…</p>}
          {!loading && action === 'status' && choices.length === 0 && (
            <p role="status">
              No common transition is available for these issues.
            </p>
          )}
          {!loading && action === 'priority' && choices.length === 0 && (
            <p role="status">
              No priority choices are available for these issues.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {preview && (
            <div className="bulk-preview">
              <strong>Review before applying</strong>
              <ul>
                {preview.map(({ issue, patch, reason }) => (
                  <li key={issue.key}>
                    <b>{issue.key}</b> {issue.summary} —{' '}
                    {patch
                      ? `${action === 'assignee' ? 'Assign' : action === 'priority' ? 'Priority' : 'Transition'}: ${available?.name ?? 'Unassigned'}`
                      : `Unavailable: ${reason}`}
                  </li>
                ))}
              </ul>
              <button
                disabled={
                  working ||
                  Boolean(operation) ||
                  !preview.some((value) => value.patch)
                }
                onClick={() => void apply()}
              >
                {preview.some((value) => !value.patch)
                  ? `Apply to ${preview.filter((value) => value.patch).length} eligible issues`
                  : `Apply to ${preview.length} issues`}
              </button>
            </div>
          )}
        </>
      )}
      {operation && (
        <div className="bulk-results" aria-live="polite">
          <strong>Results</strong>
          <ul>
            {operation.results.map(({ issue, state, reason }) => (
              <li key={issue.key}>
                <b>{issue.key}</b> —{' '}
                {state === 'saved'
                  ? 'Saved'
                  : state === 'undone'
                    ? 'Undone'
                    : state === 'pending'
                      ? 'Pending…'
                      : state === 'undoing'
                        ? 'Undoing…'
                        : reason}
                <span>
                  {state === 'failed' && (
                    <button
                      disabled={working}
                      onClick={() => void retry(issue)}
                    >
                      Retry
                    </button>
                  )}
                  {(state === 'saved' || state === 'undo-failed') &&
                    canUndo(issue.key) && (
                      <button
                        disabled={working}
                        onClick={() => void undoOne(issue)}
                      >
                        Undo
                      </button>
                    )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
