import type { Choice, IssuePatch } from '../../src/shared/types';
import { DemoProvider } from '../../src/main/demo-provider';

type Operation =
  | 'tree'
  | 'update'
  | 'rank'
  | 'priorities'
  | 'transitions'
  | 'assignees'
  | 'validateAssignee'
  | 'cachedUsers';
type Gate = {
  operation: Operation;
  key: string;
  started: boolean;
  wait: Promise<void>;
  release: (error?: string) => void;
};

// Only the smoke entry point installs these controls. Gates delay real fixture
// operations through IPC, so renderer tests observe pending and failed requests.
export class ControlledDemoProvider extends DemoProvider {
  retryAt: number | null = null;
  private gates = new Map<string, Gate>();
  private completedGates = new Set<string>();
  readonly calls: { operation: Operation; key: string; patch?: IssuePatch }[] =
    [];
  hold(id: string, operation: Operation, key: string) {
    let release!: Gate['release'];
    const wait = new Promise<void>((resolve, reject) => {
      release = (error) => (error ? reject(new Error(error)) : resolve());
    });
    this.completedGates.delete(id);
    this.gates.set(id, { operation, key, started: false, wait, release });
  }
  started(id: string) {
    return this.gates.get(id)?.started ?? false;
  }
  completed(id: string) {
    return this.completedGates.has(id);
  }
  release(id: string, error?: string) {
    const gate = this.gates.get(id);
    if (!gate?.started) throw new Error(`Gate ${id} has not started.`);
    gate.release(error);
    this.gates.delete(id);
  }
  private async pause(operation: Operation, key: string, patch?: IssuePatch) {
    this.calls.push({ operation, key, patch });
    const entry = [...this.gates.entries()].find(
      ([, value]) =>
        !value.started && value.operation === operation && value.key === key,
    );
    if (entry) {
      const [id, gate] = entry;
      gate.started = true;
      await gate.wait;
      this.completedGates.add(id);
    }
  }
  rankingState?: 'supported' | 'unsupported' | 'unknown';
  override async tree(key: string) {
    const snapshot = await super.tree(key);
    if (this.rankingState)
      snapshot.ranking = {
        state: this.rankingState,
        issueKeys:
          this.rankingState === 'supported'
            ? (snapshot.ranking?.issueKeys ?? [])
            : [],
      };
    await this.pause('tree', key);
    return snapshot;
  }
  override async update(key: string, patch: IssuePatch) {
    await this.pause('update', key, patch);
    return super.update(key, patch);
  }
  override async rank(
    key: string,
    anchor: string,
    position: 'before' | 'after' = 'before',
  ) {
    await this.pause('rank', key);
    return super.rank(key, anchor, position);
  }
  remoteUpdate(key: string, patch: IssuePatch) {
    return super.update(key, patch);
  }
  unassignableUsers = new Set<string>();
  override async priorities(key: string, refresh = false) {
    await this.pause('priorities', key);
    return super.priorities(key, refresh);
  }
  override async cachedUsers() {
    await this.pause('cachedUsers', '');
    return super.cachedUsers();
  }
  assigneeSearchResults = new Map<string, Choice[]>();
  override async assignees(
    key: string,
    query = '',
    startAt = 0,
    refresh = false,
  ) {
    await this.pause('assignees', key);
    const users = this.assigneeSearchResults.get(query);
    if (users) return { users };
    return super.assignees(key, query, startAt, refresh);
  }
  override async validateAssignee(
    key: string,
    accountId: string,
    refresh = false,
  ) {
    await this.pause('validateAssignee', key);
    if (this.unassignableUsers.has(accountId)) return null;
    return super.validateAssignee(key, accountId, refresh);
  }
  blockedTransitions = new Set<string>();
  override async transitions(key: string, refresh = false) {
    await this.pause('transitions', key);
    const choices = await super.transitions(key, refresh);
    return choices.map((choice) => ({
      ...choice,
      requiresFields: this.blockedTransitions.has(choice.id),
    }));
  }
}
