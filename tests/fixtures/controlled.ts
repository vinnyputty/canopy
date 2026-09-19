import type { IssuePatch } from '../../src/shared/types';
import { DemoProvider } from './demo';

type Operation = 'tree' | 'update' | 'rank';
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
  private gates = new Map<string, Gate>();
  readonly calls: { operation: Operation; key: string; patch?: IssuePatch }[] =
    [];
  hold(id: string, operation: Operation, key: string) {
    let release!: Gate['release'];
    const wait = new Promise<void>((resolve, reject) => {
      release = (error) => (error ? reject(new Error(error)) : resolve());
    });
    this.gates.set(id, { operation, key, started: false, wait, release });
  }
  started(id: string) {
    return this.gates.get(id)?.started ?? false;
  }
  release(id: string, error?: string) {
    const gate = this.gates.get(id);
    if (!gate?.started) throw new Error(`Gate ${id} has not started.`);
    gate.release(error);
    this.gates.delete(id);
  }
  private async pause(operation: Operation, key: string, patch?: IssuePatch) {
    this.calls.push({ operation, key, patch });
    const gate = [...this.gates.values()].find(
      (value) =>
        !value.started && value.operation === operation && value.key === key,
    );
    if (gate) {
      gate.started = true;
      await gate.wait;
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
  blockedTransitions = new Set<string>();
  override async editOptions(key: string, query = '') {
    const options = await super.editOptions(key, query);
    return {
      ...options,
      transitions: options.transitions.map((choice) => ({
        ...choice,
        requiresFields: this.blockedTransitions.has(choice.id),
      })),
    };
  }
}
