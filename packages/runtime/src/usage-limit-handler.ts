import type { ModelBackendError } from '@runcor/engine';
import type { Trace } from '@runcor/trace';

/**
 * Usage-limit handler (intent §14 operator note; analyze C5).
 *
 * When the model backend returns `usage_limit`, the lattice must:
 *   - mark the current act as failed,
 *   - if a job item is in flight, DEFER it via the jobs API with
 *     unblock condition "usage window resets at <ts>",
 *   - emit an operator alert via the trace,
 *   - let subsequent cycles continue for non-model work
 *     (perception + trace-writes).
 *
 * The deferral path is callback-style so this module doesn't have to
 * depend on `@runcor/jobs` (avoids a directional cycle); the caller
 * (Bridge / runtime composition) passes a `deferActiveItem` fn.
 */

export interface UsageLimitContext {
  readonly trace: Trace;
  readonly cycle: number;
  readonly at_ms: number;
  /** Optional active item descriptor — when a job is in flight. */
  readonly activeItemId?: string;
  /** Deferral callback. Invoked only when activeItemId is provided. */
  readonly deferActiveItem?: (args: {
    itemId: string;
    reason: string;
    unblockCondition: string;
    unblockTest: string;
  }) => void;
}

export interface UsageLimitOutcome {
  readonly deferredItemId?: string;
  readonly operatorAlert: string;
  readonly resetAt?: string;
}

/** Try to read a reset time out of the error message. */
export function extractReset(message: string): string | undefined {
  const m = /resets? at\s+([^)\s]+)/i.exec(message);
  return m ? m[1] : undefined;
}

export function handleUsageLimit(
  err: ModelBackendError,
  ctx: UsageLimitContext,
): UsageLimitOutcome {
  const resetAt = extractReset(err.message);
  const reason = `model backend hit a usage limit at cycle ${ctx.cycle}${resetAt ? `; usage window resets at ${resetAt}` : ''}`;

  let deferredItemId: string | undefined;
  if (ctx.activeItemId && ctx.deferActiveItem) {
    const unblockTest = JSON.stringify(
      resetAt
        ? { kind: 'cycle_after', cycle: ctx.cycle + 10 }
        : { kind: 'cycle_after', cycle: ctx.cycle + 5 },
    );
    try {
      ctx.deferActiveItem({
        itemId: ctx.activeItemId,
        reason,
        unblockCondition: resetAt ? `usage window resets at ${resetAt}` : 'usage window resets',
        unblockTest,
      });
      deferredItemId = ctx.activeItemId;
    } catch {
      // Deferral validation may reject — fall through to the operator alert.
    }
  }

  const alert = `usage-limit: ${reason}${deferredItemId ? ` (item ${deferredItemId} deferred)` : ''}`;
  ctx.trace.write({
    kind: 'operator',
    cycle: ctx.cycle,
    at_ms: ctx.at_ms,
    action: 'lifecycle',
    detail: alert,
  });

  return {
    operatorAlert: alert,
    ...(deferredItemId ? { deferredItemId } : {}),
    ...(resetAt ? { resetAt } : {}),
  };
}
