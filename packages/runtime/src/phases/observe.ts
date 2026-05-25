import { Perception } from '@runcor/capabilities';

import type { CycleContext, ObserveOutput } from '../types.js';

/**
 * observe — slice 10 wires the full `Perception` module:
 *   - parallel sense reads with per-sense timeout
 *   - stale handling (cached prior reading)
 *   - automatic, never paused by a single failure (FR-005)
 *
 * Slice 11 will fold the unblock-watcher's findings (jobs) into the
 * `unblocked_items` field — but the data path is already in place.
 */

let sharedPerception: Perception | null = null;

function perceptionFor(_ctx: CycleContext): Perception {
  // The Perception holds a freshness cache across cycles; share one
  // instance per lattice. Lattice rebuilds this on construction; tests
  // share within a single Lattice. For the runtime's stateless cycle
  // function we lazy-init a module-level cache for now.
  // Slice 11 will hoist this onto the Lattice itself.
  if (!sharedPerception) sharedPerception = new Perception();
  return sharedPerception;
}

export async function observe(ctx: CycleContext): Promise<ObserveOutput> {
  const perc = perceptionFor(ctx);
  const snapshot = await perc.observe(ctx.senses, {
    cycle: ctx.cycle,
    lastReadAtMs: null,
    abortSignal: ctx.abortSignal,
  });
  return { perception: snapshot };
}
