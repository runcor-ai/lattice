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
 * Read-cap (Finding #16). Posture cannot make the entity commit under ambiguity —
 * told to commit, it RE-READS the deciding signal instead (15 straight signal-reads,
 * 0 writes, then a gap-E park). The mechanical fix: once a signal has been READ this
 * run, cap re-reads of that already-held content, so the only productive move left is
 * to WRITE — and the gate-valid HELD-CAVEAT path gives it the honest thing to write.
 * SAFE only because #12 stands: a forced write cannot fabricate a revision (the gate
 * rejects an unsupported REVISED and a kill-condition-met HELD-CAVEAT), so the
 * gate-valid escape is the honest output. Reset on a genuine commit (an item closes),
 * mirroring the no-progress reset — a first read and reading genuinely new signal are
 * never capped.
 */
function ensureHeldSignal(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS held_signal (key TEXT PRIMARY KEY, cycle INTEGER NOT NULL)`);
}
/** Record that a read-action has consumed `key` (action|path) this run. */
export function recordSignalRead(db: Db, key: string, cycle: number): void {
  ensureHeldSignal(db);
  db.prepare(`INSERT OR IGNORE INTO held_signal (key, cycle) VALUES (?, ?)`).run(key, cycle);
}
/** Has this exact read (action|path) already been done since the last commit? */
export function isReadCapped(db: Db, key: string): boolean {
  ensureHeldSignal(db);
  return db.prepare(`SELECT 1 FROM held_signal WHERE key = ?`).get(key) !== undefined;
}
/** Clear the held-signal set — called on a genuine commit (an item closed). */
export function clearHeldSignals(db: Db): void {
  ensureHeldSignal(db);
  db.exec(`DELETE FROM held_signal`);
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

/**
 * True iff the only open work left is operator attestation: there is ≥1 open
 * item across open jobs AND every open item is source='operator' (the
 * architect-immutable, architect-uncloseable class — see
 * jobs/src/source-immutability.test.ts). This is a REST state, not a stall:
 * the architect has nothing it can act on and must wait for the operator's
 * /attest (an unbounded wait by design). A genuine stall leaves ≥1 non-operator
 * item open, so this returns false and the breakers stay active. Used to exempt
 * the halt from the persistence + no-progress laws (see act.ts) and to drive the
 * paused_awaiting_operator rest state (see supervisor.ts).
 */
export function awaitingOperator(db: Db): boolean {
  if (!tableExists(db, 'plan_item') || !tableExists(db, 'plan_job')) return false;
  try {
    const rows = db
      .prepare(
        `SELECT pi.source AS source
           FROM plan_item pi JOIN plan_job pj ON pi.job_id = pj.id
          WHERE pj.status = 'open' AND pi.state = 'open'`,
      )
      .all() as Array<{ source: string }>;
    return rows.length > 0 && rows.every((r) => r.source === 'operator');
  } catch {
    // Minimal/legacy schema without a plan_item.source column → treat as NOT
    // resting (breakers stay active). The real migrated schema always has source.
    return false;
  }
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
  if (now.openJobs === 0 || awaitingOperator(db)) {
    count = 0; // no open jobs (idle) OR only operator attestation left (resting) — not stalled
  } else if (!prev) {
    count = 0; // first observation this run
  } else {
    const was = parseSig(prev.s);
    const closed = now.passed > was.passed; // a genuine item CLOSE (commit)
    const progressed = closed || now.openJobs !== was.openJobs;
    count = progressed ? 0 : prev.c + 1;
    // The read-cap frees ONLY on a genuine commit (an item closed) — NOT on
    // openJobs churn (plan-item appends, job toggles). Resetting on mere
    // openJobs change made the cap fire 1/12 in the live run (it was cleared
    // between re-reads), the same over-sensitivity that defeated the original
    // no-progress signal (#7). Tie the reset to a real close so the cap holds
    // across a churn and actually forces the write.
    if (closed) clearHeldSignals(db);
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
