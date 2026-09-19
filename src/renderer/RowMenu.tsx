import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Issue } from '../shared/types';

export function RowMenu({
  issue,
  position,
  onClose,
  onAction,
}: {
  issue: Issue;
  position: { x: number; y: number };
  onClose: (restore?: boolean) => void;
  onAction: (action: 'key' | 'title' | 'link' | 'open') => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('button')?.focus();
    const click = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-row-menu-trigger]')) return;
      if (!menu.current?.contains(target)) onClose(false);
    };
    document.addEventListener('pointerdown', click);
    return () => document.removeEventListener('pointerdown', click);
  }, [onClose]);
  return createPortal(
    <div
      ref={menu}
      className="row-context-menu"
      role="menu"
      aria-label={`Actions for ${issue.key}`}
      style={{
        left: Math.max(4, Math.min(position.x, window.innerWidth - 190)),
        top: Math.max(4, Math.min(position.y, window.innerHeight - 160)),
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          onClose();
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = [...event.currentTarget.querySelectorAll('button')];
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          buttons[
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (index +
                    (event.key === 'ArrowDown' ? 1 : -1) +
                    buttons.length) %
                  buttons.length
          ]?.focus();
        }
      }}
    >
      {(
        [
          ['key', 'Copy key'],
          ['title', 'Copy title'],
          ['link', 'Copy link'],
          ['open', 'Open in Jira'],
        ] as const
      ).map(([action, label]) => (
        <button
          role="menuitem"
          key={action}
          onClick={() => {
            onAction(action);
            onClose();
          }}
        >
          {label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
