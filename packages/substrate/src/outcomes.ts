import type { LawId } from './laws.js';

/**
 * The four discernment outcomes (constitution Principle VIII; spec
 * FR-020/FR-021).
 *
 *   pass     — output is admissible as-is.
 *   modify   — output rewritten to fix the issue.
 *   block    — output rejected; reason logged.
 *   escalate — held for human review (low autonomy).
 *
 * Reality and Constraint violations ALWAYS produce block.
 * Uncertainty produces a warning (pass with annotation).
 * Simplicity is advisory only — never blocks.
 */
export type Outcome = 'pass' | 'modify' | 'block' | 'escalate';

export interface LawFinding {
  readonly law: LawId;
  /** code, llm, or both. Slice 5 ships code-only. */
  readonly source: 'code' | 'llm';
  readonly outcome: Outcome;
  /** Why this finding was raised. Never empty. */
  readonly reason: string;
  /** Suggested rewrite when outcome === 'modify'. */
  readonly modified?: string;
}

export interface DiscernResult {
  /** Overall outcome — the worst of all findings (block > escalate > modify > pass). */
  readonly outcome: Outcome;
  /** Every law's finding (one per law, in canonical order). */
  readonly findings: readonly LawFinding[];
  /** The accepted output text (possibly rewritten when overall=modify). */
  readonly acceptedText: string;
}

const SEVERITY: Record<Outcome, number> = {
  pass: 0,
  modify: 1,
  escalate: 2,
  block: 3,
};

export function combine(findings: readonly LawFinding[]): Outcome {
  let worst: Outcome = 'pass';
  for (const f of findings) {
    if (SEVERITY[f.outcome] > SEVERITY[worst]) worst = f.outcome;
  }
  return worst;
}
