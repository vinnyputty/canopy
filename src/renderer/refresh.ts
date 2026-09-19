export const ACTIVE_REFRESH_MS = 30_000;
export const MAX_BACKGROUND_REFRESH_MS = 60 * 60_000;

type Entry = {
  active: boolean;
  interval: number;
  due: number;
  started: number;
  inflight: boolean;
};

/** One schedule per tab, shared by timers, activation, focus, and retry. */
export class RefreshSchedule {
  private entries = new Map<string, Entry>();

  sync(ids: string[], activeId: string | null, now: number): string[] {
    const activated: string[] = [];
    for (const id of this.entries.keys()) {
      if (!ids.includes(id)) this.entries.delete(id);
    }
    for (const id of ids) {
      const active = id === activeId;
      const entry = this.entries.get(id);
      if (!entry) {
        this.entries.set(id, {
          active,
          interval: active ? ACTIVE_REFRESH_MS : ACTIVE_REFRESH_MS * 2,
          due: now,
          started: -Infinity,
          inflight: false,
        });
      } else if (entry.active !== active) {
        entry.active = active;
        entry.interval = active ? ACTIVE_REFRESH_MS : ACTIVE_REFRESH_MS * 2;
        entry.due = now + entry.interval;
        // The first background wait is already scheduled. A request that is
        // still running instead schedules that first wait when it completes.
        if (!active && !entry.inflight) entry.interval *= 2;
        if (active) activated.push(id);
      }
    }
    return activated;
  }

  forget(id: string): void {
    this.entries.delete(id);
  }

  due(now: number): string[] {
    return [...this.entries]
      .filter(([, entry]) => !entry.inflight && entry.due <= now)
      .map(([id]) => id);
  }

  begin(id: string, now: number, explicit = false): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.inflight || (!explicit && now - entry.started < 1000))
      return false;
    entry.inflight = true;
    entry.started = now;
    return true;
  }

  finish(id: string, now: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.inflight = false;
    entry.due = now + entry.interval;
    if (!entry.active)
      entry.interval = Math.min(entry.interval * 2, MAX_BACKGROUND_REFRESH_MS);
  }
}
