import { autonomyResolve, discern, type DiscernContext } from '@runcor/substrate';

import type { ActOutput, CycleContext, JudgeOutput } from '../types.js';

/**
 * judge — substrate discernment on the decide output (slice 5).
 *
 * Spec FR-020 / FR-021 / FR-023 / constitution Principle VIII.
 *
 * The gate evaluates the model's output text against the eleven laws
 * (code-first; LLM fallback wired in slice 8). The autonomy dial then
 * resolves what to do with the outcome:
 *   - execute       — accept and proceed
 *   - retry_decide  — at autonomy=high, re-decide internally
 *   - wait_operator — at autonomy=low/medium, escalate via the trace
 *
 * Substrate flags are recorded to the trace as kind='substrate' so
 * the operator can audit every block/modify/escalate decision
 * (spec FR-049).
 *
 * Slice 5 does NOT implement decide-iteration; the cycle continues
 * after recording. Iteration lands in slice 9 (jobs); operator
 * confirmation lands in slice 14 (Bridge).
 */
export async function judge(
  ctx: CycleContext,
  prev: ActOutput,
): Promise<JudgeOutput> {
  const discernCtx: DiscernContext = {
    realityEntities: realityEntitiesFor(prev),
    constraintSummary: ctx.identity.composed_body,
    recalledMemoryIds: new Set(prev.memories.map((_m, i) => `recalled-${i}`)),
    dials: { autonomy: ctx.autonomy },
  };

  const result = await discern(prev.decisionText, discernCtx);
  const resolved = autonomyResolve(result, ctx.autonomy);

  // Record per-law non-pass findings to the trace.
  for (const f of result.findings) {
    if (f.outcome !== 'pass') {
      ctx.trace.write({
        kind: 'substrate',
        cycle: ctx.cycle,
        at_ms: ctx.at_ms,
        phase: 'judge',
        outcome: f.outcome,
        law: f.law,
        reason: f.reason,
      });
    }
  }
  // Also record the overall resolved action when it isn't a clean
  // execute, so the operator's audit trail shows it.
  if (resolved.action !== 'execute') {
    ctx.trace.write({
      kind: 'substrate',
      cycle: ctx.cycle,
      at_ms: ctx.at_ms,
      phase: 'judge',
      outcome: result.outcome,
      reason:
        resolved.action === 'retry_decide'
          ? `auto-retry (autonomy=${ctx.autonomy}): ${resolved.reason}`
          : `await operator (autonomy=${ctx.autonomy}): ${resolved.reason}`,
    });
  }

  return {
    ...prev,
    judgement: result.outcome,
    discernment: result,
    resolution: resolved.action,
  };
}

/**
 * The "reality slice" — entities known to be present this cycle.
 * Slice 5 uses the capability names (perception sources). Slice 11
 * expands this to include goals, peers, and active commitments.
 */
function realityEntitiesFor(prev: ActOutput): ReadonlySet<string> {
  const set = new Set<string>();
  for (const cap of Object.keys(prev.perception.senses)) set.add(cap);
  // Also admit any quoted names the lattice's identity uses.
  return set;
}
