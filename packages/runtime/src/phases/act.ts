import { actOne, type ActContext } from '@runcor/capabilities';

import {
  dominantRecentAction,
  NO_PROGRESS_ESCALATE,
  NO_PROGRESS_THRESHOLD,
  readNoProgressCycles,
} from '../no-progress.js';
import { hashActionInput, isPersistenceViolation, PERSISTENCE_WINDOW, recordAction } from '../persistence.js';
import type { RuntimeMemoryAdapter } from '../sqlite-memory.js';
import type { ActOutput, CycleContext, DecideOutput } from '../types.js';

/**
 * act — slice 10 wires the rich Capability gate (`actOne`):
 *   - At most ONE capability per cycle (spec FR-004).
 *   - canInvoke() permission check before invoke.
 *   - 'denied' / 'failed' / 'no-action' / 'ok' outcomes.
 *
 * Item 6 — the Persistence substrate law runs at the TOP of dispatch:
 * an exact (action, inputs) repeat within the rolling window is refused
 * before invoke, with a forced substrate-violation trace, so the lattice
 * must choose differently. Only successfully-dispatched actions are
 * recorded, so no-op idling and retry-after-failure stay legal.
 *
 * Slice 12 plumbs real budget; slice 14 reads the autonomy dial
 * straight from the entity table.
 */
export async function act(ctx: CycleContext, prev: DecideOutput): Promise<ActOutput> {
  const db = (ctx.memory as RuntimeMemoryAdapter).dbHandle();
  const inputHash = prev.chosenAction ? hashActionInput(prev.chosenInput) : '';

  if (prev.chosenAction && isPersistenceViolation(db, prev.chosenAction, inputHash, ctx.cycle)) {
    ctx.trace.write({
      kind: 'substrate',
      cycle: ctx.cycle,
      at_ms: ctx.at_ms,
      phase: 'act',
      outcome: 'block',
      law: 'persistence',
      reason: `action "${prev.chosenAction}" with identical inputs was already dispatched within the last ${PERSISTENCE_WINDOW} cycles`,
    });
    return {
      ...prev,
      actResult: 'failed',
      actFailedReason: `Persistence violation: "${prev.chosenAction}" with identical inputs was already attempted in the last ${PERSISTENCE_WINDOW} cycles. Choose a different action.`,
    };
  }

  // Item 15 — no-progress law. If the work has stalled (no open-job item
  // or gate has moved for >= N cycles) and the lattice keeps choosing the
  // dominant (stalled) action, refuse it to force a posture change. At 2N,
  // also escalate. Persistence cannot see this — the stalled action's
  // inputs vary cycle to cycle; what is constant is the lack of movement.
  const noProgress = readNoProgressCycles(db);
  if (prev.chosenAction && noProgress >= NO_PROGRESS_THRESHOLD) {
    const dominant = dominantRecentAction(db);
    if (dominant && prev.chosenAction === dominant) {
      if (noProgress >= NO_PROGRESS_ESCALATE) {
        ctx.trace.write({
          kind: 'substrate',
          cycle: ctx.cycle,
          at_ms: ctx.at_ms,
          phase: 'act',
          outcome: 'escalate',
          law: 'no-progress',
          reason: `${noProgress} cycles without item/gate progress; escalating to operator`,
        });
      }
      ctx.trace.write({
        kind: 'substrate',
        cycle: ctx.cycle,
        at_ms: ctx.at_ms,
        phase: 'act',
        outcome: 'block',
        law: 'no-progress',
        reason: `${noProgress} cycles without any item closing or gate clearing; "${prev.chosenAction}" is the stalled approach`,
      });
      return {
        ...prev,
        actResult: 'failed',
        actFailedReason: `No-progress intervention: ${noProgress} cycles without any item closing or gate clearing. "${prev.chosenAction}" is the stalled approach — do NOT repeat it. Change posture: delegate the work differently, re-brief the open item with a sharper gate, verify what already exists, or escalate.`,
      };
    }
  }

  const actCtx: ActContext = {
    cycle: ctx.cycle,
    lastReadAtMs: null,
    abortSignal: ctx.abortSignal,
    budgetRemaining: Number.POSITIVE_INFINITY,
    autonomy: ctx.autonomy,
  };
  const out = await actOne({
    chosenAction: prev.chosenAction,
    input: prev.chosenInput,
    actions: ctx.actions,
    ctx: actCtx,
  });

  switch (out.result) {
    case 'ok':
      // Record only dispatched (ok) actions — this is what makes idle/
      // failed/denied naturally exempt from the Persistence law.
      if (prev.chosenAction) recordAction(db, prev.chosenAction, inputHash, ctx.cycle);
      return { ...prev, actResult: 'ok', actData: out.data };
    case 'no-action':
      return { ...prev, actResult: 'no-action' };
    case 'denied':
      return { ...prev, actResult: 'failed', actFailedReason: `denied: ${out.reason}` };
    case 'failed':
      return { ...prev, actResult: 'failed', actFailedReason: out.reason };
    default: {
      const _exhaustive: never = out;
      return _exhaustive;
    }
  }
}
