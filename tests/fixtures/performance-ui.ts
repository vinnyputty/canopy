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
  const dom = () => ({
    treeRows: document.querySelectorAll('[data-tree-key]').length,
    savedRows: document.querySelectorAll('.saved-view-result').length,
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
      events: () => ({
        events,
        timeOrigin: performance.timeOrigin,
        truncated: events.length === 20_000,
      }),
    },
  });
})();
