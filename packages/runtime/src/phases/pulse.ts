import type { CycleContext, PulseOutput, WriteOutput } from '../types.js';

/**
 * Slice 1 pulse: ALWAYS returns `{ continue: true }`. FR-003 forbids
 * any termination condition firing from inside the loop. The only
 * legitimate stops are operator stop, process kill, or unrecoverable
 * substrate fault — none of which originate here.
 *
 * Slice 2 adds the minimal drive pulse update (no exit semantics; the
 * pulse force shapes future behaviour, not termination).
 */
export async function pulse(
  _ctx: CycleContext,
  _prev: WriteOutput,
): Promise<PulseOutput> {
  return { continue: true };
}
