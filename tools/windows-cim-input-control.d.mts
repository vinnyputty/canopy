export interface CimInputControlRecord {
  variant: string;
  mode: string;
  ok: boolean;
  elapsedMs: number;
  timeoutMs: number;
  closed: boolean;
  phase: string;
  rows?: number;
  stderr: string;
  stdout?: string;
  error?: string;
  stderrEvents: { elapsedMs: number; bytes: number }[] | null;
}
export function runCimInputControls(options?: {
  command?: string;
  argsFor?: (script: string) => string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  report?: (record: CimInputControlRecord) => void;
}): Promise<CimInputControlRecord[]>;
