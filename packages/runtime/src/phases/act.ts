import { actOne, type ActContext } from '@runcor/capabilities';
import { JobsService } from '@runcor/jobs';

import {
  awaitingOperator,
  dominantRecentAction,
  isReadCapped,
  NO_PROGRESS_ESCALATE,
  NO_PROGRESS_THRESHOLD,
  readNoProgressCycles,
  recordSignalRead,
} from '../no-progress.js';
import type { Db } from '../db.js';
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
/**
 * gap-E circuit-breaker helper. Defer every OPEN item of every OPEN job via the
 * existing checklist machinery (markDeferred → state 'deferred' + reason). Leaving
 * a job with no open items lets the write-phase auto-close finish it (closed_partial),
 * which drops the lattice into the existing paused_no_jobs idle. Best-effort: any
 * schema/edge failure is swallowed so the park (caller's return) still happens.
 */
function deferOpenJobItems(db: Db, cycle: number, reason: string): number {
  let n = 0;
  try {
    const jobs = new JobsService(db);
    const openJobs = db.prepare(`SELECT id FROM plan_job WHERE status = 'open'`).all() as Array<{ id: string }>;
    for (const { id } of openJobs) {
      for (const item of jobs.checklist.items(id)) {
        if (item.state === 'open') {
          jobs.checklist.markDeferred(item.id, {
            cycle,
            reason,
            unblockCondition: 'new work or signal arrives (next feed cycle), or an operator reopens the item',
            unblockTest: 'a new job is posted to this lattice',
          });
          n += 1;
        }
      }
    }
  } catch {
    /* minimal/edge schema — caller still parks via its return */
  }
  return n;
}

