import type {
  CanopyAPI,
  Choice,
  Connection,
  EditOptions,
  Issue,
  IssuePatch,
} from '../shared/types';
import { issueKeyAndSummary } from './copy-issue';

export type BulkAction = 'assignee' | 'priority' | 'status';
export type BulkCandidate = {
  issue: Issue;
  patch?: IssuePatch;
  reason?: string;
};
export type BulkChoice = Choice & { category?: Issue['status']['category'] };
export type BulkResult = {
  issue: Issue;
  state: 'pending' | 'saved' | 'failed' | 'undoing' | 'undo-failed' | 'undone';
  reason?: string;
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function copySelectedIssues(
  api: Pick<CanopyAPI, 'copyText'>,
  issues: Issue[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await api.copyText(issues.map(issueKeyAndSummary).join('\n'));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function bulkChoices(
  api: CanopyAPI,
  connection: Connection,
  issues: Issue[],
  action: BulkAction,
): Promise<BulkChoice[]> {
  if (action === 'assignee') return [];
  const choices: BulkChoice[][] = await Promise.all(
    issues.map(async (issue) => {
      try {
        if (action === 'priority')
          return (await api.priorities(connection.id, issue.key, true)).map(
            (choice) => ({ ...choice }),
          );
        return (await api.transitions(connection.id, issue.key, true))
          .filter((choice) => !choice.requiresFields)
          .map((choice) =>
            connection.provider === 'github'
              ? { id: choice.id, name: choice.name }
              : choice.to
                ? {
                    id: choice.to.id,
                    name: choice.to.name,
                    category: choice.to.category,
                  }
                : null,
          )
          .filter((choice): choice is BulkChoice => choice !== null);
      } catch {
        return [];
      }
    }),
  );
  if (action === 'priority')
    return [
      ...new Map(choices.flat().map((choice) => [choice.id, choice])).values(),
    ];
  const [first = [], ...rest] = choices;
  return first.filter((choice) =>
    rest.every((list) =>
      list.some(
        (other) => other.id === choice.id && other.category === choice.category,
      ),
    ),
  );
}

export async function planBulk(
  api: CanopyAPI,
  connection: Connection,
  issues: Issue[],
  action: BulkAction,
  choice: BulkChoice | null,
): Promise<BulkCandidate[]> {
  return Promise.all(
    issues.map(async (issue): Promise<BulkCandidate> => {
      if (connection.provider === 'github' && issue.type === 'Repository')
        return { issue, reason: 'Repository rows cannot be edited.' };
      try {
        if (action === 'assignee') {
          if (choice) {
            const valid = await api.validateAssignee(
              connection.id,
              issue.key,
              choice.id,
              true,
            );
            if (!valid)
              return {
                issue,
                reason: 'This person is not assignable to this issue.',
              };
          }
          return { issue, patch: { assigneeId: choice?.id ?? null } };
        }
        if (action === 'priority') {
          if (!choice || connection.provider === 'github')
            return {
              issue,
              reason: 'Priority is unavailable for this provider.',
            };
          const values = await api.priorities(connection.id, issue.key, true);
          return values.some((value) => value.id === choice.id)
            ? { issue, patch: { priorityId: choice.id } }
            : { issue, reason: 'This priority is unavailable for this issue.' };
        }
        if (!choice) return { issue, reason: 'Choose a status.' };
        const values: EditOptions['transitions'] = await api.transitions(
          connection.id,
          issue.key,
          true,
        );
        const transition = values.find(
          (value) =>
            !value.requiresFields &&
            (connection.provider === 'github'
              ? value.id === choice.id
              : value.to?.id === choice.id &&
                value.to.category === choice.category),
        );
        return transition
          ? { issue, patch: { transitionId: transition.id } }
          : {
              issue,
              reason: 'No valid transition to this status is available.',
            };
      } catch (error) {
        return { issue, reason: message(error) };
      }
    }),
  );
}

export async function executeBulkIssue(
  api: CanopyAPI,
  connection: Connection,
  issue: Issue,
  action: BulkAction,
  choice: BulkChoice | null,
  update: (
    key: string,
    patch: IssuePatch,
    choice: BulkChoice | null,
  ) => Promise<boolean>,
): Promise<BulkResult> {
  try {
    const [candidate] = await planBulk(
      api,
      connection,
      [issue],
      action,
      choice,
    );
    if (!candidate?.patch)
      return {
        issue,
        state: 'failed',
        reason: candidate?.reason ?? 'This action is unavailable.',
      };
    const saved = await update(issue.key, candidate.patch, choice);
    return {
      issue,
      state: saved ? 'saved' : 'failed',
      reason: saved
        ? undefined
        : 'The update was rejected. Review the issue and retry.',
    };
  } catch (error) {
    return { issue, state: 'failed', reason: message(error) };
  }
}
