import assert from 'node:assert/strict';
import { it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewText, safePreviewLink } from '../src/renderer/PreviewText';

const paragraph = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});
const render = (document: unknown, fallback = '') =>
  renderToStaticMarkup(
    React.createElement(PreviewText, {
      document,
      fallback,
      empty: 'No description.',
    }),
  );

it('renders Jira headings, marks, nested lists, code, and safe links', () => {
  const html = render({
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Release' }],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Read ', marks: [{ type: 'em' }] },
          {
            type: 'text',
            text: 'docs',
            marks: [
              { type: 'strong' },
              { type: 'link', attrs: { href: 'https://example.com/guide' } },
            ],
          },
          { type: 'text', text: ' and run ', marks: [{ type: 'code' }] },
        ],
      },
      {
        type: 'orderedList',
        attrs: { order: 3 },
        content: [
          {
            type: 'listItem',
            content: [
              paragraph('Deploy'),
              {
                type: 'bulletList',
                content: [
                  { type: 'listItem', content: [paragraph('Check health')] },
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'codeBlock',
        content: [{ type: 'text', text: 'const x = "<script>";\n  return x;' }],
      },
    ],
  });
  assert.match(html, /<h2>Release<\/h2>/);
  assert.match(html, /<em>Read <\/em>/);
  assert.match(html, /<button[^>]*><strong>docs<\/strong><\/button>/);
  assert.match(
    html,
    /<ol start="3"><li><p>Deploy<\/p><ul><li><p>Check health<\/p><\/li><\/ul><\/li><\/ol>/,
  );
  assert.match(
    html,
    /<pre><code>const x = &quot;&lt;script&gt;&quot;;\n  return x;<\/code><\/pre>/,
  );
});

it('escapes remote text and leaves unsafe links and embedded nodes inert', () => {
  const html = render({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: '<img src=x onerror=alert(1)>',
            marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
          },
        ],
      },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] },
      { type: 'extension', attrs: { extensionKey: 'danger' } },
    ],
  });
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img|javascript:|<a /);
  assert.match(html, /\[attachment\]/);
  assert.match(html, /\[Unsupported content\]/);
  assert.equal(safePreviewLink('data:text/html,unsafe'), null);
  assert.equal(
    safePreviewLink('https://example.com/a'),
    'https://example.com/a',
  );
});

it('keeps absent content distinct from a readable fallback', () => {
  assert.equal(render(null), 'No description.');
  assert.equal(render({ type: 'doc', content: [] }), 'No description.');
  assert.equal(render({ type: 'broken' }, 'Plain fallback'), 'Plain fallback');
});
