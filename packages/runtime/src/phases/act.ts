import { actOne, type ActContext } from '@runcor/capabilities';

import type { ActOutput, CycleContext, DecideOutput } from '../types.js';

/**
 * act — slice 10 wires the rich Capability gate (`actOne`):
 *   - At most ONE capability per cycle (spec FR-004).
 *   - canInvoke() permission check before invoke.
 *   - 'denied' / 'failed' / 'no-action' / 'ok' outcomes.
 *
 * Slice 12 plumbs real budget; slice 14 reads the autonomy dial
 * straight from the entity table.
 */
export async function act(ctx: CycleContext, prev: DecideOutput): Promise<ActOutput> {
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
