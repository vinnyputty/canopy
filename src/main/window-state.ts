export type Bounds = { x: number; y: number; width: number; height: number };
export type WindowState = { bounds: Bounds; maximized: boolean };

/** Keep restored windows reachable when a monitor is removed or resized. */
export function restoreWindow(
  saved: WindowState | null,
  displays: Bounds[],
): WindowState | null {
  if (
    !saved ||
    !displays.length ||
    !saved.bounds ||
    ![
      saved.bounds.x,
      saved.bounds.y,
      saved.bounds.width,
      saved.bounds.height,
    ].every(Number.isFinite) ||
    saved.bounds.width <= 0 ||
    saved.bounds.height <= 0
  )
    return null;
  const bounds = saved.bounds;
  const overlap = (display: Bounds) =>
    Math.max(
      0,
      Math.min(bounds.x + bounds.width, display.x + display.width) -
        Math.max(bounds.x, display.x),
    ) *
    Math.max(
      0,
      Math.min(bounds.y + bounds.height, display.y + display.height) -
        Math.max(bounds.y, display.y),
    );
  const display = displays.reduce((best, item) =>
    overlap(item) > overlap(best) ? item : best,
  );
  const width = Math.min(display.width, Math.max(920, bounds.width));
  const height = Math.min(display.height, Math.max(600, bounds.height));
  return {
    bounds: {
      width,
      height,
      x: Math.max(
        display.x,
        Math.min(bounds.x, display.x + display.width - width),
      ),
      y: Math.max(
        display.y,
        Math.min(bounds.y, display.y + display.height - height),
      ),
    },
    maximized: saved.maximized === true,
  };
}
