import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  renderCopyTemplate,
  validateCopyTemplate,
  DEFAULT_COPY_TEMPLATE,
} from '../src/shared/copy-template';
import { recoverWorkspaceViews } from '../src/shared/views';
import type { Issue, Workspace } from '../src/shared/types';

const issue: Issue = {
  id: '42',
  key: 'team/repo#42',
  summary: '<script>fix</script>\u0000\u202e {{token}}',
  type: 'Issue',
  priority: null,
  assignee: null,
  status: { id: 'open', name: 'Open', category: 'new' },
  links: [],
};
const source = 'https://github.com/team/repo/issues/42';

it('uses only allowlisted confirmed fields and escapes HTML and control characters without recursive interpolation', () => {
  const result = renderCopyTemplate(
    DEFAULT_COPY_TEMPLATE,
    {
      ...issue,
      token: 'secret',
      accountName: 'private',
      commentsError: '/Users/private/auth.json',
    } as Issue,
    'github',
    source,
  );
  assert.match(result, /github team\/repo#42/);
  assert.match(result, /&lt;script&gt;fix&lt;\/script&gt;/);
  assert.match(result, /\{\{token\}\}/);
  assert.doesNotMatch(result, /secret|private|\u0000|\u202e|<script>/);
});

it('rejects unknown placeholders, malformed substitutions, HTML and oversized templates', () => {
  for (const value of [
    '{{token}}',
    '{{accountName}}',
    '{{description}}',
    '{{workspacePath}}',
    '{{ key }}',
    '{{key}',
    '<script>{{key}}</script>',
    '\u001bcommand',
    'x'.repeat(4001),
    '',
  ]) {
    assert.equal(validateCopyTemplate(value), false);
    assert.throws(() => renderCopyTemplate(value, issue, 'github', source));
  }
});

it('rejects credential, query, local, foreign and mismatched issue source URLs', () => {
  for (const value of [
    'https://user:secret@github.com/team/repo/issues/42',
    source + '?token=secret',
    source + '#secret',
    'file:///Users/private/auth.json',
    source.replace('github.com', 'evil.example'),
    source.replace('/42', '/43'),
  ])
    assert.throws(() =>
      renderCopyTemplate('{{sourceUrl}}', issue, 'github', value),
    );
  assert.equal(
    renderCopyTemplate('{{sourceUrl}}', issue, 'github'),
    'Unavailable',
  );
  assert.equal(
    renderCopyTemplate('{{sourceUrl}}', issue, 'demo', 'file:///private'),
    'Local sample workspace',
  );
  assert.equal(
    renderCopyTemplate(
      '{{sourceUrl}}',
      { ...issue, key: 'CAN-42' },
      'jira',
      'https://jira.example.com/browse/CAN-42',
    ),
    'https://jira.example.com/browse/CAN-42',
  );
});

it('bounds expanded output and recovers invalid saved templates without losing other workspace state', () => {
  assert.throws(() =>
    renderCopyTemplate(
      '{{summary}}'.repeat(200),
      { ...issue, summary: 'x'.repeat(1000) },
      'github',
      source,
    ),
  );
  const workspace: Workspace = {
    tabs: [],
    activeTabId: null,
    shortcuts: {},
    theme: 'dark',
    sidebarCollapsed: false,
    copyTemplate: '{{token}}',
  };
  assert.equal(recoverWorkspaceViews(workspace).copyTemplate, undefined);
  assert.equal(recoverWorkspaceViews(workspace).theme, 'dark');
  assert.equal(
    recoverWorkspaceViews({ ...workspace, copyTemplate: '{{key}}' })
      .copyTemplate,
    '{{key}}',
  );
});
