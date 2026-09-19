/** Structured internally; the renderer reads cooldown state through syncStatus. */
export class JiraRateLimitError extends Error {
  constructor(readonly retryAt: number) {
    super(
      `Jira rate limit reached. Retry after ${new Date(retryAt).toLocaleTimeString()}.`,
    );
  }
}

type ConnectionRequests = {
  inflight: Map<string, Promise<any>>;
  retryAt: number;
  failures: number;
};

/** In-flight reads and rate-limit recovery belong to an authenticated connection. */
export class JiraRequests {
  private connections = new Map<string, ConnectionRequests>();
  constructor(private readonly now = Date.now) {}

  private state(id: string): ConnectionRequests {
    let state = this.connections.get(id);
    if (!state) {
      state = { inflight: new Map(), retryAt: 0, failures: 0 };
      this.connections.set(id, state);
    }
    return state;
  }

  forget(id: string): void {
    this.connections.delete(id);
  }

  syncStatus(id: string): { retryAt: number | null } {
    const retryAt = this.connections.get(id)?.retryAt ?? 0;
    return { retryAt: retryAt > this.now() ? retryAt : null };
  }

  assertReady(id: string): void {
    const retryAt = this.connections.get(id)?.retryAt ?? 0;
    if (retryAt > this.now()) throw new JiraRateLimitError(retryAt);
  }

  run(
    id: string,
    path: string,
    init: RequestInit,
    send: () => Promise<any>,
  ): Promise<any> {
    const state = this.state(id);
    if (state.retryAt > this.now())
      return Promise.reject(new JiraRateLimitError(state.retryAt));
    const method = (init.method ?? 'GET').toUpperCase();
    const read =
      method === 'GET' ||
      (method === 'POST' &&
        ['/rest/api/3/search/jql', '/rest/api/3/permissions/check'].includes(
          path,
        ));
    const key =
      read && !init.signal
        ? JSON.stringify([method, path, init.body ?? null])
        : undefined;
    const existing = key ? state.inflight.get(key) : undefined;
    if (existing) return existing;
    // A post-write read must not join a read started before or during the write.
    if (!read) state.inflight.clear();
    const started = this.now();
    const task = Promise.resolve()
      .then(send)
      .then((result) => {
        if (state.retryAt <= started) {
          state.retryAt = 0;
          state.failures = 0;
        }
        return result;
      })
      .catch((error) => {
        if (
          error instanceof JiraRateLimitError &&
          this.connections.get(id) === state
        )
          state.retryAt = Math.max(state.retryAt, error.retryAt);
        throw error;
      })
      .finally(() => {
        if (!read) state.inflight.clear();
        if (key && state.inflight.get(key) === task) state.inflight.delete(key);
      });
    if (key) state.inflight.set(key, task);
    return task;
  }

  rateLimited(id: string, retryAfter: string | null): JiraRateLimitError {
    const state = this.state(id);
    const now = this.now();
    const value = retryAfter?.trim();
    const seconds =
      value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    const date = value && !Number.isFinite(seconds) ? Date.parse(value) : NaN;
    if (state.retryAt <= now) state.failures++;
    const fallback =
      now + Math.min(30_000 * 2 ** (state.failures - 1), 15 * 60_000);
    const parsed = Number.isFinite(seconds) ? now + seconds * 1000 : date;
    state.retryAt = Math.max(
      state.retryAt,
      Number.isFinite(parsed) && parsed >= now ? parsed : fallback,
    );
    return new JiraRateLimitError(state.retryAt);
  }
}
