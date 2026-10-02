import type { Issue, TreeSnapshot } from '../shared/types';

import { MAX_TREE_ISSUES, MAX_TREE_CALLS } from '../shared/types';
export type TreeLoadOptions = {
  signal?: AbortSignal;
  allowPartial?: boolean;
  progress?: (snapshot: TreeSnapshot) => void;
  maxIssues?: number;
  maxCalls?: number;
};

export class TreeBudgetError extends Error {}

/** Per-read budgets and progress; no provider snapshots or continuation cache. */
export class TreeLoad {
  calls = 0;
  private lastProgress = -Infinity;
  constructor(readonly options: TreeLoadOptions = {}) {}
  async read<T>(fetch: () => Promise<T>): Promise<T> {
    this.options.signal?.throwIfAborted();
    if (this.calls >= (this.options.maxCalls ?? MAX_TREE_CALLS))
      throw new TreeBudgetError(
        'Tree request budget reached. Open a smaller subtree to load more.',
      );
    this.calls++;
    const result = await fetch();
    this.options.signal?.throwIfAborted();
    return result;
  }
  checkSize(size: number) {
    this.options.signal?.throwIfAborted();
    if (size >= (this.options.maxIssues ?? MAX_TREE_ISSUES))
      throw new TreeBudgetError(
        'Tree issue budget reached. Open a smaller subtree to load more.',
      );
  }
  emit(snapshot: () => TreeSnapshot) {
    if (!this.options.progress || Date.now() - this.lastProgress < 250) return;
    this.lastProgress = Date.now();
    this.options.progress({
      ...snapshot(),
      incomplete: { reason: 'Loading more issues…', calls: this.calls },
    });
  }
  partial(
    rootKey: string,
    issues: Issue[],
    warnings: string[],
    error: unknown,
  ): TreeSnapshot {
    if (
      !issues.length ||
      (!this.options.allowPartial && !this.options.progress)
    )
      throw error;
    return {
      rootKey,
      issues: [...issues],
      fetchedAt: Date.now(),
      warnings,
      incomplete: {
        reason: this.options.signal?.aborted
          ? 'Loading cancelled. Loaded issues remain readable; refresh to retry.'
          : error instanceof Error
            ? error.message
            : String(error),
        calls: this.calls,
      },
      ranking: {
        state: 'unknown',
        reason: 'Ranking requires a complete tree.',
        issueKeys: [],
      },
    };
  }
}
