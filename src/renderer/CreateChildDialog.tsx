import React, { useEffect, useRef, useState } from 'react';
import type {
  ChildCreateFields,
  ChildCreateOptions,
  Choice,
  Issue,
} from '../shared/types';

export function CreateChildDialog({
  connectionId,
  parent,
  onClose,
  onCreated,
  onOpenJira,
}: {
  connectionId: string;
  parent: Issue;
  onClose: () => void;
  onCreated: (issue: Issue) => void;
  onOpenJira: () => void;
}) {
  const [options, setOptions] = useState<ChildCreateOptions | null>(null);
  const [fields, setFields] = useState<ChildCreateFields | null>(null);
  const [typeId, setTypeId] = useState('');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [assigneeQuery, setAssigneeQuery] = useState('');
  const [assignees, setAssignees] = useState<Choice[]>([]);
  const [nextAssigneeStart, setNextAssigneeStart] = useState<number | null>(
    null,
  );
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [assignee, setAssignee] = useState<Choice | null>(null);
  const [priorityId, setPriorityId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const [createdUnknown, setCreatedUnknown] = useState(false);
  const submitting = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const assigneeQueryRef = useRef(assigneeQuery);
  assigneeQueryRef.current = assigneeQuery;

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    window.canopy
      .childCreateOptions(connectionId, parent.key, retry > 0)
      .then((result) => {
        if (!live) return;
        setOptions(result);
        setTypeId((current) =>
          result.types.some((type) => type.id === current)
            ? current
            : (result.types[0]?.id ?? ''),
        );
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (live) {
          setError(String(cause instanceof Error ? cause.message : cause));
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [connectionId, parent.key, retry]);

  useEffect(() => {
    setFields(null);
    setPriorityId('');
    if (!typeId) return;
    let live = true;
    window.canopy
      .childCreateFields(connectionId, parent.key, typeId)
      .then((result) => {
        if (live) setFields(result);
      })
      .catch((cause: unknown) => {
        if (live)
          setError(String(cause instanceof Error ? cause.message : cause));
      });
    return () => {
      live = false;
    };
  }, [connectionId, parent.key, typeId, retry]);

  useEffect(() => {
    if (!fields?.assignee) return;
    let live = true;
    setAssignees([]);
    setNextAssigneeStart(null);
    const timer = window.setTimeout(() => {
      setPeopleLoading(true);
      // The child has no key yet; Jira validates its assignment on create.
      window.canopy
        .assignees(connectionId, parent.key, assigneeQuery)
        .then((page) => {
          if (live) {
            setAssignees(page.users);
            setNextAssigneeStart(page.nextStartAt ?? null);
          }
        })
        .catch((cause: unknown) => {
          if (live)
            setError(String(cause instanceof Error ? cause.message : cause));
        })
        .finally(() => {
          if (live) setPeopleLoading(false);
        });
    }, 180);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [connectionId, parent.key, fields?.assignee, assigneeQuery]);

  const loadMorePeople = async () => {
    if (nextAssigneeStart === null || peopleLoading) return;
    const query = assigneeQuery;
    setPeopleLoading(true);
    try {
      const page = await window.canopy.assignees(
        connectionId,
        parent.key,
        query,
        nextAssigneeStart,
      );
      if (assigneeQueryRef.current !== query) return;
      setAssignees((current) => [
        ...new Map(
          [...current, ...page.users].map((person) => [person.id, person]),
        ).values(),
      ]);
      setNextAssigneeStart(page.nextStartAt ?? null);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setPeopleLoading(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      submitting.current ||
      createdUnknown ||
      !fields ||
      fields.unsupported ||
      !summary.trim()
    )
      return;
    submitting.current = true;
    setSaving(true);
    setError('');
    try {
      const issue = await window.canopy.createChild(connectionId, parent.key, {
        typeId,
        summary: summary.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(assignee ? { assigneeId: assignee.id } : {}),
        ...(priorityId ? { priorityId } : {}),
      });
      onCreated(issue);
    } catch (cause) {
      const message = String(cause instanceof Error ? cause.message : cause);
      if (
        /Jira created (?:[A-Z][A-Z0-9_]*-\d+|the issue without returning its key)/.test(
          message,
        )
      )
        setCreatedUnknown(true);
      setError(message);
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="dialog compact"
        role="dialog"
        aria-modal="true"
        aria-label={`Create child issue of ${parent.key}`}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !saving) {
            event.preventDefault();
            onClose();
          }
          if (event.key !== 'Tab') return;
          const focusable = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
            ),
          ];
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header>
          <h2>Create child issue</h2>
          <button
            className="icon-button"
            aria-label="Close"
            disabled={saving}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <form
          className="create-child-form"
          onSubmit={(event) => void submit(event)}
        >
          <p className="dialog-note">
            Parent: {parent.key} · {parent.summary}
            {options ? ` · ${options.project.name}` : ''}
          </p>
          {loading ? (
            <p className="dialog-note">Loading Jira creation options…</p>
          ) : (
            <>
              {options?.types.length ? (
                <>
                  <label>
                    <span>Issue type</span>
                    <select
                      value={typeId}
                      disabled={saving}
                      onChange={(event) => {
                        setError('');
                        setTypeId(event.target.value);
                        setDescription('');
                        setAssignee(null);
                        setAssigneeQuery('');
                        setPriorityId('');
                      }}
                    >
                      {options.types.map((type) => (
                        <option key={type.id} value={type.id}>
                          {type.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Title</span>
                    <input
                      autoFocus
                      maxLength={255}
                      value={summary}
                      disabled={saving}
                      onChange={(event) => setSummary(event.target.value)}
                      required
                    />
                  </label>
                  {fields?.description && (
                    <label>
                      <span>
                        Description{fields.descriptionRequired ? ' *' : ''}
                      </span>
                      <textarea
                        value={description}
                        disabled={saving}
                        required={fields.descriptionRequired}
                        onChange={(event) => setDescription(event.target.value)}
                      />
                    </label>
                  )}
                  {fields?.assignee && (
                    <label>
                      <span>Assignee{fields.assigneeRequired ? ' *' : ''}</span>
                      <input
                        value={assignee ? assignee.name : assigneeQuery}
                        disabled={saving}
                        placeholder="Search people"
                        onChange={(event) => {
                          setAssignee(null);
                          setAssigneeQuery(event.target.value);
                        }}
                      />
                      {assignee && (
                        <button
                          type="button"
                          onClick={() => {
                            setAssignee(null);
                            setAssigneeQuery('');
                          }}
                        >
                          Clear assignee
                        </button>
                      )}
                      {!assignee && assignees.length > 0 && (
                        <div className="create-child-people">
                          {assignees.map((person) => (
                            <button
                              type="button"
                              key={person.id}
                              onClick={() => {
                                setAssignee(person);
                                setAssigneeQuery('');
                              }}
                            >
                              {person.name}
                            </button>
                          ))}
                          {nextAssigneeStart !== null && (
                            <button
                              type="button"
                              disabled={peopleLoading}
                              onClick={() => void loadMorePeople()}
                            >
                              {peopleLoading ? 'Loading…' : 'Load more people'}
                            </button>
                          )}
                        </div>
                      )}
                      {!assignee &&
                        !peopleLoading &&
                        assignees.length === 0 && (
                          <small>
                            No people found in Jira’s first search window. Try
                            another name.
                          </small>
                        )}
                    </label>
                  )}
                  {fields?.priority && (
                    <label>
                      <span>Priority{fields.priorityRequired ? ' *' : ''}</span>
                      <select
                        value={priorityId}
                        disabled={saving}
                        onChange={(event) => setPriorityId(event.target.value)}
                      >
                        <option value="">Jira default</option>
                        {fields.priorities.map((priority) => (
                          <option key={priority.id} value={priority.id}>
                            {priority.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              ) : (
                <p className="dialog-note">{options?.reason}</p>
              )}
              {fields?.unsupported && (
                <p className="dialog-note">{fields.unsupported}</p>
              )}
            </>
          )}
          {error && (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          )}
          {error && !saving && !createdUnknown && (
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry Jira options
            </button>
          )}
          <div className="dialog-footer">
            <button type="button" onClick={onOpenJira}>
              Open parent in Jira
            </button>
            <span className="footer-spacer" />
            <button type="button" disabled={saving} onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary"
              type="submit"
              disabled={
                saving ||
                createdUnknown ||
                !fields ||
                !!fields.unsupported ||
                !summary.trim() ||
                (fields.descriptionRequired && !description.trim()) ||
                (fields.assigneeRequired && !assignee) ||
                (fields.priorityRequired && !priorityId)
              }
            >
              {saving ? 'Creating…' : 'Create child'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
