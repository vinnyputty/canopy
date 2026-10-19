import type { WindowState } from './window-state';

/** Debounce bounds events and retain only the latest state during a disk write. */
export class WindowStateSaver {
  private flushing = false;
  private pending: WindowState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> | null = null;

  constructor(
    private write: (state: WindowState) => Promise<void>,
    private onError: (error: unknown) => void,
  ) {}

  update(state: WindowState) {
    const { x, y, width, height } = state.bounds;
    if (
      ![x, y, width, height].every(Number.isFinite) ||
      width <= 0 ||
      height <= 0
    )
      return;
    this.pending = {
      bounds: { x, y, width, height },
      maximized: state.maximized,
    };
    if (this.flushing) {
      this.startWrite();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.startWrite();
    }, 200);
  }

  private startWrite() {
    if (this.writing || this.timer || !this.pending) return;
    const state = this.pending;
    this.pending = null;
    // Normalize synchronous errors too, so close can always finish.
    this.writing = Promise.resolve()
      .then(() => this.write(state))
      .catch(this.onError)
      .finally(() => {
        this.writing = null;
        this.startWrite();
      });
  }

  /** Drain the final state before the existing close handler approves closing. */
  async flush() {
    this.flushing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.startWrite();
    while (this.writing) await this.writing;
  }
}
