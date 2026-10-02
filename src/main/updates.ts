import {
  DEFAULT_UPDATES,
  validUpdatePreferences,
  type UpdatePreferences,
  type UpdateState,
} from '../shared/updates';
import {
  compareVersions,
  eligibleReleases,
  MAX_PAGES,
  parseVersion,
  ReleaseRequestError,
  releaseTransport,
  releaseUrl,
  type ReleaseTransport,
} from './releases';

const HOUR = 60 * 60 * 1000;
const WEEK = 7 * 24 * HOUR;
type SavedUpdates = {
  preferences: UpdatePreferences;
  attemptedAt?: number;
  noticedAt?: number;
  dismissedTag?: string;
};
type UpdateStorage = {
  read<T>(name: string): Promise<T | null>;
  write(name: string, value: unknown): Promise<void>;
};
export class Updates {
  private saved: SavedUpdates = { preferences: { ...DEFAULT_UPDATES } };
  private state: UpdateState;
  private loaded: Promise<void>;
  private storageError = false;
  private controller?: AbortController;
  private flight?: Promise<UpdateState>;
  private generation = 0;
  private cache?: { rows: unknown[]; at: number; limited: boolean };
  private cooldown = 0;
  private writes: Promise<void> = Promise.resolve();
  private preferenceChange?: Promise<UpdateState>;
  constructor(
    private storage: UpdateStorage,
    version: string,
    private platform: string,
    private arch: string,
    private packaged: boolean,
    private transport: ReleaseTransport = releaseTransport(),
    private now = Date.now,
  ) {
    this.state = {
      preferences: { ...DEFAULT_UPDATES },
      currentVersion: version,
      platform: `${platform}/${arch}`,
      packaged,
      message: 'Check GitHub for compatible releases.',
    };
    this.loaded = this.load();
  }
  private async load() {
    try {
      const input = await this.storage.read<SavedUpdates>('updates');
      if (input && validUpdatePreferences(input.preferences)) {
        this.saved.preferences = { ...input.preferences };
        for (const key of ['attemptedAt', 'noticedAt'] as const) {
          if (
            Number.isSafeInteger(input[key]) &&
            input[key]! >= 0 &&
            input[key]! <= this.now()
          )
            this.saved[key] = input[key];
        }
        if (
          typeof input.dismissedTag === 'string' &&
          parseVersion(input.dismissedTag.replace(/^v/, ''))
        )
          this.saved.dismissedTag = input.dismissedTag;
      }
    } catch {
      this.storageError = true;
      this.state.message =
        'Update preferences could not be read. Notices are off; manual checks are available.';
    }
    this.state.preferences = { ...this.saved.preferences };
  }
  private persist() {
    const value = structuredClone(this.saved);
    const write = this.writes
      .catch(() => {})
      .then(() => this.storage.write('updates', value));
    this.writes = write;
    return write;
  }
  async snapshot(): Promise<UpdateState> {
    await this.loaded;
    return structuredClone(this.state);
  }
  cancel() {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.flight = undefined;
  }
  preferences(value: unknown): Promise<UpdateState> {
    if (!validUpdatePreferences(value))
      return Promise.reject(new Error('Invalid update preferences.'));
    const input = { ...value };
    const task = (this.preferenceChange ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.applyPreferences(input));
    this.preferenceChange = task;
    void task
      .finally(() => {
        if (this.preferenceChange === task) this.preferenceChange = undefined;
      })
      .catch(() => {});
    return task;
  }
  private async applyPreferences(value: UpdatePreferences) {
    await this.loaded;
    if (!validUpdatePreferences(value))
      throw new Error('Invalid update preferences.');
    this.cancel();
    const previous = this.saved.preferences;
    this.saved.preferences = { ...value };
    try {
      await this.persist();
      this.storageError = false;
    } catch {
      this.saved.preferences = previous;
      throw new Error('Could not save update preferences.');
    }
    this.state = {
      ...this.state,
      preferences: { ...this.saved.preferences },
      notice: false,
      release: undefined,
      checkedAt: undefined,
      stale: false,
      message:
        'Preferences saved. Check for updates to use this release channel.',
    };
    return this.snapshot();
  }
  async dismiss() {
    await this.loaded;
    this.cancel();
    this.state.notice = false;
    if (this.state.release) this.saved.dismissedTag = this.state.release.tag;
    try {
      await this.persist();
    } catch {
      /* Dismissal still applies to this session. */
    }
    return this.snapshot();
  }
  async open(tag: unknown, open: (url: string) => Promise<unknown>) {
    await this.loaded;
    if (!this.state.release || tag !== this.state.release.tag)
      throw new Error('Check for an available release first.');
    await open(releaseUrl(tag));
  }
  async check(background = false): Promise<UpdateState> {
    await this.loaded;
    await this.preferenceChange?.catch(() => {});
    if (
      background &&
      (this.storageError ||
        !this.packaged ||
        !parseVersion(this.state.currentVersion) ||
        !this.saved.preferences.notifications ||
        this.now() - (this.saved.attemptedAt ?? -WEEK) < WEEK)
    )
      return this.snapshot();
    if (this.flight) return this.flight;
    if (this.now() < this.cooldown) {
      if (!background)
        this.state.message =
          'Release checks are paused. Try again after the retry time.';
      return this.snapshot();
    }
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const task = this.run(background, generation, controller);
    this.flight = task;
    try {
      return await task;
    } finally {
      if (this.generation === generation) {
        this.flight = undefined;
        this.controller = undefined;
      }
    }
  }
  private async run(
    background: boolean,
    generation: number,
    controller: AbortController,
  ) {
    const current = () =>
      this.generation === generation && !controller.signal.aborted;
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      if (background) {
        this.saved.attemptedAt = this.now();
        await this.persist(); // Persist before contacting GitHub, including across restarts.
        if (!current()) return this.snapshot();
      }
      let cache = this.cache;
      if (!cache || this.now() - cache.at >= HOUR) {
        const rows: unknown[] = [];
        let more = false;
        for (let page = 1; page <= MAX_PAGES; page++) {
          const result = await this.transport(page, controller.signal);
          if (!current()) return this.snapshot();
          rows.push(...result.rows);
          more = result.more;
          if (!more) break;
        }
        cache = { rows, at: this.now(), limited: more };
        this.cache = cache;
      }
      if (!current()) return this.snapshot();
      const releases = eligibleReleases(
        cache.rows,
        this.platform,
        this.arch,
        this.saved.preferences.prereleases,
      );
      const local = parseVersion(this.state.currentVersion);
      const best = releases[0];
      const newer =
        local &&
        best &&
        compareVersions(parseVersion(best.version)!, local) > 0;
      const published =
        local &&
        cache.rows.some((value) => {
          const row = value as Record<string, unknown> | null;
          return (
            row &&
            row.draft === false &&
            typeof row.published_at === 'string' &&
            Number.isFinite(Date.parse(row.published_at)) &&
            typeof row.tag_name === 'string' &&
            parseVersion(row.tag_name.replace(/^v/, '')) &&
            row.html_url === releaseUrl(row.tag_name) &&
            row.tag_name.replace(/^v/, '') === this.state.currentVersion
          );
        });
      let message = !cache.rows.length
        ? 'No public releases were returned.'
        : !best
          ? 'No compatible releases were found for this OS/CPU and channel.'
          : !local
            ? 'This development version cannot be compared. A compatible release is shown.'
            : newer
              ? 'A newer compatible release is available.'
              : 'No newer compatible release was found.';
      if (!this.packaged)
        message +=
          ' Development build: the app version may not describe this source checkout.';
      else if (local && !published)
        message +=
          ' The current version was not found among the scanned published releases.';
      if (cache.limited)
        message +=
          ' Search limited to the first 90 releases; older releases may be absent.';
      let notice = !!(
        background &&
        newer &&
        this.packaged &&
        this.saved.preferences.notifications &&
        best.tag !== this.saved.dismissedTag &&
        this.now() - (this.saved.noticedAt ?? -WEEK) >= WEEK
      );
      if (notice) {
        this.saved.noticedAt = this.now();
        try {
          await this.persist();
        } catch {
          notice = false;
        }
        if (!current()) return this.snapshot();
      }
      this.state = {
        ...this.state,
        message,
        release: best,
        checkedAt: cache.at,
        stale: false,
        notice: background ? notice : false,
        retryAt: undefined,
      };
    } catch (error) {
      if (this.generation !== generation) return this.snapshot();
      this.cooldown =
        error instanceof ReleaseRequestError && error.retryAt
          ? error.retryAt
          : this.now() + 5 * 60_000;
      this.state = {
        ...this.state,
        notice: false,
        stale: !!this.state.release,
        retryAt: this.cooldown,
        message:
          error instanceof ReleaseRequestError
            ? error.message
            : 'Could not check releases. The network may be offline or the check timed out. Try again later.',
      };
      // Retain at most one bounded successful result, clearly marked stale.
      if (this.state.checkedAt && this.now() - this.state.checkedAt > WEEK) {
        this.state.release = undefined;
        this.state.checkedAt = undefined;
        this.state.stale = false;
      }
    } finally {
      clearTimeout(timer);
    }
    return this.snapshot();
  }
}
