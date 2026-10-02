// Audit-only observer loaded before either exact source's renderer. DOM commits
// and RAF opportunities are observable proxies, not proof of compositor paint.
(() => {
  let phase = 'initial-load',
    scheduled = false,
    previous = performance.now();
  let signature = '';
  const events: object[] = [];
  const record = (event: object) => {
    if (events.length < 20_000) events.push({ phase, ...event });
  };
  const members = (kind: 'tree' | 'saved') => {
    const container = document.querySelector(
      kind === 'tree' ? '[role="tree"]' : '.saved-view-list',
    );
    const model = container?.querySelector('[data-row-window]') as
      (HTMLElement & { rowKeys?: () => readonly string[] }) | null;
    // The candidate exposes its actual committed full row model. Exact baseline
    // source has no such model and its complete mounted DOM is read unchanged.
    return model?.rowKeys
      ? [...model.rowKeys()]
      : [
          ...(container?.querySelectorAll(
            kind === 'tree' ? '[data-tree-key]' : '.saved-view-result strong',
          ) ?? []),
        ].map((row) =>
          kind === 'tree'
            ? row.getAttribute('data-tree-key')!
            : row.textContent!,
        );
  };
  const dom = () => ({
    treeRows: document.querySelectorAll('[data-tree-key]').length,
    savedRows: document.querySelectorAll('.saved-view-result').length,
    treeLogicalRows: members('tree').length,
    savedLogicalRows: members('saved').length,
    treeLoading: [...document.querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === 'Cancel load',
    ),
    treeIncomplete: [
      ...document.querySelectorAll('.error-banner[role="status"]'),
    ].some((banner) => banner.textContent?.includes('Incomplete results:')),
    savedLoading: [...document.querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === 'Cancel loads',
    ),
    savedIncomplete: Boolean(document.querySelector('.saved-view-error')),
    treeWindowed: Boolean(
      document.querySelector('[role="tree"] [data-row-window="viewport"]'),
    ),
    savedWindowed: Boolean(
      document.querySelector('.saved-view-list [data-row-window="viewport"]'),
    ),
    elements: document.getElementsByTagName('*').length,
  });
  new MutationObserver(() => {
    // Capture at observer delivery before the subsequent RAF opportunity.
    const counts = dom(),
      next = JSON.stringify(counts);
    if (signature !== next) {
      signature = next;
      record({ event: 'dom-commit', at: performance.now(), ...counts });
    }
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame((at) => {
      scheduled = false;
      record({ event: 'paint-opportunity', at, ...dom() });
    });
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  const frame = (at: number) => {
    record({ event: 'frame', at, interval: at - previous });
    previous = at;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      record({
        event: 'long-task',
        at: entry.startTime,
        duration: entry.duration,
      });
  }).observe({ type: 'longtask', buffered: true });
  Object.assign(window, {
    canopyPerfUI: {
      phase: (name: string) => {
        phase = name;
        record({ event: 'phase', at: performance.now(), ...dom() });
      },
      members,
      counts: dom,
      events: () => ({
        events,
        timeOrigin: performance.timeOrigin,
        truncated: events.length === 20_000,
      }),
    },
  });
})();
