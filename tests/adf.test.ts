import assert from 'node:assert/strict';
import { it } from 'node:test';
import { documentText } from '../src/main/adf';

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
