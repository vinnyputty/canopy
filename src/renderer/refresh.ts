import type { TreeSnapshot } from '../shared/types';

// Electron wraps this rejected invoke; present the provider's tree failure in
// the visible alert and the live region without speaking transport internals.
export function treeRefreshError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = "Error invoking remote method 'canopy:tree': Error: ";
  return message.startsWith(prefix) && message.length > prefix.length
    ? message.slice(prefix.length)
    : message;
}

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

export function refreshDestination(tabId: string | null, savedViewId?: string) {
  return savedViewId ? JSON.stringify(['saved-view', savedViewId]) : tabId;
}

export type RefreshView = {
  name: string;
  roots: { id: string; label: string; tabIds: string[] }[];
};

type ViewOutcome = { error?: string; warnings?: string[] };
type ViewRequest = ViewOutcome & {
  request?: AnnouncementRequest;
  tabId?: string;
  settled: boolean;
};

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
  private requested = new Map<string, number>();
  private view?: RefreshView;
  private membership = '';
  private viewText?: string;
  private batch?: Map<string, ViewRequest>;
  private outcomes = new Map<string, ViewOutcome>();
  private affected = new Set<string>();
  private changed = false;
  private changedAt = 0;
  private recovered = false;
  private running = new Map<string, AnnouncementRequest>();
  private failures = new Set<string>();

  constructor(private publish: (message: RefreshAnnouncement) => void) {}

  activate(destination: string | null, view?: RefreshView) {
    const membership = JSON.stringify(
      view?.roots.map((root) => root.id).sort() ?? [],
    );
    if (this.activeTabId !== destination || this.membership !== membership) {
      this.activeTabId = destination;
      this.membership = membership;
      this.scope++;
      this.batch = undefined;
      this.viewText = undefined;
      this.outcomes.clear();
      this.affected.clear();
      this.changed = this.recovered = false;
      this.changedAt = 0;
    }
    this.view = view;
  }

  requestView() {
    if (!this.view || this.batch) return false;
    this.batch = new Map(
      this.view.roots.map((root) => [
        root.id,
        { settled: false, tabId: root.tabIds[0] },
      ]),
    );
    this.reportView();
    return true;
  }

  request(tabId: string) {
    const running = this.running.get(tabId);
    if (!running?.manual || running.scope !== this.scope)
      this.requested.set(tabId, this.scope);
    return this.requested.has(tabId);
  }

  begin(tabId: string, rootKey: string, previous?: TreeSnapshot) {
    const requestedScope = this.requested.get(tabId);
    this.requested.delete(tabId);
    const request = {
      tabId,
      scope: requestedScope ?? this.scope,
      manual: requestedScope !== undefined,
      previous,
    };
    this.running.set(tabId, request);
    const root = this.viewRoot(request);
    if (root) {
      const pending = this.batch?.get(root.id);
      if (request.manual && pending && !pending.settled) {
        pending.request = request;
        this.reportView();
      }
    } else if (!this.view && (request.manual || !previous))
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
    const root = this.viewRoot(request);
    if (root) {
      const outcome = { warnings: next.warnings };
      this.outcomes.set(root.id, outcome);
      const pending = this.batch?.get(root.id);
      if (pending?.request === request)
        Object.assign(pending, outcome, { error: undefined, settled: true });
      else if (changed || recovered || !request.previous) {
        this.affected.add(root.id);
        this.changed ||= changed;
        if (changed) this.changedAt = Math.max(this.changedAt, next.fetchedAt);
        this.recovered ||= recovered;
      }
    } else if (
      !this.view &&
      (request.manual || recovered || !request.previous || changed)
    )
      this.emit(
        request,
        `${!request.manual && changed ? 'Changes found. ' : ''}${next.rootKey}: ${next.issues.length} issues, last updated at ${new Date(next.fetchedAt).toLocaleTimeString()}`,
      );
    this.running.delete(request.tabId);
    this.reportView();
  }

  // A current root generation can also deliver to another tab for that root.
  receive(
    tabId: string,
    next: TreeSnapshot,
    previous?: TreeSnapshot,
    scope = this.scope,
  ) {
    const request = this.running.get(tabId) ?? {
      tabId,
      scope,
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
    const text = `Couldn’t refresh ${rootKey}: ${error}${retained}`;
    const root = this.viewRoot(request);
    if (root) {
      this.outcomes.set(root.id, { error: text });
      const pending = this.batch?.get(root.id);
      if (pending?.request === request)
        Object.assign(pending, {
          error: text,
          warnings: undefined,
          settled: true,
        });
      else this.affected.add(root.id);
    } else if (!this.view) this.emit(request, text);
    this.running.delete(request.tabId);
    this.reportView();
  }

  end(request: AnnouncementRequest) {
    if (this.running.get(request.tabId) === request) {
      const root = this.viewRoot(request);
      const pending = root && this.batch?.get(root.id);
      if (pending && pending.request === request) {
        pending.settled = true;
        pending.error = `${root.label}: refresh interrupted`;
      } else if (!this.view && (request.manual || !request.previous))
        this.emit(request, '');
      this.running.delete(request.tabId);
      this.reportView();
    }
  }

  forget(tabId: string) {
    const running = this.running.get(tabId);
    if (this.view && running) this.end(running);
    for (const [id, pending] of this.batch ?? []) {
      if (!pending.settled && pending.tabId === tabId) {
        pending.settled = true;
        pending.error = `${this.view?.roots.find((root) => root.id === id)?.label ?? id}: refresh interrupted`;
      }
    }
    this.reportView();
    this.requested.delete(tabId);
    this.running.delete(tabId);
    this.failures.delete(tabId);
  }

  private viewRoot(request: AnnouncementRequest) {
    return request.scope === this.scope
      ? this.view?.roots.find((root) => root.tabIds.includes(request.tabId))
      : undefined;
  }

  private reportView() {
    if (!this.view || this.activeTabId === null) return;
    const rootNoun = (count: number) => (count === 1 ? 'root' : 'roots');
    let text: string;
    if (this.batch) {
      const pending = [...this.batch.values()].filter((root) => !root.settled);
      const waiting = pending.filter((root) => !root.request).length;
      const errors = [...this.batch.values()].flatMap((root) =>
        root.error ? [root.error] : [],
      );
      const partial = this.view.roots.flatMap((root) => {
        const warnings = this.batch?.get(root.id)?.warnings ?? [];
        return warnings.length ? [`${root.label}: ${warnings.join('; ')}`] : [];
      });
      text =
        this.batch.size === 0
          ? `${this.view.name}: no roots selected to refresh.`
          : pending.length
            ? `${waiting === pending.length ? 'Waiting to refresh' : 'Refreshing'} ${this.view.name}: ${pending.length} of ${this.batch.size} ${rootNoun(this.batch.size)} pending${waiting ? `; ${waiting} waiting to start` : ''}.`
            : `${this.view.name}: refreshed ${this.batch.size - errors.length} of ${this.batch.size} ${rootNoun(this.batch.size)}.`;
      if (errors.length)
        text += ` ${errors.length} ${rootNoun(errors.length)} failed. ${errors.join('; ')}`;
      if (partial.length)
        text += ` ${partial.length} ${rootNoun(partial.length)} returned partial results. ${partial.join('; ')}`;
      if (!pending.length) {
        this.batch = undefined;
        this.affected.clear();
        this.changed = this.recovered = false;
        this.changedAt = 0;
      }
    } else {
      if (
        !this.affected.size ||
        [...this.running.values()].some((request) => this.viewRoot(request))
      )
        return;
      const errors = [...this.outcomes.values()].flatMap((root) =>
        root.error ? [root.error] : [],
      );
      const partial = this.view.roots.flatMap((root) => {
        const warnings = this.outcomes.get(root.id)?.warnings ?? [];
        return warnings.length ? [`${root.label}: ${warnings.join('; ')}`] : [];
      });
      const reason = this.changed
        ? 'Changes found'
        : this.recovered
          ? 'Refresh recovered'
          : errors.length
            ? 'Refresh failed'
            : 'Roots updated';
      text = `${this.view.name}: ${reason} across ${this.affected.size} ${rootNoun(this.affected.size)}.`;
      if (this.changed) {
        text += ` Last updated at ${new Date(this.changedAt).toLocaleString(
          undefined,
          {
            fractionalSecondDigits: 3,
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
          },
        )}.`;
      }
      if (errors.length)
        text += ` ${errors.length} ${rootNoun(errors.length)} failed. ${errors.join('; ')}`;
      if (partial.length)
        text += ` ${partial.length} ${rootNoun(partial.length)} returned partial results. ${partial.join('; ')}`;
      this.affected.clear();
      this.changed = this.recovered = false;
      this.changedAt = 0;
    }
    if (this.viewText === text) return;
    this.viewText = text;
    this.publish({ tabId: this.activeTabId, scope: this.scope, text });
  }

  private emit(request: AnnouncementRequest, text: string) {
    if (request.tabId === this.activeTabId && request.scope === this.scope)
      this.publish({ tabId: request.tabId, scope: request.scope, text });
  }
}
