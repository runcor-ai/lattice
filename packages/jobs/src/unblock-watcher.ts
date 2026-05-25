import type { Database as SqliteDb } from 'better-sqlite3';

import type { Item, UnblockTestSpec } from './types.js';

/**
 * Unblock-watcher (spec FR-038).
 *
 * Called by the runtime's `observe` phase. For each deferred item,
 * evaluates its `unblock_test` against the current perception
 * snapshot. Items whose tests now succeed are reported back —
 * `observe` does NOT clear their deferred state; that's the decide
 * phase's choice (no mid-cycle interruption).
 *
 * Slice 9's test DSL is a small JSON spec; slice 11 can generalise
 * to predicate expressions over reality.
 */

export interface PerceptionLike {
  /** Map of sense name → reading; reading has at least { result, data }. */
  readonly senses: Record<string, { result: 'ok' | 'failed' | 'stale'; data: unknown }>;
  readonly cycle: number;
}

export interface UnblockedItem {
  readonly item: Item;
  readonly testSpec: UnblockTestSpec;
}

export function checkUnblocked(
  db: SqliteDb,
  perception: PerceptionLike,
): readonly UnblockedItem[] {
  const deferred = db
    .prepare<[]>(
      `SELECT * FROM plan_item WHERE state = 'deferred' AND unblock_test IS NOT NULL`,
    )
    .all() as Item[];
  const unblocked: UnblockedItem[] = [];
  for (const item of deferred) {
    if (!item.unblock_test) continue;
    let spec: UnblockTestSpec;
    try {
      spec = JSON.parse(item.unblock_test) as UnblockTestSpec;
    } catch {
      continue;
    }
    if (evaluate(spec, perception)) {
      unblocked.push({ item, testSpec: spec });
    }
  }
  return unblocked;
}

function evaluate(spec: UnblockTestSpec, perception: PerceptionLike): boolean {
  switch (spec.kind) {
    case 'sense_present': {
      const r = perception.senses[spec.sense];
      return r !== undefined && r.result === 'ok';
    }
    case 'sense_data_contains': {
      const r = perception.senses[spec.sense];
      if (!r || r.result !== 'ok') return false;
      const data = r.data;
      if (typeof data === 'string') return data.includes(spec.needle);
      try {
        return JSON.stringify(data).includes(spec.needle);
      } catch {
        return false;
      }
    }
    case 'cycle_after': {
      return perception.cycle > spec.cycle;
    }
    default: {
      const _exhaustive: never = spec;
      return _exhaustive;
    }
  }
}
