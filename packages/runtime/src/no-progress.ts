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
 * A cycle "made progress" iff an open-job item CLOSED this cycle (reached
 * the terminal `passed` state, raising the passed-item count) OR the set of
 * open jobs changed (a job opened or closed). Nothing else counts:
 *   - Re-writing the plan file does not move an item → no progress.
 *   - APPENDING a checklist item adds an `open` item → no progress.
 *   - Moving an item to `deferred`/`blocked` is being stuck, not closing → no progress.
 * This is the Finding #7 fix. The prior signal hashed the (item_id, state)
 * SET of open items, so ANY change reset the counter — including the entity
 * appending its own checklist items (a live run grew its plan 2→7 items mid-run)
 * and incidental state churn. Because the entity routinely churns its checklist,
 * the signature almost never held stable for the threshold, so the stuck-detector
 * effectively never fired. Keying progress on actual CLOSURES (plus open-job-set
 * changes) means a genuinely productive cycle still resets cleanly, while a
 * completing-but-useless loop (no item closes) climbs to the threshold.
 *
 * When the no-progress counter reaches a threshold the runtime blocks the
 * dominant action and forces a posture change; at a higher threshold it escalates.
 */

export const NO_PROGRESS_THRESHOLD = 12;
export const NO_PROGRESS_ESCALATE = 24;

function tableExists(db: Db, name: string): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== undefined;
}

/**
 * A signature of the open jobs' item states. Empty string when there are
 * no open jobs (not stalled — Item 9 idle-pauses that case). Retained for
 * tests / diagnostics; the no-progress counter no longer keys off this (it
 * was too sensitive to checklist churn — see module doc, Finding #7).
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

/**
 * Progress metrics over the open jobs:
 *  - `passed`: number of items that have reached the terminal `passed` state
 *  - `openJobs`: number of open jobs
 * Genuine progress = `passed` rose (an item closed) OR `openJobs` changed
 * (a job opened/closed). Appending an open item or re-writing the plan moves
 * neither, so neither counts as progress.
 */
export function progressMetrics(db: Db): { passed: number; openJobs: number } {
  if (!tableExists(db, 'plan_job') || !tableExists(db, 'plan_item')) return { passed: 0, openJobs: 0 };
  const openJobs = (db.prepare(`SELECT COUNT(*) AS n FROM plan_job WHERE status = 'open'`).get() as { n: number }).n;
  const passed = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM plan_item pi JOIN plan_job pj ON pi.job_id = pj.id
          WHERE pj.status = 'open' AND pi.state = 'passed'`,
      )
      .get() as { n: number }
  ).n;
  return { passed, openJobs };
}

/** Encode/parse the progress metrics carried in `progress_state.last_signature`. */
function encodeSig(m: { passed: number; openJobs: number }): string {
  return `p${m.passed}:j${m.openJobs}`;
}
function parseSig(s: string): { passed: number; openJobs: number } {
  const m = /^p(\d+):j(\d+)$/.exec(s);
  if (!m) return { passed: -1, openJobs: -1 }; // legacy/unknown → first compare reads as progress (resets once)
  return { passed: Number(m[1]), openJobs: Number(m[2]) };
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
 * Called at end of cycle. Resets the counter to 0 when the cycle made
 * genuine progress (an item closed, or the open-job set changed) and when
 * there are no open jobs (idle, not stalled); otherwise increments. Returns
 * the updated count.
 */
export function recordProgress(db: Db): number {
  if (!tableExists(db, 'progress_state')) return 0;
  const now = progressMetrics(db);
  const prev = db.prepare(`SELECT no_progress_cycles AS c, last_signature AS s FROM progress_state WHERE id='self'`).get() as
    | { c: number; s: string }
    | undefined;
  let count: number;
  if (now.openJobs === 0) {
    count = 0; // no open jobs — idle, not stalled (Item 9 idle-pauses this)
  } else if (!prev) {
    count = 0; // first observation this run
  } else {
    const was = parseSig(prev.s);
    const progressed = now.passed > was.passed || now.openJobs !== was.openJobs;
    count = progressed ? 0 : prev.c + 1;
  }
  db.prepare(
    `INSERT INTO progress_state (id, no_progress_cycles, last_signature)
     VALUES ('self', ?, ?)
     ON CONFLICT(id) DO UPDATE SET no_progress_cycles = excluded.no_progress_cycles, last_signature = excluded.last_signature`,
  ).run(count, encodeSig(now));
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
