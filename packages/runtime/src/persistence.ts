import { createHash } from 'node:crypto';

import type { Db } from './db.js';

/**
 * Persistence substrate law (Item 6).
 *
 * The lattice cannot dispatch the same action with the same inputs twice
 * within a short rolling window. The source doc recorded `ls /workspace`
 * run six times in a row and `find ... -name v1-spec.md` four times in a
 * row: each individual call succeeded, so nothing blocked it, and each
 * cycle re-derived the decision from incomplete context. This is the
 * substrate-level fix — enforcement, not advice: the runtime simply
 * refuses the duplicate and forces the lattice to change strategy.
 *
 * Only SUCCESSFULLY-dispatched actions are recorded (see act.ts), so the
 * no-op idle action, failed actions, and denied actions are naturally
 * exempt — idling and retry-after-failure keep working, while redundant
 * repeats and duplicate appends are blocked.
 */

export const PERSISTENCE_WINDOW = 10;

/** Stable hash of an action's inputs: canonical (key-sorted) JSON → sha256. */
export function hashActionInput(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.keys(val as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = (val as Record<string, unknown>)[k];
            return acc;
          }, {})
      : val,
  );
}

/**
 * True when (actionName, inputHash) was recorded within the window ending
 * at `cycle`. An entry at cycle E violates a check at cycle N when
 * E > N - window.
 */
export function isPersistenceViolation(
  db: Db,
  actionName: string,
  inputHash: string,
  cycle: number,
  window = PERSISTENCE_WINDOW,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM recent_action WHERE action_name = ? AND input_hash = ? AND cycle > ? LIMIT 1`,
    )
    .get(actionName, inputHash, cycle - window);
  return row !== undefined;
}

/** Record a dispatched action and prune entries that have aged out of the window. */
export function recordAction(
  db: Db,
  actionName: string,
  inputHash: string,
  cycle: number,
  window = PERSISTENCE_WINDOW,
): void {
  db.prepare(`INSERT INTO recent_action (cycle, action_name, input_hash) VALUES (?, ?, ?)`).run(
    cycle,
    actionName,
    inputHash,
  );
  db.prepare(`DELETE FROM recent_action WHERE cycle <= ?`).run(cycle - window);
}
