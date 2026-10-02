import type { CanopyAPI, CommentPage, IssuePreview } from '../shared/types';

export type OlderCommentsState = {
  comments: IssuePreview['comments'];
  start: number;
  end: number;
  olderPage?: number;
  loading: boolean;
  error: string;
};

/** Older pages are separate from the latest preview and its unread evidence. */
export class OlderComments {
  state: OlderCommentsState = {
    comments: [],
    start: 0,
    end: 0,
    loading: false,
    error: '',
  };
  private generation = 0;
  private context?: { connectionId: string; key: string };
  constructor(
    private api: Pick<CanopyAPI, 'olderComments'>,
    private changed: (state: OlderCommentsState) => void,
  ) {}
  reset(
    connectionId?: string,
    key?: string,
    page?: IssuePreview['commentPage'],
  ) {
    this.generation++;
    this.context = connectionId && key ? { connectionId, key } : undefined;
    this.publish({
      comments: [],
      start: page?.start ?? 0,
      end: page?.end ?? 0,
      olderPage: page?.olderPage,
      loading: false,
      error: '',
    });
  }
  private publish(state: OlderCommentsState) {
    this.state = state;
    this.changed(state);
  }
  async load() {
    const page = this.state.olderPage;
    if (!this.context || !page || this.state.loading) return;
    const { connectionId, key } = this.context;
    const generation = this.generation;
    this.publish({ ...this.state, loading: true, error: '' });
    try {
      const result = await this.api.olderComments(connectionId, key, page);
      if (generation !== this.generation) return;
      this.publish({
        comments: mergeComments(result.comments, this.state.comments),
        start: result.start || this.state.start,
        end: Math.max(result.end, this.state.end),
        olderPage: result.olderPage,
        loading: false,
        error: '',
      });
    } catch (error) {
      if (generation === this.generation)
        this.publish({
          ...this.state,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  }
}

// Pages arrive oldest-first; a newer loaded copy wins if a page shifts after a deletion.
export function mergeComments(
  older: CommentPage['comments'],
  newer: CommentPage['comments'],
) {
  return [
    ...new Map(
      [...older, ...newer].map((comment) => [comment.id, comment]),
    ).values(),
  ];
}
