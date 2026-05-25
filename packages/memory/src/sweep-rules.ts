import { randomUUID } from 'node:crypto';

import type { Database as SqliteDb } from 'better-sqlite3';

import type { SweepCandidate, SweepContext, SweepRule } from './subconscious-types.js';

/**
 * Default sweep rules (slice 6).
 *
 * Three flat, deterministic checks:
 *
 *   - `orphan_index_row`     — memory_index references a memory_id
 *                              that no longer exists in its source table.
 *                              Flat. Code fixes by deleting the orphan.
 *   - `stale_semantic_marker` — a semantic memory whose body starts
 *                              with the configurable deprecation marker.
 *                              Flat. Code fixes by stripping the marker
 *                              and recording a correction via
 *                              memory_semantic_correction.
 *   - `ambiguous_semantic`   — a semantic memory containing hedging
 *                              language (maybe/might/possibly). DETECTED
 *                              but NOT acted on — the fix would require
 *                              judgement, which is the work layer's job.
 *
 * The rule registry is open: callers (the runtime, future slices)
 * can append rules without changing this module.
 */

export const DEPRECATION_MARKER = '[DEPRECATED]';

const DEPRECATED_MARKER_RE = new RegExp(
  `^\\s*\\${DEPRECATION_MARKER.charAt(0)}DEPRECATED\\${DEPRECATION_MARKER.charAt(DEPRECATION_MARKER.length - 1)}\\s*`,
);

export const orphanIndexRowRule: SweepRule = {
  name: 'orphan_index_row',
  detect(db) {
    const orphans = db
      .prepare(
        `SELECT mi.id AS index_id, mi.memory_table AS tbl, mi.memory_id AS memId
         FROM memory_index mi
         WHERE
           (mi.memory_table = 'identity' AND NOT EXISTS (SELECT 1 FROM memory_identity WHERE id = mi.memory_id))
           OR
           (mi.memory_table = 'episodic' AND NOT EXISTS (SELECT 1 FROM memory_episodic WHERE id = mi.memory_id))
           OR
           (mi.memory_table = 'semantic' AND NOT EXISTS (SELECT 1 FROM memory_semantic WHERE id = mi.memory_id))`,
      )
      .all() as Array<{ index_id: string; tbl: string; memId: string }>;
    return orphans.map(
      (o): SweepCandidate => ({
        rule: 'orphan_index_row',
        memoryTable: 'memory_index',
        memoryId: o.index_id,
        detail: `memory_index row points at missing ${o.tbl}/${o.memId}`,
        was: `index → ${o.tbl}/${o.memId}`,
        now_is: '(deleted)',
      }),
    );
  },
  canAct() {
    return true;
  },
  apply(db, c) {
    db.prepare(`DELETE FROM memory_index WHERE id = ?`).run(c.memoryId);
  },
};

export const staleSemanticMarkerRule: SweepRule = {
  name: 'stale_semantic_marker',
  detect(db) {
    const rows = db
      .prepare(
        `SELECT id, body FROM memory_semantic WHERE body LIKE ? OR body LIKE ?`,
      )
      .all(`${DEPRECATION_MARKER}%`, `${DEPRECATION_MARKER} %`) as Array<{ id: string; body: string }>;
    return rows.map(
      (r): SweepCandidate => ({
        rule: 'stale_semantic_marker',
        memoryTable: 'semantic',
        memoryId: r.id,
        detail: `semantic row carries the ${DEPRECATION_MARKER} marker`,
        was: r.body,
        now_is: r.body.replace(DEPRECATED_MARKER_RE, '').trim(),
      }),
    );
  },
  canAct() {
    return true;
  },
  apply(db, c, ctx) {
    // Update body + audit row in one go.
    db.prepare(
      `UPDATE memory_semantic SET body = ?, last_validated_ms = ? WHERE id = ?`,
    ).run(c.now_is!, ctx.at_ms, c.memoryId);
    db.prepare(
      `INSERT INTO memory_semantic_correction (id, semantic_id, cycle, was, now_is, rule, at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), c.memoryId, ctx.cycle, c.was!, c.now_is!, c.rule, ctx.at_ms);
  },
};

export const ambiguousSemanticRule: SweepRule = {
  name: 'ambiguous_semantic',
  detect(db) {
    const rows = db
      .prepare(
        `SELECT id, body FROM memory_semantic
         WHERE body LIKE '%maybe%' OR body LIKE '%might%' OR body LIKE '%possibly%'`,
      )
      .all() as Array<{ id: string; body: string }>;
    return rows.map(
      (r): SweepCandidate => ({
        rule: 'ambiguous_semantic',
        memoryTable: 'semantic',
        memoryId: r.id,
        detail: `semantic row contains hedging language — disambiguation requires judgement`,
        was: r.body,
      }),
    );
  },
  /**
   * Cannot act deterministically — picking which hedge to commit to
   * requires judgement (Principle V). The sweep DETECTS and reports
   * via the trace; the work layer's decide phase may pick this up.
   */
  canAct() {
    return false;
  },
  apply(_db: SqliteDb, _c: SweepCandidate, _ctx: SweepContext) {
    throw new Error('ambiguous_semantic: canAct=false — apply must not be called');
  },
};

export const DEFAULT_RULES: readonly SweepRule[] = Object.freeze([
  orphanIndexRowRule,
  staleSemanticMarkerRule,
  ambiguousSemanticRule,
]);
