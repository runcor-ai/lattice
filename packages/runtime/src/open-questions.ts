import type { Database as SqliteDb } from 'better-sqlite3';

/**
 * Three-tier watchdog Step 4 — Tier-3 open-questions recall render.
 *
 * Reads ONLY from drift_open_question. The corrections selector
 * (renderWatchdogCorrections) reads ONLY from memory_semantic_correction.
 * The two recall paths are physically disjoint at the table boundary —
 * a Tier-3 surface cannot reach the corrections section because the
 * corrections selector doesn't query this table; and a Tier-1/2
 * correction cannot reach this section because this selector doesn't
 * query that table. The split is structural, not by-convention.
 *
 * Header is deliberately the MIRROR of the corrections header:
 *   corrections — "each cites the object that proves it"
 *   open questions — "no authoritative object — your dialectic decides"
 * The wording is the only signal between accept-as-fact and deliberate.
 *
 * Capped by count and bytes (denser per row than corrections — each
 * surface renders three lines). Oldest-first so the earliest surfaced
 * question gets prompt attention. TODO(dial): make caps dial-able via
 * the operator review-cadence dial; hardcoded for v1.
 */
export function renderOpenQuestions(
  db: SqliteDb,
  limit: number,
  byteBudget: number,
): string {
  // Schema-guard: keep the recall path working on pre-v24 databases. On a
  // fresh entity the migration will have run; on a partial in-test fixture,
  // fall back gracefully rather than throwing inside a prompt-build hot path.
  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='drift_open_question'`,
    )
    .get();
  if (!tableExists) return '';

  const rows = db
    .prepare<[number]>(
      `SELECT id, kind, item_id, lattice_position, watchdog_position, no_object_reason
       FROM drift_open_question
       WHERE resolved_at_ms IS NULL
       ORDER BY cycle ASC, at_ms ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    kind: string;
    item_id: string | null;
    lattice_position: string;
    watchdog_position: string;
    no_object_reason: string;
  }>;

  if (rows.length === 0) return '';

  const lines = [
    'open questions from last review (no authoritative object — your dialectic decides):',
  ];
  let budget = byteBudget;
  for (const r of rows) {
    const header = `  [${r.kind}] question_id=${r.id}${r.item_id ? ` item=${r.item_id}` : ''}`;
    const latticeLine = `      lattice's position: ${r.lattice_position}`;
    const watchdogLine = `      watchdog's position: ${r.watchdog_position}`;
    const noObjectLine = `      no authoritative object because: ${r.no_object_reason}`;
    const block = `${header}\n${latticeLine}\n${watchdogLine}\n${noObjectLine}`;
    if (block.length > budget) break;
    lines.push(block);
    budget -= block.length;
  }
  if (lines.length === 1) return '';
  return lines.join('\n');
}
