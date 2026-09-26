import assert from 'node:assert/strict';
import { it } from 'node:test';
import { documentMarkdown, documentText } from '../src/main/adf';

it('renders readable ADF paragraphs, lists, mentions, and safe link text', () => {
  assert.equal(
    documentText({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '<script>text</script>' },
            { type: 'hardBreak' },
            { type: 'mention', attrs: { text: '@Ada' } },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: 'Docs',
                      marks: [
                        {
                          type: 'link',
                          attrs: { href: 'https://example.com' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
    '<script>text</script>\n@Ada\n\n• Docs (https://example.com)',
  );
  assert.equal(documentText(null), '');
  assert.equal(documentText('Plain text'), 'Plain text');
  assert.equal(
    documentText({
      type: 'text',
      text: 'Unsafe',
      marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
    }),
    'Unsafe',
  );
});

it('preserves Jira acceptance criteria, links, and code fences in Markdown', () => {
  const text = (value: string, marks?: unknown[]) => ({
    type: 'text',
    text: value,
    marks,
  });
  assert.equal(
    documentMarkdown({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [text('Acceptance criteria')],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    text('Keep ', undefined),
                    text('formatting', [{ type: 'strong' }]),
                  ],
                },
              ],
            },
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    text('Read docs', [
                      {
                        type: 'link',
                        attrs: { href: 'https://example.com/docs' },
                      },
                    ]),
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'codeBlock',
          attrs: { language: 'ts' },
          content: [text('const fence = "```";')],
        },
      ],
    }),
    '## Acceptance criteria\n\n- Keep **formatting**\n- [Read docs](https://example.com/docs)\n\n````ts\nconst fence = "```";\n````',
  );
  assert.equal(
    documentMarkdown('## Existing Markdown\n\n```ts\nconst x = 1;\n```'),
    '## Existing Markdown\n\n```ts\nconst x = 1;\n```',
  );
});

it('keeps unsupported Jira leaves visible and encodes only valid public web links', () => {
  const linked = (label: string, href: string) => ({
    type: 'text',
    text: label,
    marks: [{ type: 'link', attrs: { href } }],
  });
  assert.equal(
    documentMarkdown({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'unsupportedWidget' }] },
        { type: 'blockCard' },
        {
          type: 'paragraph',
          content: [linked('Valid', 'https://example.com/a(b) c')],
        },
        { type: 'paragraph', content: [linked('Malformed', 'https://')] },
        {
          type: 'paragraph',
          content: [linked('Unsafe', 'javascript:alert(1)')],
        },
        {
          type: 'paragraph',
          content: [
            linked('Credentials', 'https://user:secret@example.com/path'),
          ],
        },
      ],
    }),
    '[unsupported Jira content]\n\n[embedded Jira content]\n\n[Valid](https://example.com/a%28b%29%20c)\n\nMalformed\n\nUnsafe\n\nCredentials',
  );
});

it('keeps backticks inside inline code spans', () => {
  assert.equal(
    documentMarkdown({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'a`b', marks: [{ type: 'code' }] },
        { type: 'text', text: ' ' },
        { type: 'text', text: '`edge`', marks: [{ type: 'code' }] },
      ],
    }),
    '``a`b`` `` `edge` ``',
  );
});

it('separates table headers and values while preserving code and media text', () => {
  const cell = (type: string, text: string) => ({
    type,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  assert.equal(
    documentText({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                cell('tableHeader', 'Owner'),
                cell('tableHeader', 'Status'),
              ],
            },
            {
              type: 'tableRow',
              content: [cell('tableCell', 'Ada'), cell('tableCell', 'Ready')],
            },
          ],
        },
        {
          type: 'codeBlock',
          content: [{ type: 'text', text: '<script>alert(1)</script>' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'emoji', attrs: { text: '✓' } }, { type: 'media' }],
        },
      ],
    }),
    'Owner\tStatus\t\n\nAda\tReady\t\n\n<script>alert(1)</script>\n\n✓[attachment]',
  );
});
