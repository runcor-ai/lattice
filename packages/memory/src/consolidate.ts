import type { Database as SqliteDb } from 'better-sqlite3';

import { type DecaySweepResult } from './episodic-store.js';
import { Memory } from './memory.js';

/**
 * Consolidation — "the dream" (intent §7; spec FR-027).
 *
 * The single canonical episodic-memory pass:
 *   - Runs the episodic decay sweep (forget weak; promote strong).
 *   - Prunes the memory_index of orphan rows (subconscious-style
 *     cleanup that the fast-clock sweep also runs, idempotent here).
 *
 * Lives in @runcor/memory (the lowest common package) so BOTH callers use ONE implementation:
 *   - @runcor/slowclock's worker (the permanent home), and
 *   - @runcor/runtime's write phase (the temporary inline call site).
 * It has zero dependency on @runcor/runtime, so neither caller creates an import cycle.
 *
 * Idempotent: calling consolidate() twice in a row produces the same
 * end state as calling it once (spec FR-029).
 *
 * Each promoted episodic is written as a semantic memory with
 * source_kind='promoted' and source_ref pointing at the original
 * episodic id.
 */

export interface ConsolidateResult {
  readonly decay: DecaySweepResult;
  readonly promoted: number;
  readonly indexBefore: number;
  readonly indexAfter: number;
}

export interface ConsolidateContext {
  readonly cycle: number;
  readonly at_ms: number;
}

export function consolidate(db: SqliteDb, ctx: ConsolidateContext): ConsolidateResult {
  const memory = new Memory(db);
  const indexBefore = memory.index.size();

  let promotedCount = 0;
  const decay = memory.episodic.sweep(ctx.at_ms, undefined, (entry) => {
    memory.write(
      'semantic',
      {
        body: entry.body,
        why: `promoted from episodic id=${entry.id} after decay sweep`,
        admissionTag: 'decision',
        source_kind: 'promoted',
        source_ref: entry.id,
      },
      { cycle: ctx.cycle, at_ms: ctx.at_ms },
    );
    promotedCount += 1;
  });

  // Prune orphan index rows that point at episodic ids the decay sweep
  // just deleted. (Slice 6's subconscious sweep also catches these on
  // the fast clock; running it here keeps consolidation idempotent
  // even when no fast-clock cycle has run since the sweep.)
  db.prepare(
    `DELETE FROM memory_index
     WHERE memory_table = 'episodic'
       AND NOT EXISTS (SELECT 1 FROM memory_episodic WHERE id = memory_index.memory_id)`,
  ).run();

  const indexAfter = memory.index.size();
  return { decay, promoted: promotedCount, indexBefore, indexAfter };
}
