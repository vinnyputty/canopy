import assert from 'node:assert/strict';
import { it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SavedViewsPanel } from '../src/renderer/SavedViewsPanel';
import { starterViews, viewSources } from '../src/renderer/saved-views';

it('distinguishes loading, total failure, partial failure, and an empty match', () => {
  const sources = viewSources(
    {
      ...starterViews()[0],
      roots: [
        { connectionId: 'one', rootKey: 'A-1' },
        { connectionId: 'two', rootKey: 'B-1' },
      ],
    },
    [],
  );
  const base = {
    view: starterViews()[0],
    connections: [],
    availableRoots: [],
    sources,
    results: [],
    selected: null,
    identityErrors: {},
    onSelect: () => {},
    onOpen: () => {},
    onChange: () => {},
    onDelete: () => {},
    onRefresh: () => {},
  };
  const render = (
    errors: Record<string, string>,
    loading = new Set<string>(),
  ) =>
    renderToStaticMarkup(
      React.createElement(SavedViewsPanel, { ...base, errors, loading }),
    );
  assert.match(render({}, new Set([sources[0].id])), /Loading issues/);
  assert.match(
    render({ [sources[0].id]: 'Offline', [sources[1].id]: 'Offline' }),
    /Couldn’t load issues from any selected root/,
  );
  assert.match(
    render({ [sources[0].id]: 'Offline' }),
    /Some roots could not be loaded/,
  );
  assert.match(render({}), /No matching issues/);
  const appError = renderToStaticMarkup(
    React.createElement(SavedViewsPanel, {
      ...base,
      errors: {},
      loading: new Set<string>(),
      workspaceError: 'Couldn’t save workspace',
      appError: 'Couldn’t disconnect site',
    }),
  );
  assert.match(appError, /Couldn’t save workspace/);
  assert.match(appError, /Couldn’t disconnect site/);
});
