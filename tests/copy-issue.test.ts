import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { issueKeyAndSummary, issueWorkBrief } from '../src/renderer/copy-issue';
import type { Issue, IssuePreview } from '../src/shared/types';

describe('issue key and summary clipboard text', () => {
  it('keeps a one-line summary unchanged', () => {
    assert.equal(
      issueKeyAndSummary({ key: 'CAN-100', summary: 'Keep  two spaces' }),
      'CAN-100 Keep  two spaces',
    );
  });

  it('retains the repository in a GitHub issue identity', () => {
    assert.equal(
      issueKeyAndSummary({ key: 'team/repo#123', summary: 'Fix search' }),
      'team/repo#123 Fix search',
    );
  });

  it('turns line breaks into spaces and trims the summary edges', () => {
    assert.equal(
      issueKeyAndSummary({
        key: 'CAN-100',
        summary: '  First line\r\n  second line\nthird line  ',
      }),
      'CAN-100 First line second line third line',
    );
  });
});

const issue: Issue = {
  id: '42',
  key: 'team/repo#42',
  summary: 'Preserve criteria',
  type: 'Issue',
  parentKey: 'team/repo#7',
  priority: null,
  assignee: null,
  status: { id: 'open', name: 'Open', category: 'new' },
  links: [
    { key: 'team/repo#9', summary: 'Blocked work', relationship: 'blocked by' },
  ],
};

it('makes a provider-qualified GitHub brief with its original Markdown and dependency URLs', () => {
  const preview: IssuePreview = {
    issue: { ...issue, parentKey: undefined },
    description: '- [ ] Pass\n\n```ts\nconst x = 1;\n```',
    comments: [],
    totalComments: 0,
  };
  const brief = issueWorkBrief({
    preview,
    provider: 'github',
    sourceUrl: 'https://github.com/team/repo/issues/42',
    knownIssues: [
      issue,
      { ...issue, key: 'team/repo#7', parentKey: undefined },
    ],
  });
  assert.match(brief, /- Issue: GitHub team\/repo#42/);
  assert.match(brief, /- Parent path: team\/repo#7/);
  assert.match(brief, /- Priority: Not available in GitHub issues/);
  assert.match(brief, /- \[ \] Pass\n\n```ts\nconst x = 1;\n```/);
  assert.match(
    brief,
    /blocked by: \[team\/repo#9\]\(https:\/\/github.com\/team\/repo\/issues\/9\)/,
  );
});

it('marks unavailable Jira parents, description, and dependencies without copying error details', () => {
  const brief = issueWorkBrief({
    preview: {
      issue: {
        ...issue,
        key: 'CAN-42',
        parentKey: 'CAN-7',
        links: [
          {
            key: 'CAN-9',
            summary: 'Known blocker',
            relationship: 'is blocked by',
          },
        ],
        priority: { id: '1', name: 'High' },
      },
      description: undefined as unknown as string,
      comments: [],
      totalComments: 0,
      linksError: 'private connection token=secret',
    },
    provider: 'jira',
    sourceUrl: 'https://jira.example.com/browse/CAN-42',
    knownIssues: [],
  });
  assert.match(brief, /- Parent path: \[earlier parents unavailable\] → CAN-7/);
  assert.match(brief, /Unavailable: description could not be loaded/);
  assert.match(brief, /Unavailable: some dependency links could not be loaded/);
  assert.match(brief, /\[CAN-9\]\(https:\/\/jira.example.com\/browse\/CAN-9\)/);
  assert.doesNotMatch(brief, /token=secret/);
});

it('identifies demo issues without inventing external links', () => {
  const brief = issueWorkBrief({
    preview: {
      issue: {
        ...issue,
        key: 'CAN-111',
        parentKey: 'CAN-100',
        links: [
          {
            key: 'CAN-112',
            summary: 'Sample dependency',
            relationship: 'blocks',
          },
        ],
      },
      description: 'Sample description',
      comments: [],
      totalComments: 0,
    },
    provider: 'demo',
    sourceUrl: 'Local sample workspace',
    knownIssues: [{ ...issue, key: 'CAN-100', parentKey: undefined }],
  });
  assert.match(brief, /- Issue: Demo CAN-111/);
  assert.match(brief, /- Source: Local sample workspace/);
  assert.match(brief, /- Parent path: CAN-100/);
  assert.match(brief, /blocks: CAN-112 — Sample dependency/);
  assert.doesNotMatch(brief, /https?:\/\//);
});
