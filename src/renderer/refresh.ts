import type { TreeSnapshot } from '../shared/types';

export const ACTIVE_REFRESH_MS = 30_000;
export const MAX_BACKGROUND_REFRESH_MS = 60 * 60_000;

type RootLoad<T> = {
  promise: Promise<T>;
  generation: number;
  started: boolean;
};

type RootEntry<T> = {
  inflight?: Promise<T>;
  inflightExplicit?: boolean;
  generation: number;
  lastSuccess?: number;
  snapshot?: T;
};

/** Shares tree reads and their minimum automatic interval across duplicate tabs. */
export class RootRefreshGate<T> {
  private roots = new Map<string, RootEntry<T>>();
  private nextGeneration = 0;

  constructor(private now: () => number = Date.now) {}

  load(
    key: string,
    explicit: boolean,
    needsSnapshot: boolean,
    fetch: () => Promise<T>,
  ): RootLoad<T> | { due: number } {
    const root = this.roots.get(key) ?? { generation: 0 };
    if (root.inflight && (!explicit || root.inflightExplicit))
      return {
        promise: root.inflight,
        generation: root.generation,
        started: false,
      };
    const due = (root.lastSuccess ?? -Infinity) + ACTIVE_REFRESH_MS;
    if (!root.inflight && !explicit && this.now() < due) {
      if (needsSnapshot && root.snapshot !== undefined)
        return {
          promise: Promise.resolve(root.snapshot),
          generation: root.generation,
          started: false,
        };
      return { due };
    }
    const request = () => {
      try {
        return fetch();
      } catch (error) {
        return Promise.reject<T>(error);
      }
    };
    const previous = root.inflight;
    const promise = previous ? previous.then(request, request) : request();
    const generation = ++this.nextGeneration;
    root.inflight = promise;
    root.inflightExplicit = explicit;
    root.generation = generation;
    this.roots.set(key, root);
    void promise
      .then(
        (snapshot) => {
          if (root.generation !== generation) return;
          root.snapshot = snapshot;
          root.lastSuccess = this.now();
        },
        () => {},
      )
      .finally(() => {
        if (root.inflight === promise) {
          root.inflight = undefined;
          root.inflightExplicit = undefined;
        }
      });
    return { promise, generation, started: true };
  }

  isCurrent(key: string, generation: number): boolean {
    return this.roots.get(key)?.generation === generation;
  }

  retain(keys: string[]): void {
    const active = new Set(keys);
    for (const [key, root] of this.roots)
      if (!active.has(key) && !root.inflight) this.roots.delete(key);
  }

  forget(key: string): void {
    this.roots.delete(key);
  }
}

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

  sync(
    ids: string[],
    activeId: string | null | readonly string[],
    now: number,
  ): string[] {
    const activated: string[] = [];
    for (const id of this.entries.keys()) {
      if (!ids.includes(id)) this.entries.delete(id);
    }
    for (const id of ids) {
      const active = Array.isArray(activeId)
        ? activeId.includes(id)
        : id === activeId;
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

  defer(id: string, due: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.inflight = false;
    entry.due = Math.max(entry.due, due);
  }
}

export type RefreshAnnouncement = {
  tabId: string;
  scope: number;
  text: string;
};
type AnnouncementRequest = {
  tabId: string;
  scope: number;
  manual: boolean;
  previous?: TreeSnapshot;
};

// Scheduling may force an automatic recovery. Only a user action requests speech.
export class RefreshAnnouncements {
  private activeTabId: string | null = null;
  scope = 0;
  private requested = new Set<string>();
  private running = new Map<string, AnnouncementRequest>();
  private failures = new Set<string>();

  constructor(private publish: (message: RefreshAnnouncement) => void) {}

  activate(tabId: string | null) {
    if (this.activeTabId !== tabId) {
      this.activeTabId = tabId;
      this.scope++;
    }
  }

  request(tabId: string) {
    if (!this.running.get(tabId)?.manual) this.requested.add(tabId);
    return this.requested.has(tabId);
  }

  begin(tabId: string, rootKey: string, previous?: TreeSnapshot) {
    const request = {
      tabId,
      scope: this.scope,
      manual: this.requested.delete(tabId),
      previous,
    };
    this.running.set(tabId, request);
    if (request.manual || !previous)
      this.emit(request, `Checking ${rootKey} for changes`);
    return request;
  }

  complete(request: AnnouncementRequest, next: TreeSnapshot) {
    if (this.running.get(request.tabId) !== request) return;
    const recovered = this.failures.delete(request.tabId);
    const content = ({ fetchedAt: _timestamp, ...data }: TreeSnapshot) =>
      JSON.stringify(data);
    const changed =
      !!request.previous && content(request.previous) !== content(next);
    if (request.manual || recovered || !request.previous || changed)
      this.emit(
        request,
        `${!request.manual && changed ? 'Changes found. ' : ''}${next.rootKey}: ${next.issues.length} issues, last updated at ${new Date(next.fetchedAt).toLocaleTimeString()}`,
      );
    this.running.delete(request.tabId);
  }

  // A current root generation can also deliver to another tab for that root.
  receive(tabId: string, next: TreeSnapshot, previous?: TreeSnapshot) {
    const request = this.running.get(tabId) ?? {
      tabId,
      scope: this.scope,
      manual: false,
      previous,
    };
    this.running.set(tabId, request);
    this.complete(request, next);
  }

  fail(request: AnnouncementRequest, rootKey: string, error: string) {
    if (this.running.get(request.tabId) !== request) return;
    this.failures.add(request.tabId);
    const retained = request.previous
      ? `; ${request.previous.issues.length} issues retained, last updated at ${new Date(request.previous.fetchedAt).toLocaleTimeString()}`
      : '';
    this.emit(request, `Couldn’t refresh ${rootKey}: ${error}${retained}`);
    this.running.delete(request.tabId);
  }

  end(request: AnnouncementRequest) {
    if (this.running.get(request.tabId) === request) {
      if (request.manual || !request.previous) this.emit(request, '');
      this.running.delete(request.tabId);
    }
  }

  forget(tabId: string) {
    this.requested.delete(tabId);
    this.running.delete(tabId);
    this.failures.delete(tabId);
  }

  private emit(request: AnnouncementRequest, text: string) {
    if (request.tabId === this.activeTabId && request.scope === this.scope)
      this.publish({ tabId: request.tabId, scope: request.scope, text });
  }
}
