import type { ChildProcess } from 'node:child_process';
export function powershellEnvironment(
  env?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;
export function windowsSnapshotScript(): string;
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
    killPid?: (pid: number, timeoutMs: number) => Promise<unknown>;
  });
  readonly operationsSettled: boolean;
  readonly retained: boolean;
  readonly child: ChildProcess | undefined;
  profile: string;
  launch<T>(operation: () => Promise<T>): Promise<T>;
  confirm(child: ChildProcess): void;
  restore(): void;
  retainProfile(): void;
  shutdown(
    close?: () => Promise<unknown>,
  ): Promise<{ terminated: boolean; errors: Error[] }>;
}
export function finishAudit(options: {
  owner: AuditOwner;
  close?: () => Promise<unknown>;
  primary?: unknown;
  /** Explicit caught-failure state, including thrown undefined. Defaults to primary !== undefined. */
  primaryFailed?: boolean;
  diagnostics?: { label: string; run: () => Promise<unknown> }[];
  removeProfile: () => Promise<unknown>;
  writeEvidence: () => Promise<unknown>;
  secondary?: (error: Error) => void;
  operationMs?: number;
  operationsSettled?: () => boolean;
}): Promise<void>;
