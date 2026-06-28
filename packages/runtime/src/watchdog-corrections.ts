import type { Database as SqliteDb } from 'better-sqlite3';

/**
 * Three-tier watchdog Step 1 — recall render for the corrections section.
 *
 * Reads `memory_semantic_correction` rows whose `rule` is watchdog-scoped and
 * whose `resolved_at_ms` is NULL, joined to the underlying semantic row for
 * body + source_ref (the proof). Bounded by count (oldest-first so the
 * earliest unresolved finding gets the first cycle of attention) and by total
 * bytes (so a many-finding pass cannot displace the rest of the reality
 * slice).
 *
 * Engine-generic. Nothing here knows the harness or task. The selector
 * filters by `rule LIKE 'watchdog:%'`, so non-watchdog drift findings
 * (off_purpose etc.) do not enter this section. Tier-3 surfaces (open
 * questions) will live in a separate physical table (Step 4) — that physical
 * separation, not a tag, is what keeps a question from ever being rendered as
 * a fact.
 *
 * Header is deliberately SHOWING ("each cites the object that proves it"),
 * not TELLING ("treat as ground truth"). The citation does the persuading;
 * the prompt does not instruct trust. Symmetry will matter when Step 4 lands
 * the open-questions header.
 */
export function renderWatchdogCorrections(
  db: SqliteDb,
  limit: number,
  byteBudget: number,
): string {
  // Schema-guard: keep the recall path working on pre-v23 databases (those
  // without the resolved_at columns). On a fresh entity the migration will
  // have run; on a partial in-test fixture, fall back gracefully rather than
  // throwing inside a prompt-build hot path.
  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_semantic_correction'`,
    )
    .get();
  if (!tableExists) return '';
  const hasResolvedAt = (
    db.prepare(`PRAGMA table_info(memory_semantic_correction)`).all() as Array<{
      name: string;
    }>
  ).some((c) => c.name === 'resolved_at_ms');

  const whereClause = hasResolvedAt
    ? `WHERE msc.rule LIKE 'watchdog:%' AND msc.resolved_at_ms IS NULL`
    : `WHERE msc.rule LIKE 'watchdog:%'`;

  const rows = db
    .prepare<[number]>(
      `SELECT msc.rule AS rule, msc.now_is AS now_is, ms.source_ref AS source_ref
       FROM memory_semantic_correction msc
       JOIN memory_semantic ms ON ms.id = msc.semantic_id
       ${whereClause}
       ORDER BY msc.cycle ASC, msc.at_ms ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{ rule: string; now_is: string; source_ref: string | null }>;

  if (rows.length === 0) return '';

  const lines = [
    'corrections from last review (each cites the object that proves it):',
  ];
  let budget = byteBudget;
  for (const r of rows) {
    const proof = r.source_ref ? ` — proof: ${r.source_ref}` : '';
    const line = `  [${r.rule}] ${r.now_is}${proof}`;
    if (line.length > budget) break;
    lines.push(line);
    budget -= line.length;
  }
  // If the header is the only line (every candidate exceeded budget), elide
  // the section entirely — an empty header is noise.
  if (lines.length === 1) return '';
  return lines.join('\n');
}
