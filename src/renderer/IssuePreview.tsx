import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Choice, DevelopmentLinks, Issue, IssuePreview as Preview, SeenIssue, SeenValue } from '../shared/types';
import { unseenChanges } from './seen';

function displayValue(value: SeenValue) {
  return Array.isArray(value) ? value.join(', ') || 'None' : (value ?? 'None');
}
import { PreviewText } from './PreviewText';

function metadataValue(value: string | null | undefined, date = false) {
  if (value === undefined) return 'Unavailable';
  if (value === null || value === '') return 'None';
  return date && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString()
    : value;
}

export function IssuePreview({
  connectionId,
  provider,
  issueKey,
  observedIssue,
  baseline,
  onMarkSeen,
  width,
  onWidth,
  onClose,
  onChanged,
  onPreview,
  onOpenTab,
  onOpenExternal,
  onCopyKeySummary,
  onWorkBrief,
  onOpenComment,
}: {
  connectionId: string;
  provider: 'jira' | 'github' | 'demo';
  issueKey: string;
  observedIssue?: Issue;
  baseline?: SeenIssue;
  onMarkSeen: (issue: Issue) => void;
  width: number;
  onWidth: (width: number) => void;
  onClose: () => void;
  onChanged: (issue: Issue) => void;
  onPreview: (key: string) => void;
  onOpenTab: (key: string) => void;
  onOpenExternal: (key: string) => void;
  onCopyKeySummary: (issue: Preview['issue']) => void;
  onWorkBrief: (preview: Preview) => void;
  onOpenComment: (commentId: string) => void;
}) {
  const [data, setData] = useState<Preview>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [labels, setLabels] = useState<Choice[]>([]);
  const [editingLabels, setEditingLabels] = useState(false);
  const [savingLabels, setSavingLabels] = useState(false);
  const [developmentFor, setDevelopmentFor] = useState<string | null>(null);
  const developmentIdentity = `${connectionId}:${issueKey}`;
  const developmentOpen = developmentFor === developmentIdentity;
  const [development, setDevelopment] = useState<DevelopmentLinks>();
  const [developmentError, setDevelopmentError] = useState('');
  const [developmentAttempt, setDevelopmentAttempt] = useState(0);
  const identity = useRef('');
  const currentIssue = useRef('');
  useLayoutEffect(() => {
    currentIssue.current = `${connectionId}:${issueKey}`;
  }, [connectionId, issueKey]);
  const [dragWidth, setDragWidth] = useState<number>();
  const pane = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number; next: number } | undefined>(
    undefined,
  );
  useEffect(() => {
    let live = true;
    const sameIssue = identity.current === `${connectionId}:${issueKey}`;
    identity.current = `${connectionId}:${issueKey}`;
    if (!sameIssue) setData(undefined);
    setRetrying(sameIssue);
    setError('');
    window.canopy.preview(connectionId, issueKey).then(
      (result) => {
        if (live) {
          setData(result);
          setRetrying(false);
        }
      },
      (error: unknown) => {
        if (live) {
          const message =
            error instanceof Error ? error.message : String(error);
          setRetrying(false);
          setError(message);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [connectionId, issueKey, attempt]);
  useEffect(() => {
    setDevelopmentFor(null);
    setDevelopment(undefined);
    setDevelopmentError('');
  }, [connectionId, issueKey]);
  useEffect(() => {
    if (!developmentOpen) return;
    let live = true;
    setDevelopment(undefined);
    setDevelopmentError('');
    window.canopy.development(connectionId, issueKey).then(
      (result) => {
        if (live) setDevelopment(result);
      },
      (reason: unknown) => {
        if (live)
          setDevelopmentError(
            reason instanceof Error ? reason.message : String(reason),
          );
      },
    );
    return () => {
      live = false;
    };
  }, [connectionId, issueKey, developmentOpen, developmentAttempt]);
  useEffect(() => {
    if (provider !== 'github' || !editingLabels) return;
    let live = true;
    window.canopy.labels(connectionId, issueKey).then(
      (values) => {
        if (live) setLabels(values);
      },
      (reason: unknown) => {
        if (live) setError(String(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [provider, editingLabels, connectionId, issueKey]);
  const toggleLabel = async (name: string) => {
    if (!data || savingLabels) return;
    const requestIdentity = currentIssue.current;
    setSavingLabels(true);
    setError('');
    const current = data.issue.labels?.map((item) => item.name) ?? [];
    const next = current.includes(name)
      ? current.filter((item) => item !== name)
      : [...current, name];
    setData({
      ...data,
      issue: {
        ...data.issue,
        labels: next.map((value) => ({ id: value, name: value })),
      },
    });
    try {
      const issue = await window.canopy.update(connectionId, issueKey, {
        labels: next,
      });
      if (currentIssue.current === requestIdentity) {
        setData({ ...data, issue: { ...issue, links: data.issue.links } });
        onChanged(issue);
      }
    } catch (reason) {
      if (currentIssue.current === requestIdentity) {
        setData(data);
        setError(String(reason));
      }
    } finally {
      setSavingLabels(false);
    }
  };
  const clamp = (next: number) => Math.max(300, Math.min(720, next));
  const retry = (
    <button
      className="tool-button"
      disabled={retrying}
      onClick={() => setAttempt((value) => value + 1)}
    >
      Retry
    </button>
  );
  const unseen = observedIssue
    ? unseenChanges(
        baseline,
        data && !data.commentsError
          ? {
              ...observedIssue,
              commentCount: Math.max(
                observedIssue.commentCount ?? 0,
                data.totalComments,
              ),
            }
          : observedIssue,
      )
    : { fields: [], comments: 0 };
  const confirmedComments =
    baseline && unseen.comments > 0 && !data?.commentsError
      ? (data?.comments ?? []).filter(
          (comment) =>
            /^\d+$/.test(comment.id) &&
            Number.isFinite(Date.parse(comment.created)) &&
            Date.parse(comment.created) > baseline.seenAt,
        )
      : [];
  return (
    <aside
      ref={pane}
      className="issue-preview"
      aria-label={`Preview ${issueKey}`}
      style={{ width: dragWidth ?? width }}
    >
      <div
        className="preview-resize"
        role="separator"
        tabIndex={0}
        aria-label="Resize issue preview"
        aria-orientation="vertical"
        aria-valuemin={300}
        aria-valuemax={720}
        aria-valuenow={dragWidth ?? width}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
            return;
          event.preventDefault();
          onWidth(
            event.key === 'Home'
              ? 300
              : event.key === 'End'
                ? 720
                : clamp(width + (event.key === 'ArrowLeft' ? 20 : -20)),
          );
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            width: pane.current?.getBoundingClientRect().width ?? width,
            next: width,
          };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          drag.current.next = clamp(
            drag.current.width + drag.current.x - event.clientX,
          );
          setDragWidth(drag.current.next);
        }}
        onPointerUp={() => {
          if (drag.current) onWidth(drag.current.next);
          drag.current = undefined;
          setDragWidth(undefined);
        }}
        onPointerCancel={() => {
          drag.current = undefined;
          setDragWidth(undefined);
        }}
      />
      <header>
        <strong>{issueKey}</strong>
        <button
          className="icon-button"
          aria-label="Close issue preview"
          title="Close preview (Escape)"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className="preview-content">
        {error && !data ? (
          <div role="alert">
            {error}
            {retry}
          </div>
        ) : !data ? (
          <p role="status">Loading issue preview…</p>
        ) : (
          <>
            <h2>{data.issue.summary}</h2>
            <section
              className="preview-changes"
              aria-label="Changes since last seen"
            >
              <h3>Since last seen</h3>
              {!observedIssue || !baseline ? (
                <p>No last-seen baseline for this issue in this root.</p>
              ) : unseen.fields.length === 0 && unseen.comments === 0 ? (
                <p>No confirmed unread changes in the refreshed tree.</p>
              ) : (
                <>
                  {unseen.fields.map((change) => (
                    <p key={change.name}>
                      <strong>{change.name}:</strong>{' '}
                      {displayValue(change.before)} →{' '}
                      {displayValue(change.after)}
                    </p>
                  ))}
                  {unseen.comments > 0 && (
                    <p>
                      {unseen.comments} more comment
                      {unseen.comments === 1 ? '' : 's'} than at the last view.{' '}
                      {confirmedComments.length < unseen.comments
                        ? 'Some recent comment links are unavailable.'
                        : ''}
                    </p>
                  )}
                  {confirmedComments.map((comment) => (
                    <button
                      key={comment.id}
                      className="text-button"
                      onClick={() => onOpenComment(comment.id)}
                    >
                      New comment by {comment.author} ·{' '}
                      {new Date(comment.created).toLocaleString()}
                    </button>
                  ))}
                  <button
                    className="tool-button"
                    onClick={() =>
                      onMarkSeen({
                        ...data.issue,
                        commentCount: Math.max(
                          data.issue.commentCount ?? 0,
                          data.totalComments,
                        ),
                      })
                    }
                  >
                    Mark issue seen
                  </button>
                </>
              )}
              <p className="preview-hint">
                Development updates and provider history are unavailable in this
                view.
              </p>
              {observedIssue?.unavailableFields?.length ? (
                <p className="preview-hint">
                  This tree did not supply:{' '}
                  {observedIssue.unavailableFields.join(', ')}.
                </p>
              ) : null}
            </section>
            {provider !== 'demo' && (
              <button
                className="tool-button"
                onClick={() => onOpenExternal(issueKey)}
              >
                Open in {provider === 'github' ? 'GitHub' : 'Jira'}
              </button>
            )}
            <button
              className="tool-button"
              onClick={() => onCopyKeySummary(data.issue)}
            >
              Copy key and summary
            </button>
            <button className="tool-button" onClick={() => onWorkBrief(data)}>
              Copy work brief
            </button>
            <section>
              <h3>Metadata</h3>
              <dl className="preview-metadata">
                {(
                  [
                    ['Reporter', metadataValue(data.metadata?.reporter)],
                    ['Created', metadataValue(data.metadata?.created, true)],
                    ['Updated', metadataValue(data.metadata?.updated, true)],
                    [
                      'Type',
                      data.issue.unavailableFields?.includes('type')
                        ? 'Unavailable'
                        : data.issue.type,
                    ],
                    [
                      'Status',
                      data.issue.unavailableFields?.includes('status')
                        ? 'Unavailable'
                        : data.issue.status.name,
                    ],
                    [
                      'Priority',
                      provider === 'github'
                        ? 'Unavailable in GitHub Issues'
                        : data.issue.unavailableFields?.includes('priority')
                          ? 'Unavailable'
                          : (data.issue.priority?.name ?? 'None'),
                    ],
                    [
                      'Assignee',
                      data.issue.unavailableFields?.includes('assignee')
                        ? 'Unavailable'
                        : (data.issue.assignee?.name ?? 'None'),
                    ],
                    ...(provider === 'github'
                      ? [['Milestone', metadataValue(data.metadata?.milestone)]]
                      : []),
                  ] as [string, string][]
                ).map(([label, value]) => (
                  <React.Fragment key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </section>
            <section>
              <h3>Development</h3>
              <button
                className="tool-button"
                aria-expanded={developmentOpen}
                onClick={() =>
                  setDevelopmentFor(
                    developmentOpen ? null : developmentIdentity,
                  )
                }
              >
                {developmentOpen ? 'Hide development' : 'Show development'}
              </button>
              {developmentOpen &&
                (developmentError ? (
                  <div role="alert">
                    {developmentError}{' '}
                    <button
                      className="tool-button"
                      onClick={() =>
                        setDevelopmentAttempt((value) => value + 1)
                      }
                    >
                      Retry development
                    </button>
                  </div>
                ) : !development ? (
                  <p role="status">Loading development links…</p>
                ) : development.state === 'unavailable' ? (
                  <p>{development.reason}</p>
                ) : (
                  <div>
                    <p className="preview-hint">
                      Associations shown from the GitHub issue timeline.
                    </p>
                    <h4>Branches</h4>
                    <p>{development.branches.reason}</p>
                    <h4>Pull requests</h4>
                    {development.pullRequests.length === 0 && (
                      <p>No associated pull requests found.</p>
                    )}
                    {development.pullRequests.map((item) => (
                      <div className="preview-development-link" key={item.url}>
                        <button
                          className="text-button"
                          onClick={() =>
                            void window.canopy.openDevelopmentLink(item.url)
                          }
                        >
                          {item.title}
                        </button>
                        <span>{item.state}</span>
                      </div>
                    ))}
                    <h4>Commits</h4>
                    {development.commits.length === 0 && (
                      <p>No associated commits found.</p>
                    )}
                    {development.commits.map((item) => (
                      <div className="preview-development-link" key={item.url}>
                        <button
                          className="text-button"
                          onClick={() =>
                            void window.canopy.openDevelopmentLink(item.url)
                          }
                        >
                          {item.title}
                        </button>
                        <span>{item.state}</span>
                      </div>
                    ))}
                  </div>
                ))}
            </section>
            {provider === 'github' && (
              <section>
                <h3>Labels</h3>
                <p>
                  {data.issue.labels?.map((label) => label.name).join(', ') ||
                    'No labels.'}
                </p>
                <button
                  className="tool-button"
                  onClick={() => setEditingLabels((value) => !value)}
                >
                  Edit labels
                </button>
                {editingLabels && (
                  <div className="github-labels">
                    {labels.map((label) => (
                      <label key={label.id}>
                        <input
                          type="checkbox"
                          checked={Boolean(
                            data.issue.labels?.some(
                              (item) => item.name === label.name,
                            ),
                          )}
                          disabled={savingLabels}
                          onChange={() => void toggleLabel(label.name)}
                        />
                        {label.name}
                      </label>
                    ))}
                  </div>
                )}
              </section>
            )}
            <section>
              <h3>Description</h3>
              <div className="preview-text">
                <PreviewText
                  document={data.descriptionDocument}
                  fallback={data.description}
                  empty="No description."
                />
              </div>
            </section>
            <section>
              <h3>Recent comments</h3>
              {retrying && <p role="status">Retrying comments…</p>}
              {data.commentsError || error ? (
                <div role="alert">
                  {error || data.commentsError}
                  {retry}
                </div>
              ) : (
                <>
                  {data.comments.length === 0 && <p>No comments.</p>}
                  {data.comments.map((comment) => (
                    <article className="preview-comment" key={comment.id}>
                      <strong>{comment.author}</strong>
                      {Number.isFinite(Date.parse(comment.created)) && (
                        <time dateTime={comment.created}>
                          {new Date(comment.created).toLocaleString()}
                        </time>
                      )}
                      <div className="preview-text">
                        <PreviewText
                          document={comment.bodyDocument}
                          fallback={comment.body}
                          empty="Empty comment."
                        />
                      </div>
                    </article>
                  ))}
                  {data.totalComments > data.comments.length && (
                    <p>
                      Showing {data.comments.length} of {data.totalComments}{' '}
                      comments.{' '}
                      <button
                        className="text-button"
                        onClick={() => onOpenExternal(issueKey)}
                      >
                        View all in {provider === 'github' ? 'GitHub' : 'Jira'}
                      </button>
                    </p>
                  )}
                </>
              )}
            </section>
            <section>
              <h3>Linked issue references</h3>
              <p className="preview-hint">
                Relationships from {issueKey}; these references are separate
                from hierarchy children.
              </p>
              {data.linksError && <p role="alert">{data.linksError}</p>}
              {data.issue.links.length === 0 && (
                <p>No linked issue references.</p>
              )}
              {data.issue.links.map((link, index) => (
                <article
                  className="preview-link"
                  key={`${link.relationship}-${link.key}-${index}`}
                >
                  <strong>
                    {issueKey} {link.relationship}
                  </strong>
                  <button
                    className="text-button"
                    onClick={() => onPreview(link.key)}
                    aria-label={`Preview ${link.key}: ${link.summary}`}
                  >
                    {link.key} · {link.summary}
                  </button>
                  <div>
                    <button
                      className="tool-button"
                      onClick={() => onOpenTab(link.key)}
                    >
                      Open tree in new tab
                    </button>
                    {provider !== 'demo' && (
                      <button
                        className="tool-button"
                        onClick={() => onOpenExternal(link.key)}
                      >
                        Open in {provider === 'github' ? 'GitHub' : 'Jira'}
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
