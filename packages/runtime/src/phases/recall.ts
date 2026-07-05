import type { CycleContext, GroundOutput, RecallOutput } from '../types.js';

/**
 * Slice 1 recall: pulls a tiny window of recent episodic memories.
 *
 * Real recall (index-plus-cheap-selector with a Decider, freshness
 * caveats, the four memory systems) lands in slice 4.
 *
 * Bug-2 fix: recall now REINFORCES the pulled window (increments access_count / sets
 * last_access_ms) via reinforceRecalled — the "record an access" step this stub previously
 * omitted, which left f=0 and collapsed decay durability M=R·ln(f+1)·… to 0 for every memory.
 */
export async function recall(
  ctx: CycleContext,
  prev: GroundOutput,
): Promise<RecallOutput> {
  const memories = ctx.recall.reinforceRecalled(8, ctx.at_ms);
  return { ...prev, memories };
}
