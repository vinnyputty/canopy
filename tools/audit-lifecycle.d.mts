import type { ChildProcess } from 'node:child_process';
export function deadline<T>(
  operation: () => T | Promise<T>,
  ms: number,
  label: string,
): Promise<T>;
export class AuditOwner {
  constructor(options: {
    profile: string;
    executable: string;
    graceMs?: number;
    killMs?: number;
    operationMs?: number;
    signalGroup?: (pid: number, signal?: string | number) => boolean;
    killTree?: (pid: number, timeoutMs: number) => Promise<unknown>;
  });
  readonly child: ChildProcess | undefined;
  profile: string;
  launch<T>(operation: () => Promise<T>): Promise<T>;
  confirm(child: ChildProcess): void;
  restore(): void;
  shutdown(
    close?: () => Promise<unknown>,
  ): Promise<{ terminated: boolean; errors: Error[] }>;
}
export function finishAudit(options: {
  owner: AuditOwner;
  close?: () => Promise<unknown>;
  primary?: unknown;
  diagnostics?: { label: string; run: () => Promise<unknown> }[];
  removeProfile: () => Promise<unknown>;
  writeEvidence: () => Promise<unknown>;
  secondary?: (error: Error) => void;
  operationMs?: number;
}): Promise<void>;
