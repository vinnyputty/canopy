import React from 'react';
import { documentText } from '../main/adf';

type Node = Record<string, any>;

function object(value: unknown): Node | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Node)
    : null;
}

function hasVisibleContent(value: unknown): boolean {
  const node = object(value);
  if (!node) return false;
  if (node.type === 'text')
    return typeof node.text === 'string' && Boolean(node.text.trim());
  if (node.type === 'hardBreak') return false;
  if (
    [
      'doc',
      'paragraph',
      'heading',
      'bulletList',
      'orderedList',
      'listItem',
      'codeBlock',
    ].includes(node.type)
  )
    return Array.isArray(node.content) && node.content.some(hasVisibleContent);
  return true;
}

export function safePreviewLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function children(node: Node): React.ReactNode {
  return Array.isArray(node.content)
    ? node.content.map((child: unknown, index: number) => (
        <React.Fragment key={index}>{render(child)}</React.Fragment>
      ))
    : null;
}

function render(value: unknown): React.ReactNode {
  const node = object(value);
  if (!node) return null;
  switch (node.type) {
    case 'doc':
      return children(node);
    case 'paragraph':
      return <p>{children(node)}</p>;
    case 'heading': {
      const level = Number(node.attrs?.level);
      const tag =
        `h${Number.isInteger(level) && level >= 1 && level <= 6 ? level : 3}` as keyof React.JSX.IntrinsicElements;
      return React.createElement(tag, null, children(node));
    }
    case 'bulletList':
      return <ul>{children(node)}</ul>;
    case 'orderedList': {
      const order = Number(node.attrs?.order);
      return (
        <ol start={Number.isInteger(order) && order > 0 ? order : 1}>
          {children(node)}
        </ol>
      );
    }
    case 'listItem':
      return <li>{children(node)}</li>;
    case 'codeBlock':
      return (
        <pre>
          <code>
            {Array.isArray(node.content)
              ? node.content
                  .map((item: unknown) => {
                    const text = object(item)?.text;
                    return typeof text === 'string' ? text : '';
                  })
                  .join('')
              : ''}
          </code>
        </pre>
      );
    case 'hardBreak':
      return <br />;
    case 'text': {
      let content: React.ReactNode =
        typeof node.text === 'string' ? node.text : '';
      for (const mark of Array.isArray(node.marks) ? node.marks : []) {
        switch (mark?.type) {
          case 'strong':
            content = <strong>{content}</strong>;
            break;
          case 'em':
            content = <em>{content}</em>;
            break;
          case 'code':
            content = <code>{content}</code>;
            break;
          case 'strike':
            content = <s>{content}</s>;
            break;
          case 'link': {
            const url = safePreviewLink(mark?.attrs?.href);
            if (url)
              content = (
                <button
                  className="preview-inline-link"
                  type="button"
                  onClick={() => void window.canopy.openLink(url)}
                >
                  {content}
                </button>
              );
            break;
          }
        }
      }
      return content;
    }
    default:
      return documentText(node) || '[Unsupported content]';
  }
}

export function PreviewText({
  document,
  fallback,
  empty,
}: {
  document?: unknown;
  fallback: string;
  empty: string;
}) {
  if (!document) return <>{fallback || empty}</>;
  const node = object(document);
  if (!node || node.type !== 'doc') return <>{fallback || empty}</>;
  if (!hasVisibleContent(node)) return <>{fallback || empty}</>;
  return <>{render(node)}</>;
}
