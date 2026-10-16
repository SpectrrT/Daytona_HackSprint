import type { CandidateVariant, ExecutionProvider, FailureEvidence, FrozenContract } from "@hollow-purple/shared/evolution";

/** The builder may change source and variant; the verifier retains the frozen contract. */
export interface CandidateTaskContext {
  runId: string;
  candidateId: string;
  variant: CandidateVariant;
  provider: ExecutionProvider;
  contract: Readonly<FrozenContract>;
  regressions: readonly FailureEvidence[];
  seed: number;
  signal: AbortSignal;
}

export class StoppedError extends Error {
  constructor() { super("Run stopped by the user."); this.name = "StoppedError"; }
}
export function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new StoppedError();
}
export function clip(text: string, max = 12_000): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…[${text.length - max} characters omitted]…\n${text.slice(-half)}`;
}
