import type { Connection } from '../shared/types';

// Auth retains each connection object until its credentials are replaced.
export class Providers<T> {
  private entries = new Map<string, { connection: Connection; provider: T }>();
  constructor(
    private connections: () => Connection[],
    private create: (connection: Connection, current: () => void) => T,
  ) {}
  get(id: string): T {
    const connection = this.connections().find((value) => value.id === id);
    if (!connection) {
      this.entries.delete(id);
      throw new Error(
        'This connection is unavailable. Connect the account again.',
      );
    }
    const entry = this.entries.get(id);
    if (entry?.connection === connection) return entry.provider;
    const current = () => {
      if (this.connections().find((value) => value.id === id) !== connection)
        throw new Error('This connection changed. Open the picker again.');
    };
    const provider = this.create(connection, current);
    this.entries.set(id, { connection, provider });
    return provider;
  }
  remove(id: string) {
    this.entries.delete(id);
  }
  reconcile() {
    const current = this.connections();
    for (const [id, entry] of this.entries)
      if (!current.includes(entry.connection)) this.entries.delete(id);
  }
}
