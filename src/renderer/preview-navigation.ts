import type { Connection, TabState } from '../shared/types';
import type { ViewResult } from './saved-views';

export type PreviewOverride = {
  tabId: string;
  selectedKey?: string;
  key: string;
};

// Resolve content from the current route, never from the previously active tab.
export function previewTarget(
  tab: TabState | null,
  connections: Connection[],
  savedView: boolean,
  results: ViewResult[],
  selectedResult: string | null,
  override: PreviewOverride | null,
) {
  const result = savedView
    ? results.find(
        ({ source, issue }) =>
          JSON.stringify([source.connectionId, issue.id]) === selectedResult,
      )
    : undefined;
  const source = savedView ? result?.source : tab;
  const connection = connections.find(
    (item) => item.id === source?.connectionId,
  );
  if (!source || !connection) return null;
  const key = savedView
    ? override?.tabId === 'saved-view' &&
      override.selectedKey === selectedResult
      ? override.key
      : result!.issue.key
    : override?.tabId === tab!.id && override.selectedKey === tab!.selectedKey
      ? override.key
      : (tab!.selectedKey ?? tab!.rootKey);
  if (connection.provider === 'github' && !key.includes('#')) return null;
  return { ...source, key, provider: connection.provider };
}
