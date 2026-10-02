import type {
  AuthoringAction,
  AuthoringField,
  AuthoringOptions,
  AuthoringResult,
  ParentPlan,
} from '../shared/authoring';
import { documentText } from './adf';

type Request = (path: string, init?: RequestInit) => Promise<any>;
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify(body),
});
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const rejected = (reason: string): AuthoringResult => ({
  state: 'rejected',
  message: reason,
});
// Transport failures and 5xx can happen after the server commits. Never repeat a POST automatically.
export function writeFailure(error: unknown): AuthoringResult {
  const reason = message(error);
  const status = (error as { status?: number })?.status;
  const definite =
    (status !== undefined &&
      [400, 401, 403, 404, 409, 410, 422, 429].includes(status)) ||
    /(?:returned|rejected|HTTP) (?:400|401|403|404|409|410|422|429)\b|rate limit reached|authorization expired/i.test(
      reason,
    );
  return {
    state: definite ? 'rejected' : 'unknown',
    message: `${reason} ${definite ? 'No confirmed write; correct the problem and retry.' : 'The outcome is unknown. Refresh and check in the browser before retrying to avoid duplicate writes.'}`,
  };
}
export function textDocument(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: text
      .replace(/\r\n/g, '\n')
      .split('\n\n')
      .map((paragraph) => ({
        type: 'paragraph',
        content: paragraph
          .split('\n')
          .flatMap((line, index) => [
            ...(index ? [{ type: 'hardBreak' }] : []),
            ...(line ? [{ type: 'text', text: line }] : []),
          ]),
      })),
  };
}
export function plainDocument(value: any): boolean {
  if (value == null) return true;
  if (!value || typeof value !== 'object' || value.attrs || value.marks?.length)
    return false;
  if (value.type === 'doc' && value.version !== 1) return false;
  const allowed =
    value.type === 'doc'
      ? ['type', 'version', 'content']
      : value.type === 'paragraph'
        ? ['type', 'content']
        : value.type === 'text'
          ? ['type', 'text']
          : value.type === 'hardBreak'
            ? ['type']
            : [];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  if (value.type === 'text') return typeof value.text === 'string';
  if (value.type === 'hardBreak') return true;
  return (
    ['doc', 'paragraph'].includes(value.type) &&
    (value.content === undefined ||
      (Array.isArray(value.content) && value.content.every(plainDocument)))
  );
}
export function documentFragments(value: any): { id: string; value: string }[] {
  const fragments: { id: string; value: string }[] = [];
  const walk = (node: any, path: number[]) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'text' && typeof node.text === 'string')
      fragments.push({ id: path.join('.'), value: node.text });
    if (Array.isArray(node.content))
      node.content.forEach((child: any, index: number) =>
        walk(child, [...path, index]),
      );
  };
  walk(value, []);
  return fragments;
}
export function editDocumentFragments(
  document: unknown,
  edits: { id: string; value: string }[],
): unknown {
  const existing = documentFragments(document);
  if (
    edits.length !== existing.length ||
    new Set(edits.map((edit) => edit.id)).size !== edits.length ||
    edits.some(
      (edit) =>
        !existing.some((item) => item.id === edit.id) || /\0/.test(edit.value),
    )
  )
    throw new Error(
      'Rich text fragments changed or contain invalid text. Refresh or edit structure in Jira.',
    );
  const copy = structuredClone(document) as any;
  // Resolve paths before removing empty runs, so sibling indexes cannot shift.
  const nodes = edits.map((edit) => {
    let node = copy;
    let parent: any;
    let index = 0;
    for (const part of edit.id.split('.')) {
      parent = node;
      index = Number(part);
      node = node.content[index];
    }
    return { edit, node, parent };
  });
  for (const { edit, node } of nodes) node.text = edit.value;
  for (const { edit, parent, node } of nodes)
    if (!edit.value) {
      const index = parent.content.indexOf(node);
      if (index >= 0) parent.content.splice(index, 1);
    }
  return copy;
}
function effects(
  key: string,
  previous: string | null,
  next: string | null,
): string[] {
  return [
    `${key}: parent ${previous ?? 'none'} → ${next ?? 'none'}.`,
    ...(previous ? [`${key} leaves the child list of ${previous}.`] : []),
    ...(next
      ? [`${key} enters the child list of ${next}.`]
      : [`${key} becomes a top-level issue.`]),
    `Existing descendants remain attached to ${key} and follow its subtree. Open trees rooted at the old parent may lose this subtree; refresh all affected trees.`,
    'Issue key, status, and content stay the same. Sibling ordering is assigned by the provider.',
  ];
}
function revision(value: unknown) {
  return JSON.stringify(value);
}
function requireSamePlan(expected: ParentPlan, actual: ParentPlan) {
  if (
    expected.revision !== actual.revision ||
    expected.key !== actual.key ||
    expected.previousParent !== actual.previousParent ||
    expected.parentKey !== actual.parentKey
  )
    throw new Error(
      'The hierarchy changed since preview. Preview the change again.',
    );
}

