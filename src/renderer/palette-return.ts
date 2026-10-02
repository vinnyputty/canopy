/** Dismissal restores the originating control without scrolling it into view. */
export function paletteReturn(
  focus: HTMLElement | null,
  scrollElement: HTMLElement | null,
) {
  const elements = new Set<HTMLElement>();
  if (scrollElement) elements.add(scrollElement);
  for (
    let element = focus?.parentElement;
    element;
    element = element.parentElement
  )
    elements.add(element);
  const positions = [...elements].map((element) => ({
    element,
    top: element.scrollTop,
    left: element.scrollLeft,
  }));
  return () => {
    if (focus?.isConnected) focus.focus({ preventScroll: true });
    for (const { element, top, left } of positions) {
      if (!element.isConnected) continue;
      element.scrollTop = top;
      element.scrollLeft = left;
    }
  };
}
