/** Owns the document editing pause until its close attempt succeeds or releases it. */
export class WorkspaceClose {
  owner: number | undefined;
  private releasedThrough = 0;
  private restoreInput: (() => void) | undefined;
  private pending = new Set<Promise<unknown>>();

  get paused() {
    return this.owner !== undefined;
  }
  assertWritable() {
    if (this.paused)
      throw new Error('Workspace is closing; wait for saving to finish.');
  }
  assertOwner(attempt: number) {
    if (this.owner !== attempt || attempt <= this.releasedThrough)
      throw new Error('Workspace close was canceled.');
  }
  pause(attempt: number, document: Document, commit: () => void) {
    if (
      attempt <= this.releasedThrough ||
      (this.owner !== undefined && attempt < this.owner)
    )
      throw new Error('Workspace close was canceled.');
    if (!this.paused) {
      commit();
      this.owner = attempt;
      const body = document.body;
      const inert = body.inert;
      const focus = document.activeElement;
      const block = (event: Event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const events = [
        'keydown',
        'keyup',
        'keypress',
        'dblclick',
        'contextmenu',
        'pointerup',
        'mouseup',
        'cut',
        'paste',
        'wheel',
        'touchmove',
        'beforeinput',
        'input',
        'change',
        'click',
        'pointerdown',
        'mousedown',
        'submit',
        'drop',
        'dragstart',
      ];
      for (const name of events)
        document.defaultView!.addEventListener(name, block, {
          capture: true,
          passive: false,
        });
      body.inert = true;
      this.restoreInput = () => {
        body.inert = inert;
        for (const name of events)
          document.defaultView!.removeEventListener(name, block, true);
        if (
          !inert &&
          focus instanceof document.defaultView!.HTMLElement &&
          focus.isConnected
        )
          focus.focus();
      };
    }
    this.owner = attempt;
  }
  release(attempt: number) {
    this.releasedThrough = Math.max(this.releasedThrough, attempt);
    if (this.owner !== attempt) return;
    this.owner = undefined;
    this.restoreInput?.();
    this.restoreInput = undefined;
  }
  async track<T>(operation: () => Promise<T>): Promise<T> {
    this.assertWritable();
    const pending = operation();
    this.pending.add(pending);
    return pending.finally(() => this.pending.delete(pending));
  }
  async drain() {
    while (this.pending.size) await Promise.all(this.pending);
  }
}