export class GithubAuthoring {
  constructor(
    private request: Request,
    private path: (key: string, suffix?: string) => string,
    private normalize: (key: string) => string,
    private accountName?: string,
  ) {}
  private repo(key: string) {
    this.path(key);
    return key.split('#')[0];
  }
  private async issue(key: string) {
    const raw = await this.request(this.path(key));
    if (raw.pull_request)
      throw new Error(
        'Pull requests cannot use issue authoring. Open in GitHub.',
      );
    return raw;
  }
  private async parent(key: string): Promise<string | null> {
    try {
      const raw = await this.request(this.path(key, '/parent'));
      return this.normalize(raw.html_url);
    } catch (error) {
      if (
        (error as { status?: number })?.status === 404 ||
        /(?:returned|HTTP) 404\b/.test(message(error))
      )
        return null;
      throw error;
    }
  }
  async options(key: string): Promise<AuthoringOptions> {
    key = this.normalize(key);
    const repo = this.repo(key);
    const [raw, access] = await Promise.all([
      this.issue(key),
      this.request(`/repos/${repo}`),
    ]);
    const push =
      access.permissions?.push === true ||
      access.permissions?.admin === true ||
      access.permissions?.maintain === true;
    const triage = push || access.permissions?.triage === true;
    const fields: AuthoringField[] = [];
    const handoffs: string[] = [];
    if (push) {
      try {
        const milestones = await this.request(
          `/repos/${repo}/milestones?state=all&per_page=100`,
        );
        fields.push({
          id: 'milestone',
          name: 'Milestone',
          kind: 'choice',
          value: raw.milestone ? String(raw.milestone.number) : '',
          choices: milestones.map((item: any) => ({
            id: String(item.number),
            name: item.title,
          })),
        });
      } catch (error) {
        handoffs.push(
          `Milestone choices are unavailable: ${message(error)} Open in GitHub.`,
        );
      }
    }
    return {
      description: {
        editable:
          push ||
          (Boolean(this.accountName) &&
            raw.user?.login?.toLowerCase() === this.accountName?.toLowerCase()),
        value: String(raw.body ?? ''),
        revision: revision(raw.body ?? ''),
        reason:
          'Editing requires issue authorship or write access. Open in GitHub.',
      },
      comment: {
        allowed: !raw.locked || push,
        reason:
          raw.locked && !push
            ? 'This conversation is locked. Open in GitHub.'
            : undefined,
      },
      parent: {
        allowed: triage,
        reason: triage
          ? undefined
          : 'Parent changes require confirmed triage or write access. Open in GitHub.',
      },
      createChild: triage && access.has_issues !== false,
      fields,
      attachments: githubAttachments(String(raw.body ?? '')),
      handoffs: [
        ...handoffs,
        'Attachment uploads and repository transfers open in GitHub.',
        ...(push
          ? []
          : [
              'Milestone and label changes require push access; open in GitHub.',
            ]),
        'Additional milestones beyond the first 100 and GitHub Projects fields open in GitHub.',
      ],
    };
  }
  async plan(key: string, parentKey: string | null): Promise<ParentPlan> {
    key = this.normalize(key);
    parentKey = parentKey === null ? null : this.normalize(parentKey);
    const options = await this.options(key);
    if (!options.parent.allowed) throw new Error(options.parent.reason);
    const previous = await this.parent(key);
    if (parentKey === previous) throw new Error('Choose a different parent.');
    if (previous) this.path(previous);
    const raw = await this.issue(key);
    let target: any = null;
    const ancestry: unknown[] = [];
    if (parentKey) {
      if (this.repo(key).split('/')[0] !== this.repo(parentKey).split('/')[0])
        throw new Error(
          'GitHub sub-issues must have the same repository owner. Repository transfers open in GitHub.',
        );
      target = await this.issue(parentKey);
      const access = await this.request(`/repos/${this.repo(parentKey)}`);
      if (!(
        access.permissions?.triage ||
        access.permissions?.push ||
        access.permissions?.admin ||
        access.permissions?.maintain
      ))
        throw new Error(
          'The destination requires triage or write access. Open in GitHub.',
        );
      let cursor: string | null = parentKey;
      const visited = new Set<string>();
      while (cursor) {
        if (cursor === key || visited.has(cursor))
          throw new Error('This parent would create a hierarchy cycle.');
        if (visited.size >= 100)
          throw new Error(
            'The ancestry exceeds Canopy’s verification limit. Open in GitHub.',
          );
        visited.add(cursor);
        this.path(cursor);
        const next = await this.parent(cursor);
        ancestry.push([cursor, next]);
        cursor = next;
      }
    }
    return {
      key,
      parentKey,
      previousParent: previous,
      revision: revision([raw.id, previous, target?.id ?? null, ancestry]),
      effects: [
        ...effects(key, previous, parentKey),
        ...(parentKey
          ? [
              `Destination: ${parentKey} · ${target.title} (${this.repo(parentKey)}).`,
              'GitHub allows 100 direct sub-issues and eight nested levels. GitHub validates capacity and the moved subtree’s depth at Apply.',
            ]
          : []),
      ],
    };
  }
  async write(key: string, action: AuthoringAction): Promise<AuthoringResult> {
    key = this.normalize(key);
    let options: AuthoringOptions;
    try {
      options = await this.options(key);
    } catch (error) {
      return rejected(message(error));
    }
    if (action.kind === 'child') {
      if (!options.createChild)
        return rejected(
          'Sub-issue creation requires triage or write access. Open in GitHub.',
        );
      let raw: any;
      try {
        raw = await this.request(
          `/repos/${this.repo(key)}/issues`,
          json('POST', { title: action.summary, body: action.description }),
        );
      } catch (error) {
        return writeFailure(error);
      }
      let childKey: string;
      try {
        childKey = this.normalize(raw.html_url);
        this.path(childKey);
        if (!Number.isSafeInteger(raw.id)) throw new Error('Missing issue ID.');
      } catch {
        return {
          state: 'unknown',
          message:
            'GitHub created an issue but returned incomplete identity. Check the repository in GitHub before creating another.',
        };
      }
      try {
        await this.request(
          this.path(key, '/sub_issues'),
          json('POST', { sub_issue_id: raw.id }),
        );
      } catch (error) {
        return {
          state: 'partial',
          key: childKey,
          message: `Created ${childKey}; parent linking was not confirmed. ${message(error)} Refresh and use Change parent on ${childKey} to finish; do not create another issue.`,
        };
      }
      return {
        state: 'saved',
        key: childKey,
        message: `Created ${childKey} under ${key}. Refresh the hierarchy.`,
      };
    }
    let path = this.path(key),
      init: RequestInit;
    try {
      if (action.kind === 'description') {
        if (action.fragments)
          return rejected(
            'GitHub descriptions use Markdown, not Jira text fragments.',
          );
        if (!options.description.editable)
          return rejected(options.description.reason!);
        if (action.revision !== options.description.revision)
          return rejected(
            'Description changed since editing began. Refresh options and review your draft.',
          );
        init = json('PATCH', { body: action.value });
      } else if (action.kind === 'comment') {
        if (!options.comment.allowed) return rejected(options.comment.reason!);
        path += '/comments';
        init = json('POST', { body: action.value });
      } else if (action.kind === 'field') {
        const field = options.fields.find((field) => field.id === action.id);
        if (!field || field.value !== action.previous)
          return rejected(
            'Field access or value changed. Refresh options and review.',
          );
        if (
          action.value &&
          !field.choices?.some((choice) => choice.id === action.value)
        )
          return rejected('Choose an available milestone.');
        init = json('PATCH', {
          milestone: action.value ? Number(action.value) : null,
        });
      } else {
        const plan = await this.plan(key, action.plan.parentKey);
        requireSamePlan(action.plan, plan);
        const raw = await this.issue(key);
        if (!Number.isSafeInteger(raw.id))
          return rejected('GitHub did not return a valid issue ID.');
        path = this.path(
          plan.parentKey ?? plan.previousParent!,
          plan.parentKey ? '/sub_issues' : '/sub_issue',
        );
        init = json(plan.parentKey ? 'POST' : 'DELETE', {
          sub_issue_id: raw.id,
          ...(plan.parentKey ? { replace_parent: true } : {}),
        });
      }
    } catch (error) {
      return rejected(message(error));
    }
    let saved: any;
    try {
      saved = await this.request(path, init);
    } catch (error) {
      return writeFailure(error);
    }
    if (
      action.kind === 'field' &&
      String(saved?.milestone?.number ?? '') !== action.value
    )
      return {
        state: 'partial',
        message:
          'GitHub accepted the update but did not apply the milestone. Check push access and open in GitHub.',
      };
    if (action.kind === 'description' && saved?.body !== action.value)
      return {
        state: 'partial',
        message:
          'GitHub accepted the update but returned a different description. Refresh and review in GitHub.',
      };
    if (action.kind === 'comment' && !saved?.id)
      return {
        state: 'unknown',
        message:
          'GitHub accepted the comment but returned no comment ID. Check before retrying.',
      };
    if (action.kind === 'parent') {
      try {
        if ((await this.parent(key)) !== action.plan.parentKey)
          return {
            state: 'partial',
            message:
              'GitHub accepted the hierarchy write but has not reported the requested parent. Refresh and check before retrying.',
          };
      } catch (error) {
        return {
          state: 'partial',
          message: `GitHub accepted the hierarchy write; verification failed. ${message(error)} Refresh before retrying.`,
        };
      }
    }
    return {
      state: 'saved',
      message:
        'Saved. Refresh to see the provider’s current content and hierarchy.',
    };
  }
}

