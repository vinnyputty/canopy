import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

export type RowWindow = {
  ensure: (id: string, align?: 'nearest' | 'center') => HTMLElement | null;
};

// The renderer owns the complete ordered member set. DOM consumers can inspect
// that set separately from the mounted viewport; it is never provider truth.
export type RowModelElement = HTMLDivElement & {
  logicalRows?: () => readonly string[];
  rowKeys?: () => readonly string[];
  revealRow?: (key: string) => HTMLElement | null;
};

export function WindowedRows({
  ids,
  rowKeys = ids,
  renderRow,
  pinned = [],
  api,
  scrollSelector,
}: {
  ids: readonly string[];
  rowKeys?: readonly string[];
  renderRow: (index: number) => React.ReactNode;
  pinned?: readonly (string | undefined | null)[];
  api?: React.RefObject<RowWindow | null>;
  scrollSelector: string;
}) {
  const root = useRef<RowModelElement>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const heights = useRef(new Map<string, number>());
  const layout = useRef('');
  const pendingAnchor = useRef<{ id: string; inside: number } | null>(null);
  const [revision, setRevision] = useState(0);
  const [estimate, setEstimate] = useState(38);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [focused, setFocused] = useState<string | null>(null);
  const [requested, setRequested] = useState<string | null>(null);
  const alignment = useRef<{
    id: string;
    align: 'nearest' | 'center';
    owner: readonly string[];
    stable: number;
    passes: number;
    scrollTop: number;
  } | null>(null);
  const windowed = ids.length > 200;
  const index = useMemo(() => new Map(ids.map((id, i) => [id, i])), [ids]);
  const offsets = useMemo(() => {
    const values = [0];
    for (const id of ids)
      values.push(values.at(-1)! + (heights.current.get(id) ?? estimate));
    return values;
  }, [ids, estimate, revision]);
  const range = (top: number) => {
    let low = 0,
      high = ids.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (offsets[mid + 1] <= top) low = mid + 1;
      else high = mid;
    }
    return Math.min(low, Math.max(0, ids.length - 1));
  };
  const indices = new Set<number>();
  const first = windowed
    ? range(Math.max(0, viewport.top - viewport.height))
    : 0;
  const last = windowed
    ? range(viewport.top + viewport.height * 2)
    : ids.length - 1;
  for (let i = first; i <= last && i < ids.length; i++) indices.add(i);
  for (const id of [...pinned, focused, requested]) {
    const i = id ? index.get(id) : undefined;
    if (i !== undefined) indices.add(i);
  }
  const mounted = [...indices].sort((a, b) => a - b);
  const scroller = () => root.current?.closest<HTMLElement>(scrollSelector);
  const origin = (container: HTMLElement) =>
    root.current!.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop -
    container.clientTop;
  const readViewport = () => {
    const container = scroller();
    if (!container) return;
    const next = {
      top: Math.max(0, container.scrollTop - origin(container)),
      height: container.clientHeight || 600,
    };
    setViewport((previous) =>
      previous.top === next.top && previous.height === next.height
        ? previous
        : next,
    );
  };
  const ensure = (id: string, align: 'nearest' | 'center' = 'nearest') => {
    const i = index.get(id),
      container = scroller();
    if (i === undefined || !container) return null;
    if (!windowed) {
      const row = elements.current.get(id) ?? null;
      row?.scrollIntoView({ block: align });
      return row;
    }
    alignment.current = {
      id,
      align,
      owner: ids,
      stable: 0,
      passes: 0,
      scrollTop: container.scrollTop,
    };
    pendingAnchor.current = null;
    const start = origin(container) + offsets[i],
      end = origin(container) + offsets[i + 1];
    let top = container.scrollTop;
    if (align === 'center')
      top = Math.max(0, start - (container.clientHeight - (end - start)) / 2);
    else if (start < top) top = start;
    else if (end > top + container.clientHeight)
      top = end - container.clientHeight;
    container.scrollTop = Math.max(0, top);
    alignment.current!.scrollTop = container.scrollTop;
    // Keyboard/edit destinations must exist before their caller focuses them.
    flushSync(() => {
      setRequested(id);
      readViewport();
    });
    return elements.current.get(id) ?? null;
  };
  const navigation = useRef(ensure);
  navigation.current = ensure;
  const alignRequested = () => {
    const request = alignment.current,
      container = scroller();
    if (!request || !container || request.owner !== ids) return false;
    const row = elements.current.get(request.id);
    if (!row) return false;
    const rect = row.getBoundingClientRect(),
      bounds = container.getBoundingClientRect();
    const top = bounds.top + container.clientTop,
      bottom = top + container.clientHeight;
    // A taller-than-viewport row cannot fit: expose its start and preserve the
    // focused owner rather than promising complete visibility.
    const delta =
      rect.height > container.clientHeight
        ? rect.top - top
        : request.align === 'center'
          ? (rect.top + rect.bottom - top - bottom) / 2
          : rect.top < top
            ? rect.top - top
            : rect.bottom > bottom
              ? rect.bottom - bottom
              : 0;
    if (Math.abs(delta) > 1) {
      container.scrollTop = Math.max(0, container.scrollTop + delta);
      request.scrollTop = container.scrollTop;
      request.stable = 0;
      readViewport();
      return false;
    }
    return rect.bottom > top && rect.top < bottom;
  };
  useLayoutEffect(() => {
    if (alignment.current?.owner !== ids) {
      alignment.current = null;
      setRequested(null);
    }
  }, [ids]);
  useLayoutEffect(() => {
    const owner: RowWindow = {
      ensure: (id, align) => navigation.current(id, align),
    };
    if (api) api.current = owner;
    return () => {
      alignment.current = null;
      pendingAnchor.current = null;
      if (api?.current === owner) api.current = null;
    };
  }, [api]);
  const currentLayout = useRef({ offsets, estimate });
  currentLayout.current = { offsets, estimate };

  useLayoutEffect(() => {
    const anchor = pendingAnchor.current,
      container = scroller();
    if (alignment.current) {
      pendingAnchor.current = null;
      alignRequested();
      return;
    }
    if (!anchor || !container) return;
    pendingAnchor.current = null;
    const i = index.get(anchor.id);
    if (i !== undefined) {
      container.scrollTop = origin(container) + offsets[i] + anchor.inside;
      readViewport();
    }
  }, [offsets]);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    element.logicalRows = () => ids;
    element.rowKeys = () => rowKeys;
    element.revealRow = (key) => {
      const i = rowKeys.indexOf(key);
      return i < 0 ? null : navigation.current(ids[i], 'center');
    };
    for (const id of heights.current.keys())
      if (!index.has(id)) heights.current.delete(id);
    return () => {
      delete element.logicalRows;
      delete element.rowKeys;
      delete element.revealRow;
    };
  }, [ids, index, rowKeys]);

  useLayoutEffect(() => {
    const container = scroller(),
      element = root.current;
    if (!container || !element || !windowed) return;
    let frame = 0;
    const measure = () => {
      const style = getComputedStyle(container);
      const signature = [
        container.clientWidth,
        style.fontFamily,
        style.fontSize,
        style.lineHeight,
        style.getPropertyValue('--table-width'),
        style.getPropertyValue('--row-height'),
        style.getPropertyValue('--tree-font-size'),
      ].join('|');
      const old = currentLayout.current;
      const relativeTop = Math.max(0, container.scrollTop - origin(container));
      let anchor = 0;
      while (anchor < ids.length - 1 && old.offsets[anchor + 1] <= relativeTop)
        anchor++;
      let changed = false;
      if (layout.current !== signature) {
        layout.current = signature;
        heights.current.clear();
        changed = true;
      }
      let sample = 0;
      for (const [id, row] of elements.current) {
        const height = row.getBoundingClientRect().height;
        if (height > 0) {
          sample = sample ? Math.min(sample, height) : height;
          if (heights.current.get(id) !== height) {
            heights.current.set(id, height);
            changed = true;
          }
        }
      }
      // Estimates come from actual mounted rows, then each observed member uses
      // its own measurement (including expanded links and active editors).
      if (sample)
        setEstimate((previous) => (previous === sample ? previous : sample));
      if (changed) {
        if (
          !alignment.current &&
          ids[anchor] &&
          container.scrollTop >= origin(container)
        )
          pendingAnchor.current = {
            id: ids[anchor],
            inside: relativeTop - old.offsets[anchor],
          };
        setRevision((value) => value + 1);
      }
      readViewport();
      const request = alignment.current;
      if (request) {
        const visible = alignRequested();
        request.stable = !changed && visible ? request.stable + 1 : 0;
        // One transient owner and finite settlement work. Focus/editor pins are
        // separate durable interaction ownership; passive scrolling is separate.
        if (request.stable >= 2 || ++request.passes >= 8) {
          alignment.current = null;
          setRequested(null);
        } else schedule();
      }
    };
    const schedule = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    for (const row of elements.current.values()) observer.observe(row);
    const styles = new MutationObserver(schedule);
    for (
      let target: HTMLElement | null = container;
      target;
      target = target.parentElement
    )
      styles.observe(target, {
        attributes: true,
        attributeFilter: ['style', 'class'],
      });
    const cancelAlignment = () => {
      alignment.current = null;
      setRequested(null);
    };
    const scroll = () => {
      if (
        alignment.current &&
        Math.abs(container.scrollTop - alignment.current.scrollTop) > 1
      )
        cancelAlignment();
      schedule();
    };
    container.addEventListener('scroll', scroll, { passive: true });
    container.addEventListener('wheel', cancelAlignment, { passive: true });
    container.addEventListener('touchstart', cancelAlignment, {
      passive: true,
    });
    document.fonts?.addEventListener('loadingdone', schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      styles.disconnect();
      container.removeEventListener('scroll', scroll);
      container.removeEventListener('wheel', cancelAlignment);
      container.removeEventListener('touchstart', cancelAlignment);
      document.fonts?.removeEventListener('loadingdone', schedule);
    };
  }, [ids, mounted.join(','), windowed, requested]);

  const children: React.ReactNode[] = [];
  let cursor = 0;
  const spacer = (end: number) => {
    if (end > cursor)
      children.push(
        <div
          key={`gap:${cursor}:${end}`}
          data-window-spacer
          aria-hidden="true"
          style={{ height: offsets[end] - offsets[cursor] }}
        />,
      );
  };
  for (const i of mounted) {
    spacer(i);
    children.push(
      <div
        role="presentation"
        data-window-row={ids[i]}
        key={ids[i]}
        ref={(element) => {
          if (element) elements.current.set(ids[i], element);
          else elements.current.delete(ids[i]);
        }}
      >
        {renderRow(i)}
      </div>,
    );
    cursor = i + 1;
  }
  spacer(ids.length);
  return (
    <div
      ref={root}
      data-row-window={windowed ? 'viewport' : 'all'}
      data-logical-count={ids.length}
      onFocusCapture={(event) =>
        setFocused(
          (event.target as HTMLElement).closest<HTMLElement>(
            '[data-window-row]',
          )?.dataset.windowRow ?? null,
        )
      }
      onBlurCapture={() => {
        queueMicrotask(() => {
          if (root.current)
            setFocused(
              root.current.contains(document.activeElement)
                ? (document.activeElement?.closest<HTMLElement>(
                    '[data-window-row]',
                  )?.dataset.windowRow ?? null)
                : null,
            );
        });
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab' || event.defaultPrevented || !windowed) return;
        const row = (event.target as HTMLElement).closest<HTMLElement>(
          '[data-window-row]',
        );
        if (!row) return;
        const focusable = (element: HTMLElement) =>
          [
            ...element.querySelectorAll<HTMLElement>(
              'button,input,select,textarea,[tabindex]',
            ),
          ].filter(
            (item) => item.tabIndex >= 0 && !item.hasAttribute('disabled'),
          );
        const controls = focusable(row),
          boundary = event.shiftKey ? controls[0] : controls.at(-1);
        if (document.activeElement !== boundary) return;
        const next =
          (index.get(row.dataset.windowRow!) ?? -1) + (event.shiftKey ? -1 : 1);
        if (next < 0 || next >= ids.length) return;
        const destination = ensure(ids[next]);
        if (destination) {
          event.preventDefault();
          const controls = focusable(destination);
          (event.shiftKey ? controls.at(-1) : controls[0])?.focus({
            preventScroll: true,
          });
        }
      }}
    >
      {children}
    </div>
  );
}
