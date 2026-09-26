import type { CanopyAPI, SearchIssue } from '../shared/types';

export function rankSearchIssues(
  issues: SearchIssue[],
  query: string,
  project?: string,
): SearchIssue[] {
  const value = query.trim().toLocaleLowerCase();
  const score = (issue: SearchIssue) => {
    const key = issue.key.toLocaleLowerCase();
    const summary = issue.summary.trim().toLocaleLowerCase();
    return key === value
      ? 0
      : key.startsWith(value)
        ? 1
        : summary === value
          ? 2
          : summary.startsWith(value)
            ? 3
            : summary.includes(value)
              ? 4
              : 5;
  };
  const updated = (issue: SearchIssue) => Date.parse(issue.updated ?? '') || 0;
  return [...new Map(issues.map((issue) => [issue.key, issue])).values()].sort(
    (a, b) =>
      score(a) - score(b) ||
      Number(b.key.split('-')[0] === project) -
        Number(a.key.split('-')[0] === project) ||
      updated(b) - updated(a) ||
      a.key.localeCompare(b.key, undefined, { numeric: true }),
  );
}

export type SearchState = {
  issues: SearchIssue[];
  loading: boolean;
  searched: boolean;
  error: string;
  nextPageToken?: string;
  nextPageKind?: 'issues' | 'repositories';
};
const empty = (): SearchState => ({
  issues: [],
  loading: false,
  searched: false,
  error: '',
});

/** One dialog owns its requests; generation checks also protect against ignored aborts. */
export class IssueSearch {
  state = empty();
  private generation = 0;
  private request?: { connectionId: string; id: string };
  private timer?: ReturnType<typeof setTimeout>;
  private context?: { connectionId: string; query: string; project?: string };
  private tokens = new Set<string>();
  constructor(
    private api: Pick<CanopyAPI, 'search' | 'cancelSearch'>,
    private changed: (state: SearchState) => void,
    private debounce = 250,
  ) {}
  private publish(patch: Partial<SearchState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  cancel() {
    this.generation++;
    clearTimeout(this.timer);
    if (this.request)
      void this.api
        .cancelSearch(this.request.connectionId, this.request.id)
        .catch(() => {});
    this.request = undefined;
  }
  start(connectionId: string, query: string, project?: string, enabled = true) {
    this.cancel();
    this.context = { connectionId, query, project };
    this.tokens.clear();
    this.state = empty();
    this.publish({ loading: enabled });
    if (enabled) this.timer = setTimeout(() => void this.load(), this.debounce);
  }
  async load() {
    if (!this.context || this.request) return;
    const { connectionId, query, project } = this.context;
    const generation = this.generation;
    const token = this.state.nextPageToken;
    const id = crypto.randomUUID();
    this.request = { connectionId, id };
    this.publish({ loading: true, error: '' });
    try {
      const page = await this.api.search(connectionId, query, {
        requestId: id,
        ...(token ? { nextPageToken: token } : {}),
      });
      if (generation !== this.generation) return;
      if (
        page.nextPageToken &&
        (page.nextPageToken === token || this.tokens.has(page.nextPageToken))
      )
        throw new Error(
          'The provider repeated a search page. Change the search and try again.',
        );
      if (token) this.tokens.add(token);
      this.publish({
        issues: rankSearchIssues(
          [...this.state.issues, ...page.issues],
          query,
          project,
        ),
        nextPageToken: page.nextPageToken,
        nextPageKind: page.nextPageKind,
        searched: true,
      });
    } catch (error) {
      if (generation === this.generation)
        this.publish({
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (generation === this.generation) {
        this.request = undefined;
        this.publish({ loading: false });
      }
    }
  }
}
