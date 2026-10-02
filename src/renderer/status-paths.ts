import type {
  EditOptions,
  Status,
  StatusTransitionTree,
} from '../shared/types';

export type StatusPath = {
  destination: Status;
  steps: { id: string; to: Status }[];
};
export type StatusRoutes = { routes: StatusPath[]; truncated: boolean };

// Bound short simple routes so a dense workflow cannot stall the menu.
export function statusPaths(
  current: Status,
  direct: EditOptions['transitions'],
  graph: StatusTransitionTree,
  maxSteps = 4,
): StatusRoutes {
  const maxStates = 5000;
  const maxEdges = 20000;
  const maxRoutes = 80;
  const maxPerDestinationAndLength = 4;
  const found = new Map<string, Map<number, StatusPath[]>>();
  const discovered: StatusPath[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let consideredEdges = 0;
  const queue: {
    status: Status;
    steps: StatusPath['steps'];
    visited: Set<string>;
  }[] = [{ status: current, steps: [], visited: new Set([current.id]) }];
  outer: for (let index = 0; index < queue.length; index++) {
    const { status, steps, visited } = queue[index];
    if (steps.length >= maxSteps) continue;
    const choices = steps.length === 0 ? direct : (graph[status.id] ?? []);
    for (const choice of choices) {
      if (++consideredEdges > maxEdges) {
        truncated = true;
        break outer;
      }
      if (!choice.to || choice.requiresFields || visited.has(choice.to.id))
        continue;
      const next = [...steps, { id: choice.id, to: choice.to }];
      const sequence = JSON.stringify([
        current.id,
        ...next.map((step) => step.to.id),
      ]);
      if (seen.has(sequence)) continue;
      seen.add(sequence);
      if (next.length > 1) {
        let lengths = found.get(choice.to.id);
        if (!lengths) {
          lengths = new Map();
          found.set(choice.to.id, lengths);
        }
        const routes = lengths.get(next.length) ?? [];
        if (routes.length < maxPerDestinationAndLength) {
          const route = { destination: choice.to, steps: next };
          routes.push(route);
          discovered.push(route);
          lengths.set(next.length, routes);
        } else truncated = true;
      }
      if (next.length < maxSteps) {
        if (queue.length < maxStates)
          queue.push({
            status: choice.to,
            steps: next,
            visited: new Set([...visited, choice.to.id]),
          });
        else truncated = true;
      }
    }
  }
  const routes = [...found.values()].flatMap((lengths) =>
    [...lengths.values()].flat(),
  );
  // There is no default-path metadata. Prefer the longest retained routes;
  // stable ties follow transition discovery order. Rank each status once, at
  // its first encounter, while preserving alternate routes within a destination.
  const rank = new Map<string, number>();
  discovered.sort((a, b) => b.steps.length - a.steps.length);
  for (const route of discovered)
    for (const step of route.steps)
      if (!rank.has(step.to.id)) rank.set(step.to.id, rank.size);
  routes.sort(
    (a, b) => rank.get(a.destination.id)! - rank.get(b.destination.id)!,
  );
  if (routes.length > maxRoutes) truncated = true;
  return { routes: routes.slice(0, maxRoutes), truncated };
}
