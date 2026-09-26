import type {
  EditOptions,
  Status,
  StatusTransitionTree,
} from '../shared/types';

export type StatusPath = {
  destination: Status;
  steps: { id: string; to: Status }[];
};

// Breadth-first traversal keeps one shortest, cycle-free path per destination.
export function statusPaths(
  current: Status,
  direct: EditOptions['transitions'],
  graph: StatusTransitionTree,
  maxSteps = 4,
): StatusPath[] {
  const found = new Map<string, StatusPath>();
  const directStatuses = new Set(
    direct
      .filter((choice) => !choice.requiresFields)
      .map((choice) => choice.to?.id),
  );
  const queued = new Set([current.id]);
  const queue: {
    status: Status;
    steps: StatusPath['steps'];
    visited: Set<string>;
  }[] = [{ status: current, steps: [], visited: new Set([current.id]) }];
  for (let index = 0; index < queue.length; index++) {
    const { status, steps, visited } = queue[index];
    if (steps.length >= maxSteps) continue;
    const choices = steps.length === 0 ? direct : (graph[status.id] ?? []);
    for (const choice of choices) {
      if (!choice.to || choice.requiresFields || visited.has(choice.to.id))
        continue;
      const next = [...steps, { id: choice.id, to: choice.to }];
      if (
        next.length > 1 &&
        !directStatuses.has(choice.to.id) &&
        !found.has(choice.to.id)
      )
        found.set(choice.to.id, { destination: choice.to, steps: next });
      if (next.length < maxSteps && !queued.has(choice.to.id)) {
        queued.add(choice.to.id);
        queue.push({
          status: choice.to,
          steps: next,
          visited: new Set([...visited, choice.to.id]),
        });
      }
    }
  }
  return [...found.values()];
}
