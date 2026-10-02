import assert from 'node:assert/strict';
import { it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  UpdateSettings,
  UpdateNotice,
  type UpdateControls,
} from '../src/renderer/Updates';
import type { UpdateState } from '../src/shared/updates';
const noop = () => {};
export const sampleUpdate: UpdateState = {
  preferences: { notifications: true, prereleases: false },
  currentVersion: '0.1.0',
  platform: 'darwin/arm64',
  packaged: true,
  message: 'A newer compatible release is available.',
  notice: true,
  checkedAt: 1790884800000,
  release: {
    tag: 'v0.2.0',
    version: '0.2.0',
    prerelease: false,
    assets: ['Canopy-0.2.0-mac-arm64.dmg'],
    notes: '<script>alert("untrusted")</script>\nSample release notes.',
  },
};
const controls = (state: UpdateState): UpdateControls => ({
  state,
  busy: false,
  checking: false,
  error: '',
  check: async () => {},
  preferences: async () => {},
  dismiss: async () => {},
  cancel: async () => {},
  open: noop,
});
it('Settings renders current/release versions, notes as text, opt-in, channel, stale result and user installation', () => {
  const html = renderToStaticMarkup(
    React.createElement(UpdateSettings, {
      updates: controls({
        ...sampleUpdate,
        stale: true,
        retryAt: 1790884900000,
      }),
    }),
  );
  for (const text of [
    'Current version: 0.1.0',
    'darwin/arm64',
    'Compatible release: 0.2.0',
    'Check for updates',
    'Include prereleases',
    'off by default',
    'never downloads or installs',
    'Open official GitHub Release',
    'availability has not been reverified',
    'Retry after',
    '&lt;script&gt;',
  ])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href='));
});
it('quiet notice has no alert/live region or automatic handoff and disappears when disabled', () => {
  const html = renderToStaticMarkup(
    React.createElement(UpdateNotice, {
      updates: controls(sampleUpdate),
      onDetails: noop,
    }),
  );
  assert.ok(html.includes('Canopy 0.2.0'));
  assert.ok(html.includes('Dismiss'));
  assert.ok(!html.includes('role="alert"'));
  assert.ok(!html.includes('aria-live'));
  assert.ok(!html.includes('href='));
  for (const state of [
    { ...sampleUpdate, notice: false },
    {
      ...sampleUpdate,
      preferences: { notifications: false, prereleases: false },
    },
    { ...sampleUpdate, release: undefined },
  ])
    assert.equal(
      renderToStaticMarkup(
        React.createElement(UpdateNotice, {
          updates: controls(state),
          onDetails: noop,
        }),
      ),
      '',
    );
});
