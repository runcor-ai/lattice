import type { CycleContext, GroundOutput, RecallOutput } from '../types.js';

/**
 * Slice 1 recall: pulls a tiny window of recent episodic memories.
 *
 * Real recall (index-plus-cheap-selector with a Decider, freshness
 * caveats, the four memory systems) lands in slice 4.
 */
export async function recall(
  _ctx: CycleContext,
  prev: GroundOutput,
): Promise<RecallOutput> {
  const memories = _ctx.recall.recentEpisodic(8);
  return { ...prev, memories };
}
