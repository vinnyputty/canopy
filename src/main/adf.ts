/** Readable text only: Jira documents never become HTML or executable links. */
export function documentText(value: unknown): string {
  if (typeof value === 'string') return value;
  function render(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const node = value as Record<string, any>;
    if (node.type === 'text') {
      let text = typeof node.text === 'string' ? node.text : '';
      for (const mark of Array.isArray(node.marks) ? node.marks : []) {
        const url = mark?.attrs?.href;
        if (
          mark?.type === 'link' &&
          typeof url === 'string' &&
          /^https?:\/\//i.test(url) &&
          url !== text
        )
          text += ` (${url})`;
      }
      return text;
    }
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'mention') return String(node.attrs?.text ?? '[mention]');
    if (node.type === 'emoji')
      return String(node.attrs?.text ?? node.attrs?.shortName ?? '');
    if (node.type === 'inlineCard' || node.type === 'blockCard')
      return String(node.attrs?.url ?? '');
    if (node.type === 'media') return '[attachment]';
    if (node.type === 'rule') return '\n---\n';
    const children = Array.isArray(node.content) ? node.content : [];
    if (node.type === 'bulletList' || node.type === 'orderedList')
      return (
        children
          .map(
            (child: unknown, index: number) =>
              `${node.type === 'bulletList' ? '•' : `${index + (Number(node.attrs?.order) || 1)}.`} ${render(child).trim()}\n`,
          )
          .join('') + '\n'
      );
    const content = children.map(render).join('');
    return [
      'paragraph',
      'heading',
      'codeBlock',
      'blockquote',
      'tableRow',
    ].includes(node.type)
      ? content + '\n\n'
      : node.type === 'tableCell'
        ? content.trim() + '\t'
        : content;
  }
  return render(value).trim();
}