export async function act(ctx: CycleContext, prev: DecideOutput): Promise<ActOutput> {
  const db = (ctx.memory as RuntimeMemoryAdapter).dbHandle();
  const inputHash = prev.chosenAction ? hashActionInput(prev.chosenInput) : '';

  // Operator-attestation rest state. When the only open item(s) are operator-source
  // (architect-uncloseable), the architect is RESTING, not stalling — it must wait for
  // the operator's /attest, an unbounded wait by design. Exempt it from EVERY
  // no-progress consequence (persistence block, THRESHOLD block, ESCALATE park) so a
  // legitimate noop-and-wait is not punished into churn — and so ESCALATE cannot defer
  // the operator item itself. `awaitingOperator` is false the instant any non-operator
  // item is open, so genuine stalls stay fully guarded.
  const resting = awaitingOperator(db);

  if (prev.chosenAction && !resting && isPersistenceViolation(db, prev.chosenAction, inputHash, ctx.cycle)) {
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
      actFailureKind: 'persistence',
      actFailedReason: `Persistence violation: "${prev.chosenAction}" with identical inputs was already attempted in the last ${PERSISTENCE_WINDOW} cycles. Choose a different action.`,
    };
  }

  // Item 15 — no-progress law. Two thresholds:
  //   THRESHOLD (N): refuse the dominant (stalled) action to force a posture change.
  //   ESCALATE (2N): the stall is terminal — take an autonomous TERMINAL action.
  // Persistence cannot see this — the stalled action's inputs vary cycle to cycle;
  // what is constant is the lack of movement.
  const noProgress = readNoProgressCycles(db);

  // gap E (circuit-breaker, Finding #13). At ESCALATE the floor must END the stall,
  // not just nudge: the live failure showed the entity DODGES the per-action block by
  // alternating actions (ledger ↔ append-plan-item), so a block alone never terminates
  // it — it spun 140 cycles. So, REGARDLESS of which action is chosen, auto-defer the
  // open job item(s) with a logged reason. The write phase's existing auto-close then
  // closes the now-itemless job (closed_partial at high autonomy) → the lattice falls
  // into the EXISTING paused_no_jobs idle → the next job (e.g. next feed cycle)
  // auto-resumes it. This is the necessary partner to the #12 confabulation gate: the
  // gate refuses a bad/unsupported commit, and E ends the resulting stall by PARKING
  // honestly instead of spinning. Without E, every gate refusal becomes a spin.
  if (!resting && noProgress >= NO_PROGRESS_ESCALATE) {
    const reason = `no-progress circuit-breaker: ${noProgress} cycles without any item closing or gate clearing — autonomous park`;
    const deferred = deferOpenJobItems(db, ctx.cycle, reason);
    ctx.trace.write({
      kind: 'substrate',
      cycle: ctx.cycle,
      at_ms: ctx.at_ms,
      phase: 'act',
      outcome: 'escalate',
      law: 'no-progress',
      reason: `${noProgress} cycles without progress; deferred ${deferred} open item(s) and parked to idle (gap-E circuit-breaker)`,
    });
    return {
      ...prev,
      actResult: 'failed',
      actFailureKind: 'no-progress',
      actFailedReason: `No-progress circuit-breaker: deferred ${deferred} open item(s) after ${noProgress} cycles without progress. Parked to idle — will resume when new work/signal arrives.`,
    };
  }

  if (prev.chosenAction && !resting && noProgress >= NO_PROGRESS_THRESHOLD) {
    const dominant = dominantRecentAction(db);
    if (dominant && prev.chosenAction === dominant) {
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
        actFailureKind: 'no-progress',
        actFailedReason: `No-progress intervention: ${noProgress} cycles without any item closing or gate clearing. "${prev.chosenAction}" is the stalled approach — do NOT repeat it. Change posture: delegate the work differently, re-brief the open item with a sharper gate, verify what already exists, or escalate.`,
      };
    }
  }

  // Read-cap (Finding #16). Re-reading an already-held signal is the dodge the entity
  // uses instead of committing under ambiguity (posture alone could not stop it). Once a
  // read-action has consumed a path this run, cap re-reads of that exact (action|path) so
  // the only productive move left is to WRITE — and the gate-valid HELD-CAVEAT path is the
  // honest thing to write. SAFE because #12 stands: a forced write cannot fabricate a
  // revision (gate rejects unsupported REVISED and kill-condition-met HELD-CAVEAT). A first
  // read and reading genuinely NEW signal are never capped; a commit (item close) resets it.
  const readCap = prev.chosenAction ? ctx.actions.find((a) => a.name === prev.chosenAction) : undefined;
  const readPath = typeof (prev.chosenInput as { path?: unknown } | undefined)?.path === 'string'
    ? (prev.chosenInput as { path: string }).path
    : '';
  const readKey = readCap?.readOnly && readPath ? `${prev.chosenAction}|${readPath}` : '';
  if (readKey && isReadCapped(db, readKey)) {
    ctx.trace.write({
      kind: 'substrate',
      cycle: ctx.cycle,
      at_ms: ctx.at_ms,
      phase: 'act',
      outcome: 'block',
      law: 'read-cap',
      reason: `already read "${readPath}" this run; you hold it — commit (REVISE/HOLD/HELD-CAVEAT) instead of re-reading`,
    });
    return {
      ...prev,
      actResult: 'failed',
      actFailureKind: 'read-cap',
      actFailedReason: `Read-cap: you already read "${readPath}" this run — you HOLD its content. Re-reading is capped to force a decision. Reason over what you hold and COMMIT now: REVISE (if the kill-condition is met) / HOLD / HELD-CAVEAT (if the signal pressures a call but the kill-condition is not yet met). Do NOT re-read.`,
    };
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
      // close-job-item returns out.data with outcome ∈ { 'passed', 'blocked',
      // 'failed_iterating', 'judgement_required', 'iteration_cap_exceeded' }.
      // A non-'passed' outcome means the close DID NOT transition the item —
      // typically because attemptCheck found an unsatisfied blocked_by link
      // (see jobs/src/service.ts:103). Without this branch the capability's
      // out.result='ok' lets the cycle record actResult='ok' and the next
      // cycle's recent-actions memory tells the architect "close-job-item:
      // ok" — masking the silent stall observed in abc-architect-run-2 where
      // the architect picked transitively-blocked items 5 cycles in a row.
      // Downgrading to 'failed' + actFailedReason routes the reason through
      // the existing failed-shape so the write-phase memory clock surfaces
      // it next cycle and the architect can reroute. Narrowly scoped to
      // close-job-item: other actions don't carry passed/blocked semantics.
      if (
        prev.chosenAction === 'close-job-item' &&
        out.data &&
        typeof (out.data as { outcome?: unknown }).outcome === 'string' &&
        (out.data as { outcome: string }).outcome !== 'passed'
      ) {
        const d = out.data as { itemId: string; outcome: string; reason?: string };
        return {
          ...prev,
          actResult: 'failed',
          // FIX-006: close-job-item's silent-blocked downgrade is a
          // capability-outcome mismatch, not a substrate refusal or an exec
          // error. Categorising as 'exec_error' keeps it in the "capability
          // returned a bad shape / did not do what was asked" bucket.
          actFailureKind: 'exec_error',
          actFailedReason: `close-job-item ${d.itemId.slice(0, 8)} → ${d.outcome}: ${d.reason ?? '(no reason)'}`,
          actData: out.data,
        };
      }
      // Record dispatched (ok) actions for the Persistence law. NOTE: the no-op
      // idle action returns 'ok' and IS recorded, so a repeated identical noop is
      // itself persistence-blocked — it is NOT exempt. Legitimate rest at the
      // operator-attestation halt is handled by the `resting` (awaitingOperator)
      // exemption above, not by non-recording here. Only failed/denied are
      // naturally exempt (they never reach this line).
      if (prev.chosenAction) recordAction(db, prev.chosenAction, inputHash, ctx.cycle);
      // First successful read of a signal is recorded → a re-read of it is capped (#16).
      if (readKey) recordSignalRead(db, readKey, ctx.cycle);
      return { ...prev, actResult: 'ok', actData: out.data };
    case 'no-action':
      return { ...prev, actResult: 'no-action' };
    case 'denied':
      return { ...prev, actResult: 'failed', actFailureKind: 'denied', actFailedReason: `denied: ${out.reason}` };
    case 'failed':
      // FIX-006: actOne now carries a kind on 'failed' — 'action_not_found'
      // (structural lookup miss) vs 'exec_error' (invoke() threw). Propagate
      // it so the phase-runner's output_summary can distinguish the two.
      return { ...prev, actResult: 'failed', actFailureKind: out.kind, actFailedReason: out.reason };
    default: {
      const _exhaustive: never = out;
      return _exhaustive;
    }
  }
}