/** GitHub has no issue attachment REST collection; expose only known hosted assets. */
export function githubAttachments(
  body: string,
): AuthoringOptions['attachments'] {
  const urls =
    body.match(
      /https:\/\/(?:github\.com\/user-attachments\/[^\s<>"')\]]+|user-images\.githubusercontent\.com\/[^\s<>"')\]]+)/g,
    ) ?? [];
  return [...new Set(urls)].map((url, index) => ({
    id: String(index),
    name: new URL(url).pathname.split('/').at(-1) || `Attachment ${index + 1}`,
    url,
  }));
}

export class JiraAuthoring {
  constructor(
    private request: Request,
    private changed: (
      key: string,
      action: AuthoringAction,
    ) => Promise<void> = async () => {},
  ) {}
  private path(key: string, suffix = '') {
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key))
      throw new Error('Invalid Jira issue key.');
    return `/rest/api/3/issue/${key}${suffix}`;
  }
  private issue(key: string) {
    return this.request(
      `${this.path(key)}?fields=description,parent,project,issuetype,summary,attachment,labels,duedate,components,fixVersions`,
    );
  }
  private editable(meta: any, id: string) {
    return meta.fields?.[id]?.operations?.includes('set') === true;
  }
  async options(key: string): Promise<AuthoringOptions> {
    const [raw, meta, permissions] = await Promise.all([
      this.issue(key),
      this.request(this.path(key, '/editmeta')),
      this.request(
        `/rest/api/3/mypermissions?issueKey=${encodeURIComponent(key)}&permissions=EDIT_ISSUES,ADD_COMMENTS`,
      ),
    ]);
    const edit = permissions.permissions?.EDIT_ISSUES?.havePermission === true;
    const comment =
      permissions.permissions?.ADD_COMMENTS?.havePermission === true;
    const fields: AuthoringField[] = [];
    if (edit)
      for (const [id, kind] of [
        ['labels', 'text'],
        ['duedate', 'date'],
        ['components', 'choices'],
        ['fixVersions', 'choices'],
      ] as const) {
        if (!this.editable(meta, id) || !(id in (raw.fields ?? {}))) continue;
        const source = raw.fields?.[id];
        fields.push({
          id,
          name: meta.fields[id].name ?? id,
          kind,
          required: meta.fields[id].required === true,
          value:
            id === 'labels'
              ? (source ?? []).join(', ')
              : Array.isArray(source)
                ? source
                    .map((item: any) => String(item.id))
                    .sort()
                    .join(',')
                : String(source ?? ''),
          ...(kind === 'choices'
            ? {
                choices: (meta.fields[id].allowedValues ?? []).map(
                  (item: any) => ({ id: String(item.id), name: item.name }),
                ),
              }
            : {}),
        });
      }
    const plain = plainDocument(raw.fields?.description);
    const fragments = plain
      ? undefined
      : documentFragments(raw.fields?.description);
    const richEditable =
      fragments && fragments.length > 0 && fragments.length <= 500;
    const descriptionAvailable =
      'description' in (raw.fields ?? {}) &&
      revision(raw.fields.description ?? null).length <= 500_000;
    return {
      description: {
        editable:
          descriptionAvailable &&
          edit &&
          this.editable(meta, 'description') &&
          (plain || Boolean(richEditable)),
        value: documentText(raw.fields?.description),
        revision: revision(raw.fields?.description ?? null),
        ...(richEditable ? { fragments } : {}),
        reason: !descriptionAvailable
          ? 'This description is unavailable or exceeds Canopy’s editor limit. Open in Jira.'
          : !plain
            ? 'Edit text runs while preserving Jira formatting, mentions, and media. Structural changes open in Jira.'
            : !edit || !this.editable(meta, 'description')
              ? 'Description is unavailable on this account’s edit screen. Open in Jira.'
              : undefined,
      },
      comment: {
        allowed: comment,
        reason: comment
          ? undefined
          : 'Add comments permission is unavailable. Open in Jira.',
      },
      parent: {
        allowed: edit && this.editable(meta, 'parent'),
        reason:
          edit && this.editable(meta, 'parent')
            ? undefined
            : 'Parent is unavailable on this account’s edit screen. Open in Jira.',
      },
      createChild: false,
      fields,
      attachments: (raw.fields?.attachment ?? []).map((item: any) => ({
        id: String(item.id),
        name: String(item.filename),
        size: item.size,
        url: String(item.content),
      })),
      handoffs: [
        'Attachment uploads, project moves, issue type conversions, and other custom fields open in Jira.',
      ],
    };
  }
  async plan(key: string, parentKey: string | null): Promise<ParentPlan> {
    const options = await this.options(key);
    if (!options.parent.allowed) throw new Error(options.parent.reason);
    const raw = await this.issue(key),
      previous = raw.fields?.parent?.key ?? null;
    if (previous === parentKey) throw new Error('Choose a different parent.');
    const type = await this.request(
      `/rest/api/3/issuetype/${encodeURIComponent(raw.fields.issuetype.id)}`,
    );
    if (!Number.isInteger(type.hierarchyLevel))
      throw new Error(
        'Jira did not provide the hierarchy level. Open in Jira.',
      );
    if (!parentKey && type.hierarchyLevel < 0)
      throw new Error('Subtasks require a parent. Convert the issue in Jira.');
    let target: any = null;
    const ancestry: unknown[] = [];
    if (parentKey) {
      target = await this.issue(parentKey);
      if (raw.fields.project.id !== target.fields.project.id)
        throw new Error(
          'Cross-project moves require Jira’s move workflow. Open in Jira.',
        );
      const parentType = await this.request(
        `/rest/api/3/issuetype/${encodeURIComponent(target.fields.issuetype.id)}`,
      );
      if (parentType.hierarchyLevel !== type.hierarchyLevel + 1)
        throw new Error(
          'The destination must be exactly one hierarchy level above this issue. Open in Jira for conversions.',
        );
      let cursor: string | null = parentKey;
      const visited = new Set<string>();
      while (cursor) {
        if (cursor === key || visited.has(cursor))
          throw new Error('This parent would create a hierarchy cycle.');
        if (visited.size >= 100)
          throw new Error(
            'The ancestry exceeds Canopy’s verification limit. Open in Jira.',
          );
        visited.add(cursor);
        const ancestor: any =
          cursor === parentKey ? target : await this.issue(cursor);
        const next: string | null = ancestor.fields?.parent?.key ?? null;
        ancestry.push([cursor, next]);
        cursor = next;
      }
    }
    return {
      key,
      parentKey,
      previousParent: previous,
      revision: revision([
        raw.id,
        previous,
        raw.fields.project.id,
        raw.fields.issuetype.id,
        target?.id ?? null,
        target?.fields.issuetype.id ?? null,
        ancestry,
      ]),
      effects: [
        ...effects(key, previous, parentKey),
        ...(target
          ? [
              `Destination: ${parentKey} · ${target.fields.summary} (${target.fields.project.name ?? target.fields.project.id}).`,
            ]
          : []),
      ],
    };
  }
  async write(key: string, action: AuthoringAction): Promise<AuthoringResult> {
    let path = this.path(key),
      init: RequestInit;
    try {
      const options = await this.options(key);
      if (action.kind === 'child')
        return rejected('Use Create child issue for Jira’s creation screen.');
      if (action.kind === 'comment') {
        if (!options.comment.allowed) return rejected(options.comment.reason!);
        path += '/comment';
        init = json('POST', { body: textDocument(action.value) });
      } else {
        const fields: Record<string, unknown> = {};
        const update: Record<string, unknown> = {};
        if (action.kind === 'description') {
          if (!options.description.editable)
            return rejected(options.description.reason!);
          if (action.revision !== options.description.revision)
            return rejected(
              'Description changed since editing began. Refresh options and review your draft.',
            );
          if (options.description.fragments) {
            if (!action.fragments)
              return rejected(
                'Rich Jira descriptions require text run edits. Open in Jira for structural changes.',
              );
            fields.description = editDocumentFragments(
              JSON.parse(options.description.revision),
              action.fragments,
            );
          } else {
            if (action.fragments)
              return rejected(
                'The description format changed. Refresh and review.',
              );
            fields.description = textDocument(action.value);
          }
        } else if (action.kind === 'parent') {
          const plan = await this.plan(key, action.plan.parentKey);
          requireSamePlan(action.plan, plan);
          if (plan.parentKey) fields.parent = { key: plan.parentKey };
          else update.parent = [{ set: { none: true } }];
        } else {
          const field = options.fields.find((field) => field.id === action.id);
          if (!field || field.value !== action.previous)
            return rejected(
              'Field access or value changed. Refresh options and review.',
            );
          if (field.required && !action.value.trim())
            return rejected(`${field.name} is required.`);
          if (field.kind === 'choices') {
            const ids = action.value ? action.value.split(',') : [];
            if (
              ids.some(
                (id) => !field.choices?.some((choice) => choice.id === id),
              )
            )
              return rejected('Choose available field values.');
            fields[field.id] = ids.map((id) => ({ id }));
          } else if (field.id === 'labels') {
            const labels = action.value
              .split(',')
              .map((label) => label.trim())
              .filter(Boolean);
            if (labels.some((label) => /\s/.test(label)))
              return rejected(
                'Jira labels cannot contain spaces. Separate labels with commas.',
              );
            fields.labels = [...new Set(labels)];
          } else {
            if (action.value && !/^\d{4}-\d{2}-\d{2}$/.test(action.value))
              return rejected('Enter a date as YYYY-MM-DD.');
            fields[field.id] = action.value || null;
          }
        }
        init = json('PUT', {
          fields,
          ...(Object.keys(update).length ? { update } : {}),
        });
      }
    } catch (error) {
      return rejected(message(error));
    }
    let saved: any;
    try {
      saved = await this.request(path, init);
    } catch (error) {
      return writeFailure(error);
    }
    if (action.kind === 'comment')
      return saved?.id
        ? { state: 'saved', message: `Comment ${saved.id} saved.` }
        : {
            state: 'unknown',
            message:
              'Jira accepted the comment but returned no comment ID. Check before retrying.',
          };
    try {
      await this.changed(key, action);
      const current = await this.options(key);
      const matches =
        action.kind === 'description'
          ? current.description.revision ===
            revision(
              action.fragments
                ? editDocumentFragments(
                    JSON.parse(action.revision),
                    action.fragments,
                  )
                : textDocument(action.value),
            )
          : action.kind === 'parent'
            ? (await this.issue(key)).fields?.parent?.key ===
              (action.plan.parentKey ?? undefined)
            : current.fields.find((field) => field.id === action.id)?.value ===
              (action.id === 'labels'
                ? [
                    ...new Set(
                      action.value
                        .split(',')
                        .map((label) => label.trim())
                        .filter(Boolean),
                    ),
                  ].join(', ')
                : action.value);
      return matches
        ? { state: 'saved', message: 'Saved and verified.' }
        : {
            state: 'partial',
            message:
              'Jira accepted the update but has not returned the requested value. Refresh and review before retrying.',
          };
    } catch (error) {
      return {
        state: 'partial',
        message: `Jira accepted the write; refresh verification failed. ${message(error)} Refresh before retrying.`,
      };
    }
  }
}
