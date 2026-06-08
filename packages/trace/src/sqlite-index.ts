import type { Database as SqliteDb, Statement } from 'better-sqlite3';

import type { TraceEntry } from './types.js';

/**
 * SqliteTraceIndex — mirrors written trace entries into the `trace`
 * SQLite table for fast Bridge queries (data-model.md §8).
 *
 * The JSONL file is the durable record; this index is queryable.
 * Both writes happen in the same cycle transaction (the runtime
 * provides the transaction wrapper) so the index never disagrees
 * with the JSONL after a crash.
 */
type InsertParams = [number, number, string, string | null, string];

export class SqliteTraceIndex {
  private readonly insert: Statement<InsertParams>;

  constructor(private readonly db: SqliteDb) {
    this.insert = db.prepare<InsertParams>(
      `INSERT INTO trace (cycle, at_ms, kind, phase, body) VALUES (?, ?, ?, ?, ?)`,
    );
  }

  write(entry: TraceEntry): void {
    const phase =
      entry.kind === 'phase' || entry.kind === 'substrate' || entry.kind === 'cognition'
        ? (entry as { phase: string }).phase
        : null;
    this.insert.run(entry.cycle, entry.at_ms, entry.kind, phase, JSON.stringify(entry));
  }

  /** Most-recent N entries, newest last. */
  recent(limit = 50): TraceEntry[] {
    const rows = this.db
      .prepare(`SELECT body FROM trace ORDER BY id DESC LIMIT ?`)
      .all(limit) as Array<{ body: string }>;
    return rows.reverse().map((r) => JSON.parse(r.body) as TraceEntry);
  }

  byCycle(cycle: number): TraceEntry[] {
    const rows = this.db
      .prepare(`SELECT body FROM trace WHERE cycle = ? ORDER BY id ASC`)
      .all(cycle) as Array<{ body: string }>;
    return rows.map((r) => JSON.parse(r.body) as TraceEntry);
  }

  count(): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM trace`).get() as { n: number };
    return r.n;
  }
}
