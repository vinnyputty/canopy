export interface CimInputControlRecord {
  variant: string;
  mode: string;
  ok: boolean;
  elapsedMs: number;
  timeoutMs: number;
  operationFailed: boolean;
  status: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  closed: boolean;
  cleanupCodes: string[];
  childPid: number | null;
  phase: string;
  rows?: number;
  error?: string;
  code: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  stderrEvents: { elapsedMs: number; bytes: number }[] | null;
}
export function runCimInputControls(options?: {
  command?: string;
  argsFor?: (script: string) => string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  report?: (record: CimInputControlRecord) => void;
}): Promise<CimInputControlRecord[]>;

export function runCimContextControls(options?: {
  command?: string;
  argsFor?: (script: string) => string[];
  env?: NodeJS.ProcessEnv;
  report?: (record: {
    mode: string;
    ok: boolean;
    error?: string;
    closed: boolean;
    metadata?: Record<string, unknown>;
    childPid?: number | null;
  }) => void;
}): Promise<
  {
    mode: string;
    ok: boolean;
    error?: string;
    closed: boolean;
    metadata?: Record<string, unknown>;
    childPid?: number | null;
  }[]
>;
