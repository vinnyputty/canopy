import { randomUUID } from 'node:crypto';
import {
  parseWorkHandoffArguments,
  type WorkHandoff,
} from '../shared/work-handoff';
import type { HandoffDelivery, HandoffState } from '../shared/types';

export const HANDOFF_CAPACITY = 16;
export const HANDOFF_WAIT_MS = 60_000;
export const HANDOFF_ACK_MS = 10_000;

/** Consume only the pinned Playwright runtime prefix and documented mode/suffix. */
export function launchArguments(
  argv: string[],
  packaged: boolean,
  platform: string,
): { demo: boolean; handoff: string[] } {
  const prefix = [
    ...(platform === 'linux' ? ['--no-sandbox'] : []),
    '--inspect=0',
    '--remote-debugging-port=0',
  ];
  const runtime = argv.slice(1);
  if (prefix.every((arg, i) => runtime[i] === arg))
    runtime.splice(0, prefix.length);
  // A development app path must precede application arguments.
  if (!packaged && (!runtime[0] || runtime[0].startsWith('--')))
    return { demo: false, handoff: ['--invalid-canopy-command'] };
  const args = runtime.slice(packaged ? 0 : 1);
  if (platform === 'linux' && args.at(-1) === '--no-sandbox') args.pop();
  const demo = args[0] === '--canopy-demo';
  if (demo) args.shift();
  // Bound additionalData before the lock IPC, including malformed invocations.
  const handoff =
    args.length > 2 || args.some((arg) => arg.length > 2048)
      ? ['--invalid-canopy-command']
      : args;
  return { demo, handoff };
}

export function launchHandoffArguments(
  argv: string[],
  packaged: boolean,
  platform: string,
): string[] {
  return launchArguments(argv, packaged, platform).handoff;
}

type Pending = {
  expiresAt: number;
  intent: WorkHandoff;
  identity: string;
  expires: ReturnType<typeof setTimeout>;
};

/** One FIFO across startup and duplicate launches, owned by one renderer session. */
export class WorkHandoffQueue {
  constructor(private readonly notifyRejected: () => void = () => {}) {}
  private pending: Pending[] = [];
  private current?: Pending & {
    delivery: HandoffDelivery;
    deadline: ReturnType<typeof setTimeout>;
  };
  private session?: string;
  private owner?: string;
  private send?: (state: HandoffState) => void;
  private rejected = false;
  private stopped = false;

  receive(args: unknown): void {
    if (this.stopped) return;
    try {
      if (
        !Array.isArray(args) ||
        args.length > 2 ||
        args.some((arg) => typeof arg !== 'string' || arg.length > 2048)
      )
        throw new Error('Invalid command.');
      const intent = parseWorkHandoffArguments(args);
      if (!intent) return;
      const identity = JSON.stringify(intent);
      if (
        this.current?.identity === identity ||
        this.pending.some((item) => item.identity === identity)
      )
        return;
      if (
        this.pending.length + Number(Boolean(this.current)) >=
        HANDOFF_CAPACITY
      )
        throw new Error('Queue full.');
      const item: Pending = {
        expiresAt: Date.now() + HANDOFF_WAIT_MS,
        intent,
        identity,
        expires: setTimeout(() => this.expire(item), HANDOFF_WAIT_MS),
      };
      item.expires.unref();
      this.pending.push(item);
      this.advance();
    } catch {
      this.reject();
    }
  }

  reject(): void {
    if (this.stopped) return;
    this.notifyRejected();
    if (this.session && this.send)
      this.send({ session: this.session, rejected: true });
    else this.rejected = true;
  }

  ready(send: (state: HandoffState) => void, owner = 'default'): HandoffState {
    if (this.stopped) throw new Error('Canopy is closing.');
    if (this.owner && this.owner !== owner) this.cancel();
    this.owner = owner;
    this.session ??= randomUUID();
    this.send = send;
    this.advance(false);
    const state: HandoffState = {
      session: this.session,
      ...(this.current ? { delivery: this.current.delivery } : {}),
      ...(this.rejected ? { rejected: true } : {}),
    };
    this.rejected = false;
    return state;
  }

  acknowledge(session: unknown, id: unknown, result: unknown): boolean {
    if (
      session !== this.session ||
      !this.current ||
      id !== this.current.delivery.id ||
      (result !== 'opened' && result !== 'rejected')
    )
      return false;
    clearTimeout(this.current.expires);
    clearTimeout(this.current.deadline);
    this.current = undefined;
    this.advance();
    return true;
  }

  cancel(session?: unknown): boolean {
    if (session !== undefined && session !== this.session) return false;
    for (const item of this.pending) clearTimeout(item.expires);
    if (this.current) {
      clearTimeout(this.current.expires);
      clearTimeout(this.current.deadline);
    }
    this.pending = [];
    this.current = undefined;
    this.session = undefined;
    this.owner = undefined;
    this.send = undefined;
    this.rejected = false;
    return true;
  }

  stop(): void {
    this.cancel();
    this.stopped = true;
  }

  private expire(item: Pending): void {
    const canceledId =
      this.current?.expires === item.expires
        ? this.current.delivery.id
        : undefined;
    if (canceledId && this.current) {
      clearTimeout(this.current.deadline);
      this.current = undefined;
    } else this.pending = this.pending.filter((value) => value !== item);
    clearTimeout(item.expires);
    this.notifyRejected();
    if (this.session && this.send)
      this.send({ session: this.session, rejected: true, canceledId });
    else this.rejected = true;
    this.advance();
  }

  private advance(notify = true): void {
    if (this.current || !this.session || !this.send) return;
    const item = this.pending.shift();
    if (!item) return;
    const delivery: HandoffDelivery = {
      expiresAt: Math.min(item.expiresAt, Date.now() + HANDOFF_ACK_MS),
      session: this.session,
      id: randomUUID(),
      intent: item.intent,
    };
    const deadline = setTimeout(() => this.expire(item), HANDOFF_ACK_MS);
    deadline.unref();
    this.current = { ...item, delivery, deadline };
    if (notify) this.send({ session: this.session, delivery });
  }
}
