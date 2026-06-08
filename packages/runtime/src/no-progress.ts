import { createHash } from 'node:crypto';

import type { Db } from './db.js';

/**
 * No-progress substrate law (Item 15).
 *
 * Sibling to the Persistence law (Item 6). Persistence triggers on the
 * PRESENCE OF REPETITION — the same action with the same inputs. This
 * triggers on the ABSENCE OF PROGRESS. The signal is not action sameness;
 * it is whether the work is MOVING: plan_item state changes and gate
 * clearing. The 2026-06-06 live run chose `workspace` 56 of 60 cycles with
 * ZERO Persistence blocks (each write had slightly different inputs) and
 * made zero deliverable progress for 45 cycles. Persistence is blind to
 * that; this law is not.
 *
 * A cycle "made progress" iff the set of (item_id, state) across the open
 * jobs changed since last cycle — a state transition (open→passed/deferred,
 * blocked→unblocked) or a newly-appended item. Re-writing the plan file
 * does NOT change item state, so it does NOT count as progress. When the
 * no-progress counter reaches a threshold the runtime blocks the dominant
 * action and forces a posture change; at a higher threshold it escalates.
 */

export const NO_PROGRESS_THRESHOLD = 12;
export const NO_PROGRESS_ESCALATE = 24;

function tableExists(db: Db, name: string): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== undefined;
}

/**
 * A signature of the open jobs' item states. Empty string when there are
 * no open jobs (not stalled — Item 9 idle-pauses that case).
 */
export function openJobItemSignature(db: Db): string {
  if (!tableExists(db, 'plan_item')) return '';
  const rows = db
    .prepare(
      `SELECT pi.id AS id, pi.state AS state
         FROM plan_item pi JOIN plan_job pj ON pi.job_id = pj.id
        WHERE pj.status = 'open'
        ORDER BY pi.id`,
    )
    .all() as Array<{ id: string; state: string }>;
  if (rows.length === 0) return '';
  return createHash('sha256').update(rows.map((r) => `${r.id}:${r.state}`).join('|')).digest('hex');
}

/** Consecutive no-progress cycles as of the last `recordProgress`. */
export function readNoProgressCycles(db: Db): number {
  if (!tableExists(db, 'progress_state')) return 0;
  const r = db.prepare(`SELECT no_progress_cycles AS c FROM progress_state WHERE id='self'`).get() as
    | { c: number }
    | undefined;
  return r ? r.c : 0;
}

/**
 * Called at end of cycle. Compares the open-job item signature to last
 * cycle's: unchanged (and a job is open) → increment; changed or no open
 * jobs → reset to 0. Returns the updated count.
 */
export function recordProgress(db: Db): number {
  if (!tableExists(db, 'progress_state')) return 0;
  const sig = openJobItemSignature(db);
  const prev = db.prepare(`SELECT no_progress_cycles AS c, last_signature AS s FROM progress_state WHERE id='self'`).get() as
    | { c: number; s: string }
    | undefined;
  let count: number;
  if (sig === '') count = 0; // no open jobs — not stalled
  else if (prev && sig === prev.s) count = prev.c + 1; // item/gate state unchanged — no progress
  else count = 0; // moved — progress
  db.prepare(
    `INSERT INTO progress_state (id, no_progress_cycles, last_signature)
     VALUES ('self', ?, ?)
     ON CONFLICT(id) DO UPDATE SET no_progress_cycles = excluded.no_progress_cycles, last_signature = excluded.last_signature`,
  ).run(count, sig);
  return count;
}

/** The action chosen most often in the recent window (the stalled approach). */
export function dominantRecentAction(db: Db): string | null {
  if (!tableExists(db, 'recent_action')) return null;
  const r = db
    .prepare(`SELECT action_name AS a, COUNT(*) AS n FROM recent_action GROUP BY action_name ORDER BY n DESC LIMIT 1`)
    .get() as { a: string; n: number } | undefined;
  return r ? r.a : null;
}
