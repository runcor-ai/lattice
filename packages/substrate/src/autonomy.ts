import type { DiscernResult, Outcome } from './outcomes.js';

/**
 * autonomyResolve — the control on the discernment gate (spec FR-023;
 * constitution Principle VIII "Discernment and autonomy are one
 * system, not two").
 *
 * Mapping (outcome, autonomy) → resolved action:
 *
 *   autonomy=high
 *     pass     → execute
 *     modify   → execute (acceptedText already rewritten)
 *     block    → retry decide internally with reason
 *     escalate → retry decide internally with reason
 *
 *   autonomy=medium
 *     pass     → execute
 *     modify   → execute (acceptedText rewritten, log advisory)
 *     block    → wait_operator
 *     escalate → wait_operator
 *
 *   autonomy=low
 *     pass     → execute
 *     modify   → wait_operator
 *     block    → wait_operator
 *     escalate → wait_operator
 */
export type AutonomyLevel = 'low' | 'medium' | 'high';

export type ResolvedAction =
  | { action: 'execute'; note?: string }
  | { action: 'retry_decide'; reason: string }
  | { action: 'wait_operator'; reason: string };

export function autonomyResolve(
  discern: DiscernResult,
  autonomy: AutonomyLevel,
): ResolvedAction {
  const { outcome, findings } = discern;
  const reason = findings
    .filter((f) => f.outcome !== 'pass')
    .map((f) => `${f.law}:${f.outcome}: ${f.reason}`)
    .join('; ');

  if (outcome === 'pass') return { action: 'execute' };

  if (outcome === 'modify') {
    if (autonomy === 'low') {
      return { action: 'wait_operator', reason };
    }
    return { action: 'execute', note: reason };
  }

  // block or escalate
  if (autonomy === 'high') {
    return { action: 'retry_decide', reason };
  }
  return { action: 'wait_operator', reason };
}

/** Helper for tests / Bridge inspection. */
export function describeResolvedAction(r: ResolvedAction): string {
  if (r.action === 'execute') return r.note ? `execute (${r.note})` : 'execute';
  if (r.action === 'retry_decide') return `retry_decide: ${r.reason}`;
  return `wait_operator: ${r.reason}`;
}

/** Re-export Outcome for consumers that only import autonomy. */
export type { Outcome };
