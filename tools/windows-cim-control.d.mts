import type { spawnSync } from 'node:child_process';
export interface CimControlRecord {
  mode: string;
  ok: boolean;
  elapsedMs: number;
  timeoutMs: number;
  phase: string;
  rows?: number;
  stderr: string;
  error?: string;
}
export function runCimModuleControls(options?: {
  spawn?: typeof spawnSync;
  env?: NodeJS.ProcessEnv;
  report?: (record: CimControlRecord) => void;
}): CimControlRecord[];
