import React, { useEffect, useRef, useState } from 'react';
import type {
  AuthoringAction,
  AuthoringOptions,
  AuthoringResult,
  ParentPlan,
} from '../shared/authoring';
import { loadDraft, saveDraft, type AuthoringDraft } from './authoring-drafts';

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
  const mounted = useRef(true);
  const saving = useRef(false);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  useEffect(() => {
    mounted.current = true;
    try {
      setDraft(loadDraft(localStorage, connectionId, issueKey));
    } catch (reason) {
      setDraft({
        pending: 'draft recovery',
        result: {
          state: 'unknown',
          message:
            'Saved draft recovery failed. Check the provider before another write.',
        },
      });
      setDraftError(
        `Draft recovery failed: ${String(reason)}. Browser handoff remains available.`,
      );
    }
    return () => {
      mounted.current = false;
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
    persist({ ...currentDraft.current, ...patch });
  };
  const submit = async (action: AuthoringAction) => {
    if (saving.current || draft.pending || draftError) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setCheckedProvider(false);
    const before = currentDraft.current;
    // Persist before the request: a process exit or preview navigation cannot erase uncertainty.
    if (!persist({ ...before, pending: action.kind, result: undefined })) {
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
    const next = { ...currentDraft.current, result };
    if (result.state === 'saved') {
      delete next.pending;
      if (action.kind === 'description') {
        delete next.description;
        delete next.revision;
        delete next.fragments;
      }
      if (action.kind === 'comment') delete next.comment;
      if (action.kind === 'child') {
        delete next.childSummary;
        delete next.childDescription;
      }
    } else if (result.state === 'rejected') delete next.pending;
    persist(next);
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
  const disabled = busy || Boolean(draft.pending) || Boolean(draftError);
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
                {draft.pending} retry is blocked until you check the provider.{' '}
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
                disabled={busy || !checkedProvider}
                onClick={() => {
                  const next = { ...currentDraft.current };
                  delete next.pending;
                  delete next.result;
                  if (draft.result?.key) {
                    delete next.childSummary;
                    delete next.childDescription;
                  }
                  persist(next);
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
                        const edits: { id: string; value: string }[] =
                          draft.fragments
                            ? JSON.parse(draft.fragments)
                            : options.description.fragments!;
                        return (
                          <label key={fragment.id}>
                            Text run {index + 1}
                            <textarea
                              maxLength={100_000}
                              aria-label={`Description text run ${index + 1}`}
                              disabled={disabled}
                              value={
                                edits.find((edit) => edit.id === fragment.id)
                                  ?.value ?? fragment.value
                              }
                              onChange={(event) =>
                                change({
                                  fragments: JSON.stringify(
                                    edits.map((edit) =>
                                      edit.id === fragment.id
                                        ? { ...edit, value: event.target.value }
                                        : edit,
                                    ),
                                  ),
                                  revision:
                                    draft.revision ??
                                    options.description.revision,
                                })
                              }
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
                        disabled={disabled}
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
                        <button
                          disabled={disabled}
                          onClick={() =>
                            change({ revision: options.description.revision })
                          }
                        >
                          I reviewed the current description; keep my draft
                        </button>
                      </div>
                    )}
                  <button
                    disabled={
                      disabled ||
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
                      disabled={disabled}
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
                      disabled={disabled}
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
                      disabled={disabled}
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
                      disabled={disabled}
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
                        disabled={disabled}
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
                        disabled={disabled}
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
