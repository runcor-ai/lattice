import type { CycleContext, ObserveOutput, RecallOutput } from '../types.js';

/**
 * Slice 1 recall: pulls a tiny window of recent episodic memories.
 *
 * Real recall (index-plus-cheap-selector with a Decider, freshness
 * caveats, the four memory systems) lands in slice 4.
 *
 * FIX-008 (2026-07-18): recall now runs BEFORE ground (was: after). The
 * new phase order is observe → recall → ground → decide, so the memories
 * produced here flow into ground, which injects them into the grounded
 * prompt. Previously recall ran after ground, and the memories never
 * reached the LLM through decide (which sends ground's pre-recall prompt).
 *
 * Bug-2 fix: recall now REINFORCES the pulled window (increments access_count / sets
 * last_access_ms) via reinforceRecalled — the "record an access" step this stub previously
 * omitted, which left f=0 and collapsed decay durability M=R·ln(f+1)·… to 0 for every memory.
 */
export async function recall(
  ctx: CycleContext,
  prev: ObserveOutput,
): Promise<RecallOutput> {
  const memories = ctx.recall.reinforceRecalled(8, ctx.at_ms);
  return { ...prev, memories };
}
