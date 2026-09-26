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
      : node.type === 'tableCell' || node.type === 'tableHeader'
        ? content.trim() + '\t'
        : content;
  }
  return render(value).trim();
}

/** Convert Jira's document body to Markdown for a portable work brief. */
export function documentMarkdown(value: unknown): string {
  if (typeof value === 'string') return value;
  const render = (value: unknown, depth = 0): string => {
    if (!value || typeof value !== 'object') return '';
    const node = value as Record<string, any>;
    const children = Array.isArray(node.content) ? node.content : [];
    const content = () =>
      children.map((child: unknown) => render(child, depth)).join('');
    if (node.type === 'text') {
      let result = String(node.text ?? '');
      for (const mark of Array.isArray(node.marks) ? node.marks : []) {
        if (mark?.type === 'code') {
          const fence = '`'.repeat(
            Math.max(
              1,
              ...[...result.matchAll(/`+/g)].map(([run]) => run.length + 1),
            ),
          );
          const padding = /^`|`$/.test(result) ? ' ' : '';
          result = `${fence}${padding}${result}${padding}${fence}`;
        }
        if (mark?.type === 'strong') result = `**${result}**`;
        if (mark?.type === 'em') result = `*${result}*`;
        if (mark?.type === 'strike') result = `~~${result}~~`;
        if (mark?.type === 'link') {
          const href = mark?.attrs?.href;
          if (typeof href === 'string' && !/[\u0000-\u001f\u007f]/.test(href)) {
            try {
              const url = new URL(href);
              if (
                (url.protocol === 'http:' || url.protocol === 'https:') &&
                !url.username &&
                !url.password
              ) {
                const target = url
                  .toString()
                  .replace(
                    /[()\[\]<>\\]/g,
                    (char) =>
                      `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
                  );
                result = `[${result.replace(/]/g, '\\]')}](${target})`;
              }
            } catch {
              // Keep visible link text when the target is invalid.
            }
          }
        }
      }
      return result;
    }
    if (node.type === 'hardBreak') return '  \n';
    if (node.type === 'mention') return String(node.attrs?.text ?? '[mention]');
    if (node.type === 'emoji')
      return String(node.attrs?.text ?? node.attrs?.shortName ?? '[emoji]');
    if (node.type === 'inlineCard' || node.type === 'blockCard') {
      const label = String(node.attrs?.url ?? '[embedded Jira content]');
      return node.type === 'blockCard' ? `${label}\n\n` : label;
    }
    if (node.type === 'media') return '[attachment]';
    if (node.type === 'rule') return '---\n\n';
    if (node.type === 'heading')
      return `${'#'.repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${content().trim()}\n\n`;
    if (node.type === 'codeBlock') {
      const code = content().replace(/\n$/, '');
      const fence = '`'.repeat(
        Math.max(
          3,
          ...[...code.matchAll(/`+/g)].map(([run]) => run.length + 1),
        ),
      );
      const language = String(node.attrs?.language ?? '').replace(
        /[^a-zA-Z0-9_+.-]/g,
        '',
      );
      return `${fence}${language}\n${code}\n${fence}\n\n`;
    }
    if (node.type === 'paragraph') return `${content()}\n\n`;
    if (node.type === 'blockquote')
      return `${content()
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n\n`;
    if (node.type === 'bulletList' || node.type === 'orderedList')
      return `${children
        .map((child: unknown, index: number) => {
          const item = render(child, depth + 1).trimEnd();
          const marker =
            node.type === 'bulletList'
              ? '- '
              : `${index + (Number(node.attrs?.order) || 1)}. `;
          const indentation = '  '.repeat(depth);
          return `${indentation}${marker}${item.replace(/\n/g, `\n${indentation}  `)}`;
        })
        .join('\n')}\n\n`;
    if (node.type === 'listItem') return content().trim();
    if (node.type === 'table') return content();
    if (node.type === 'tableRow')
      return `${children.map((cell: unknown) => render(cell).trim()).join(' | ')}\n`;
    if (node.type === 'tableCell' || node.type === 'tableHeader')
      return content().trim();
    return children.length ? content() : '[unsupported Jira content]';
  };
  return render(value).trim();
}
