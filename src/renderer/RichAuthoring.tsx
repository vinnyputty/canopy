import React, { useEffect, useRef, useState } from 'react';
import type {
  AuthoringAction,
  AuthoringOptions,
  AuthoringResult,
  ParentPlan,
} from '../shared/authoring';
import {
  loadDraft,
  saveDraft,
  subscribeDraft,
  activeAuthoringAttempt,
  beginAuthoringAttempt,
  endAuthoringAttempt,
  settleAuthoringDraft,
  type AuthoringDraft,
} from './authoring-drafts';

export function RichAuthoring({
  connectionId,
  issueKey,
  provider,
  onRefresh,
  onPreview,
  onBrowser,
}: {
  connectionId: string;
  issueKey: string;
  provider: 'jira' | 'github' | 'demo';
  onRefresh: () => void;
  onPreview: (key: string) => void;
  onBrowser: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<AuthoringOptions>();
  const [draft, setDraft] = useState<AuthoringDraft>({});
  const [error, setError] = useState('');
  const [draftError, setDraftError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [plan, setPlan] = useState<ParentPlan>();
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [checkedProvider, setCheckedProvider] = useState(false);
  const [activeAttempt, setActiveAttempt] = useState(false);
  const mounted = useRef(true);
  const saving = useRef(false);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  useEffect(() => {
    mounted.current = true;
    const reloadDraft = () => {
      setActiveAttempt(activeAuthoringAttempt(connectionId, issueKey));
      try {
        const latest = loadDraft(localStorage, connectionId, issueKey);
        if (
          latest.attemptId !== currentDraft.current.attemptId ||
          JSON.stringify(latest.result) !==
            JSON.stringify(currentDraft.current.result)
        )
          setCheckedProvider(false);
        currentDraft.current = latest;
        setDraft(latest);
      } catch (reason) {
        const recovery: AuthoringDraft = {
          pending: 'draft recovery',
          result: {
            state: 'unknown',
            message:
              'Saved draft recovery failed. Check the provider before another write.',
          },
        };
        currentDraft.current = recovery;
        setDraft(recovery);
        setDraftError(
          `Draft recovery failed: ${String(reason)}. Browser handoff remains available.`,
        );
      }
    };
    const unsubscribe = subscribeDraft(connectionId, issueKey, reloadDraft);
    reloadDraft();
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [connectionId, issueKey]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setError('');
    setOptions(undefined);
    setPlan(undefined);
    window.canopy.authoringOptions(connectionId, issueKey).then(
      (value) => {
        if (!live) return;
        setOptions(value);
        setFieldValues(
          Object.fromEntries(
            value.fields.map((field) => [field.id, field.value]),
          ),
        );
      },
      (reason: unknown) => {
        if (live)
          setError(String(reason instanceof Error ? reason.message : reason));
      },
    );
    return () => {
      live = false;
    };
  }, [open, connectionId, issueKey, attempt]);
  const persist = (next: AuthoringDraft) => {
    try {
      saveDraft(localStorage, connectionId, issueKey, next);
      currentDraft.current = next;
      if (mounted.current) {
        setDraft(next);
        setDraftError('');
      }
      return true;
    } catch (reason) {
      if (mounted.current) {
        setDraft(next);
        setDraftError(
          `Could not save draft: ${String(reason)}. Keep this pane open and retry draft recovery before writing.`,
        );
      }
      return false;
    }
  };
  const change = (patch: Partial<AuthoringDraft>) => {
    try {
      const latest = loadDraft(localStorage, connectionId, issueKey);
      const editVersions = { ...latest.editVersions };
      if ('description' in patch || 'fragments' in patch || 'revision' in patch)
        editVersions.description = crypto.randomUUID();
      if ('comment' in patch) editVersions.comment = crypto.randomUUID();
      if ('childSummary' in patch || 'childDescription' in patch)
        editVersions.child = crypto.randomUUID();
      persist({ ...latest, ...patch, editVersions });
    } catch (reason) {
      setDraftError(`Draft recovery failed: ${String(reason)}`);
    }
  };
  const submit = async (action: AuthoringAction) => {
    if (
      saving.current ||
      currentDraft.current.pending ||
      draftError ||
      activeAuthoringAttempt(connectionId, issueKey)
    )
      return;
    let before: AuthoringDraft;
    try {
      before = loadDraft(localStorage, connectionId, issueKey);
    } catch (reason) {
      setDraftError(`Draft recovery failed: ${String(reason)}`);
      return;
    }
    if (before.pending) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setCheckedProvider(false);
    const attemptId = crypto.randomUUID();
    // Persist before the request: a process exit or preview navigation cannot erase uncertainty.
    if (
      !persist({
        ...before,
        pending: action.kind,
        attemptId,
        attemptVersion:
          action.kind === 'description' ||
          action.kind === 'comment' ||
          action.kind === 'child'
            ? before.editVersions?.[action.kind]
            : undefined,
        result: undefined,
      })
    ) {
      saving.current = false;
      setBusy(false);
      return;
    }
    if (!beginAuthoringAttempt(connectionId, issueKey, attemptId)) {
      saving.current = false;
      setBusy(false);
      return;
    }
    let result: AuthoringResult;
    try {
      result = await window.canopy.author(connectionId, issueKey, action);
    } catch (reason) {
      result = {
        state: 'unknown',
        message: `${String(reason)} The outcome is unknown. Check the provider before retrying.`,
      };
    }
    try {
      settleAuthoringDraft(
        localStorage,
        connectionId,
        issueKey,
        attemptId,
        before,
        action,
        result,
      );
    } catch (reason) {
      if (mounted.current)
        setDraftError(
          `Could not settle saved draft: ${String(reason)}. Check the provider before retrying.`,
        );
    } finally {
      endAuthoringAttempt(connectionId, issueKey, attemptId);
    }
    saving.current = false;
    if (mounted.current) {
      setBusy(false);
      if (result.state === 'saved' || result.state === 'partial') {
        setAttempt((value) => value + 1);
        onRefresh();
      }
    }
  };
  const previewParent = async () => {
    if (saving.current) return;
    setBusy(true);
    setError('');
    setPlan(undefined);
    try {
      const value = await window.canopy.previewParent(
        connectionId,
        issueKey,
        draft.parent?.trim() || null,
      );
      if (mounted.current) setPlan(value);
    } catch (reason) {
      if (mounted.current)
        setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const disabled =
    busy || activeAttempt || Boolean(draft.pending) || Boolean(draftError);
  const editingDisabled =
    busy || Boolean(draftError) || (Boolean(draft.pending) && !activeAttempt);
  const savedFragments: { id: string; value: string }[] = draft.fragments
    ? JSON.parse(draft.fragments)
    : [];
  const fragmentTextLength = savedFragments.reduce(
    (total, fragment) => total + fragment.value.length,
    0,
  );
  const currentFragments = options?.description.fragments;
  const edits = currentFragments?.map(
    (fragment) =>
      savedFragments.find((edit) => edit.id === fragment.id) ?? fragment,
  );
  const needsFragmentReview =
    savedFragments.length >= 500 &&
    currentFragments?.some(
      (fragment) => !savedFragments.some(({ id }) => id === fragment.id),
    );
  const incompatibleText = currentFragments
    ? [
        ...(draft.description !== undefined ? [draft.description] : []),
        ...savedFragments
          .filter((edit) => !currentFragments.some(({ id }) => id === edit.id))
          .map((edit) => edit.value),
      ]
    : savedFragments.map((edit) => edit.value);
  if (provider === 'demo') return null;
  return (
    <section className="rich-authoring" aria-label={`Author ${issueKey}`}>
      <button
        className="tool-button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? 'Hide authoring' : 'Edit and discuss'}
      </button>
      {open && (
        <>
          <p className="preview-hint">
            Drafts are saved on this device for this account and issue.{' '}
            {provider === 'github'
              ? 'GitHub Markdown is sent verbatim; HTML stays text in Canopy.'
              : 'Jira text is sent as safe paragraphs and line breaks; formatting and mentions are edited in Jira.'}
          </p>
          {draftError && (
            <p role="alert">
              {draftError}{' '}
              <button onClick={() => persist(currentDraft.current)}>
                Retry saving draft
              </button>
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          <button
            className="tool-button"
            disabled={busy}
            onClick={() => {
              setAttempt((value) => value + 1);
              onRefresh();
            }}
          >
            Refresh authoring options
          </button>
          <button className="tool-button" onClick={onBrowser}>
            Continue in {provider === 'github' ? 'GitHub' : 'Jira'}
          </button>
          {draft.result && (
            <p role={draft.result.state === 'saved' ? 'status' : 'alert'}>
              {draft.result.message}{' '}
              {draft.result.key && (
                <button
                  className="text-button"
                  onClick={() => onPreview(draft.result!.key!)}
                >
                  Preview {draft.result.key}
                </button>
              )}
            </p>
          )}
          {draft.pending && (
            <div className="authoring-recovery">
              <p role="alert">
                {activeAttempt
                  ? 'An authoring request is still running for this account and issue. Wait for its result before allowing another write.'
                  : `${draft.pending} retry is blocked until you check the provider.`}{' '}
                {draft.result?.state === 'partial' && draft.result.key
                  ? 'Use the created issue’s parent editor to finish linking it.'
                  : 'The previous request may already have completed.'}
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={checkedProvider}
                  onChange={(event) => setCheckedProvider(event.target.checked)}
                />
                I checked the provider’s current content and hierarchy
              </label>
              <button
                disabled={busy || activeAttempt || !checkedProvider}
                onClick={() => {
                  if (
                    saving.current ||
                    activeAuthoringAttempt(connectionId, issueKey)
                  )
                    return;
                  try {
                    const next = loadDraft(
                      localStorage,
                      connectionId,
                      issueKey,
                    );
                    if (
                      next.attemptId !== draft.attemptId ||
                      next.pending !== draft.pending ||
                      JSON.stringify(next.result) !==
                        JSON.stringify(draft.result)
                    ) {
                      setCheckedProvider(false);
                      return;
                    }
                    const completedChild =
                      next.result?.key &&
                      next.editVersions?.child === next.attemptVersion;
                    delete next.pending;
                    delete next.attemptId;
                    delete next.attemptVersion;
                    delete next.result;
                    if (completedChild) {
                      delete next.childSummary;
                      delete next.childDescription;
                    }
                    persist(next);
                  } catch (reason) {
                    setDraftError(`Draft recovery failed: ${String(reason)}`);
                  }
                  setCheckedProvider(false);
                }}
              >
                Allow a new write after review
              </button>
            </div>
          )}
          {!options ? (
            <p role="status">
              {error
                ? 'Authoring options unavailable. Retry or continue in the browser.'
                : 'Loading authoring options…'}
            </p>
          ) : (
            <>
              <h4>Description editor</h4>
              {options.description.editable ? (
                <>
                  {options.description.fragments ? (
                    <>
                      <p>{options.description.reason}</p>
                      {options.description.fragments.map((fragment, index) => {
                        return (
                          <label key={fragment.id}>
                            Text run {index + 1}
                            <textarea
                              maxLength={100_000}
                              aria-label={`Description text run ${index + 1}`}
                              disabled={
                                editingDisabled ||
                                (needsFragmentReview &&
                                  !savedFragments.some(
                                    ({ id }) => id === fragment.id,
                                  ))
                              }
                              value={
                                edits!.find((edit) => edit.id === fragment.id)
                                  ?.value ?? fragment.value
                              }
                              onChange={(event) => {
                                const update = (items: typeof savedFragments) =>
                                  items.map((edit) =>
                                    edit.id === fragment.id
                                      ? { ...edit, value: event.target.value }
                                      : edit,
                                  );
                                // Retain incompatible saved runs until explicit review.
                                let next = update([
                                  ...savedFragments.filter(
                                    (edit) =>
                                      !edits!.some(({ id }) => id === edit.id),
                                  ),
                                  ...edits!,
                                ]);
                                if (
                                  next.length > 500 ||
                                  JSON.stringify(next).length > 500_000
                                ) {
                                  if (
                                    savedFragments.some(
                                      ({ id }) => id === fragment.id,
                                    )
                                  ) {
                                    next = update(savedFragments);
                                  } else if (savedFragments.length < 500) {
                                    next = [
                                      ...savedFragments,
                                      {
                                        id: fragment.id,
                                        value: event.target.value,
                                      },
                                    ];
                                  } else {
                                    setError(
                                      'Review the current description before editing added text runs. Your saved draft is retained.',
                                    );
                                    return;
                                  }
                                }
                                if (
                                  next.reduce(
                                    (total, edit) => total + edit.value.length,
                                    0,
                                  ) > 100_000 &&
                                  event.target.value.length >
                                    (edits!.find(
                                      (edit) => edit.id === fragment.id,
                                    )?.value.length ?? 0)
                                ) {
                                  setError(
                                    'Description text runs exceed 100,000 characters in total. Shorten the text before saving. Your saved draft is retained.',
                                  );
                                  return;
                                }
                                const fragments = JSON.stringify(next);
                                if (fragments.length > 500_000) {
                                  setError(
                                    'This edit exceeds the saved draft limit. Shorten the text or review the current description first. Your saved draft is retained.',
                                  );
                                  return;
                                }
                                change({
                                  fragments,
                                  revision:
                                    draft.revision ??
                                    options.description.revision,
                                });
                              }}
                            />
                          </label>
                        );
                      })}
                    </>
                  ) : (
                    <label>
                      Draft description
                      <textarea
                        aria-label="Draft description"
                        disabled={editingDisabled}
                        maxLength={100_000}
                        value={draft.description ?? options.description.value}
                        onChange={(event) =>
                          change({
                            description: event.target.value,
                            revision:
                              draft.revision ?? options.description.revision,
                          })
                        }
                      />
                    </label>
                  )}
                  {draft.revision &&
                    draft.revision !== options.description.revision && (
                      <div role="alert">
                        <p>
                          The provider description changed. Current description:
                        </p>
                        <pre>{options.description.value}</pre>
                        {needsFragmentReview && (
                          <p>
                            Your saved draft reached the text-run limit. Review
                            the current description before editing added runs.
                            Matching saved runs remain editable.
                          </p>
                        )}
                        {incompatibleText.length > 0 && (
                          <>
                            <p>
                              These saved draft texts do not match the current
                              editor format or text runs. Copy them before
                              accepting; acceptance removes them from the draft.
                              Matching text runs and edits in the current editor
                              are kept.
                            </p>
                            <pre>{incompatibleText.join('\n\n')}</pre>
                          </>
                        )}
                        <button
                          disabled={editingDisabled}
                          onClick={() => {
                            const fragments = edits
                              ? JSON.stringify(edits)
                              : undefined;
                            if (fragments && fragments.length > 500_000) {
                              setError(
                                'The current text runs exceed the saved draft limit. Shorten your saved text before reviewing again, or edit this description in the browser.',
                              );
                              return;
                            }
                            setError('');
                            change({
                              revision: options.description.revision,
                              fragments,
                              description: edits
                                ? undefined
                                : (draft.description ??
                                  options.description.value),
                            });
                          }}
                        >
                          I reviewed the current description; keep my draft
                        </button>
                      </div>
                    )}
                  <button
                    disabled={
                      disabled ||
                      fragmentTextLength > 100_000 ||
                      (draft.description === undefined &&
                        draft.fragments === undefined) ||
                      (draft.revision !== undefined &&
                        draft.revision !== options.description.revision)
                    }
                    onClick={() =>
                      void submit({
                        kind: 'description',
                        value: draft.description ?? '',
                        revision:
                          draft.revision ?? options.description.revision,
                        ...(draft.fragments
                          ? { fragments: JSON.parse(draft.fragments) }
                          : {}),
                      })
                    }
                  >
                    Save description
                  </button>
                </>
              ) : (
                <p>{options.description.reason}</p>
              )}
              <h4>Add comment</h4>
              {options.comment.allowed ? (
                <>
                  <label>
                    Comment draft
                    <textarea
                      aria-label="Comment draft"
                      disabled={editingDisabled}
                      maxLength={100_000}
                      value={draft.comment ?? ''}
                      onChange={(event) =>
                        change({ comment: event.target.value })
                      }
                    />
                  </label>
                  <p className="preview-hint">
                    Comments use the provider’s normal audience. Restricted
                    visibility is configured in the browser.
                  </p>
                  <button
                    disabled={disabled || !draft.comment?.trim()}
                    onClick={() =>
                      void submit({ kind: 'comment', value: draft.comment! })
                    }
                  >
                    Post comment
                  </button>
                </>
              ) : (
                <p>{options.comment.reason}</p>
              )}
              <h4>Change parent</h4>
              {options.parent.allowed ? (
                <>
                  <label>
                    Destination parent
                    <input
                      aria-label="Destination parent"
                      disabled={editingDisabled}
                      placeholder={
                        provider === 'github'
                          ? 'owner/repo#number; empty removes parent'
                          : 'PROJ-123; empty removes eligible parent'
                      }
                      value={draft.parent ?? ''}
                      onChange={(event) => {
                        change({ parent: event.target.value });
                        setPlan(undefined);
                      }}
                    />
                  </label>
                  <button
                    disabled={disabled}
                    onClick={() => void previewParent()}
                  >
                    Preview hierarchy change
                  </button>
                  {plan && (
                    <div aria-label="Hierarchy effects">
                      <ul>
                        {plan.effects.map((effect) => (
                          <li key={effect}>{effect}</li>
                        ))}
                      </ul>
                      <button
                        disabled={disabled}
                        onClick={() => void submit({ kind: 'parent', plan })}
                      >
                        Apply hierarchy change
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <p>{options.parent.reason}</p>
              )}
              {options.createChild && (
                <>
                  <h4>Create GitHub sub-issue</h4>
                  <p>
                    Creates an issue in this parent’s repository and links it
                    under {issueKey}. A failed link preserves the created key
                    for recovery.
                  </p>
                  <label>
                    Sub-issue title
                    <input
                      aria-label="Sub-issue title"
                      disabled={editingDisabled}
                      maxLength={255}
                      value={draft.childSummary ?? ''}
                      onChange={(event) =>
                        change({ childSummary: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Sub-issue description
                    <textarea
                      aria-label="Sub-issue description"
                      disabled={editingDisabled}
                      maxLength={100_000}
                      value={draft.childDescription ?? ''}
                      onChange={(event) =>
                        change({ childDescription: event.target.value })
                      }
                    />
                  </label>
                  <button
                    disabled={disabled || !draft.childSummary?.trim()}
                    onClick={() =>
                      void submit({
                        kind: 'child',
                        summary: draft.childSummary!,
                        description: draft.childDescription ?? '',
                      })
                    }
                  >
                    Create sub-issue
                  </button>
                </>
              )}
              <h4>Provider fields</h4>
              {options.fields.length === 0 && (
                <p>
                  No additional fields are available with confirmed edit access.
                  Continue in the browser for other fields.
                </p>
              )}
              {options.fields.map((field) => (
                <div key={field.id}>
                  <label>
                    {field.name}
                    {field.required ? ' *' : ''}
                    {field.kind === 'choice' || field.kind === 'choices' ? (
                      <select
                        aria-label={field.name}
                        disabled={editingDisabled}
                        multiple={field.kind === 'choices'}
                        value={
                          field.kind === 'choices'
                            ? fieldValues[field.id]
                              ? fieldValues[field.id].split(',')
                              : []
                            : (fieldValues[field.id] ?? '')
                        }
                        onChange={(event) =>
                          setFieldValues({
                            ...fieldValues,
                            [field.id]:
                              field.kind === 'choices'
                                ? [...event.target.selectedOptions]
                                    .map((option) => option.value)
                                    .sort()
                                    .join(',')
                                : event.target.value,
                          })
                        }
                      >
                        {field.kind === 'choice' && (
                          <option value="">None</option>
                        )}
                        {field.choices?.map((choice) => (
                          <option key={choice.id} value={choice.id}>
                            {choice.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        aria-label={field.name}
                        disabled={editingDisabled}
                        type={field.kind === 'date' ? 'date' : 'text'}
                        value={fieldValues[field.id] ?? ''}
                        onChange={(event) =>
                          setFieldValues({
                            ...fieldValues,
                            [field.id]: event.target.value,
                          })
                        }
                      />
                    )}
                  </label>
                  <button
                    disabled={disabled || fieldValues[field.id] === field.value}
                    onClick={() =>
                      void submit({
                        kind: 'field',
                        id: field.id,
                        value: fieldValues[field.id] ?? '',
                        previous: field.value,
                      })
                    }
                  >
                    Save {field.name}
                  </button>
                </div>
              ))}
              <h4>Attachments</h4>
              {options.attachments.length === 0 && (
                <p>
                  No accessible attachments found in the issue description or
                  provider metadata.
                </p>
              )}
              {options.attachments.map((item) => (
                <p key={item.id}>
                  <button
                    className="text-button"
                    onClick={() => {
                      void window.canopy
                        .openAttachment(connectionId, issueKey, item.id)
                        .catch((reason) => {
                          if (mounted.current) setError(String(reason));
                        });
                    }}
                  >
                    {item.name}
                    {item.size === undefined ? '' : ` (${item.size} bytes)`}
                  </button>
                </p>
              ))}
              <ul className="preview-hint">
                {options.handoffs.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
