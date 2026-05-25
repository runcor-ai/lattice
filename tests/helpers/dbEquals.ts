import type { Database as SqliteDb } from 'better-sqlite3';

/**
 * Logical-state equality for two lattice SQLite databases.
 *
 * Per the 2026-05-24 clarification (spec.md FR-007 + SC-002): the
 * SQLite file's BYTES may differ between a pre-stop snapshot and a
 * post-restart snapshot (WAL checkpoint, vacuum). What MUST be
 * identical is the persistent state — the rows in every
 * entity-owned table.
 *
 * Implementation: query every persistent table for all rows, sort by
 * primary key (or insertion order), and compare deeply. SQLite-internal
 * tables (`sqlite_*`) are ignored. The `trace` table's restart-marker
 * entry is ignored (when post-restart adds one).
 *
 * IGNORE LIST:
 *   - schema_migration.applied_at_ms (this is a wall-clock moment,
 *     not lattice state; differs by definition after restart)
 *   - trace rows of kind='operator' with action='restart_marker'
 */

export interface DbEqualsOptions {
  /** Tables to skip entirely. Defaults to []. */
  readonly skipTables?: readonly string[];
}

export interface DbEqualsResult {
  readonly equal: boolean;
  readonly diffs: readonly string[];
}

const TABLES_WITH_AUTO_INCREMENT_IDS = new Set(['trace', 'snapshot_log']);

function listUserTables(db: SqliteDb): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function rowsOf(db: SqliteDb, table: string): Array<Record<string, unknown>> {
  // Order deterministically. Tables with an integer PK use it; others
  // fall back to rowid which is stable per row.
  let orderBy = 'rowid';
  if (table === 'schema_migration') orderBy = 'version';
  if (table === 'entity') orderBy = 'id';
  if (table === 'dial') orderBy = 'name';

  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all() as Array<
    Record<string, unknown>
  >;

  // Strip transient / time-only columns that are expected to differ
  // across a restart but don't represent cognitive state.
  return rows.map((r) => {
    if (table === 'schema_migration') {
      // applied_at_ms is the moment we ran the migration; not state.
      const { applied_at_ms: _ignored, ...rest } = r;
      return rest;
    }
    if (table === 'trace') {
      const body = r.body;
      if (typeof body === 'string') {
        try {
          const parsed = JSON.parse(body) as {
            kind?: string;
            action?: string;
          };
          if (parsed.kind === 'operator' && parsed.action === 'restart_marker') {
            return { __SKIP__: true } as Record<string, unknown>;
          }
        } catch {
          /* fall through */
        }
      }
      // trace.id is auto-increment — restart-resilient WAL behaviour
      // may shift IDs across restart even though logical content is
      // the same. Drop the surrogate id.
      const { id: _id, ...rest } = r;
      return rest;
    }
    if (TABLES_WITH_AUTO_INCREMENT_IDS.has(table)) {
      const { id: _id, ...rest } = r;
      return rest;
    }
    return r;
  });
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ka = Object.keys(ao).sort();
    const kb = Object.keys(bo).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] !== kb[i]) return false;
      if (!deepEqual(ao[ka[i]!], bo[ka[i]!])) return false;
    }
    return true;
  }
  // Buffer comparison
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  return false;
}

export function dbEquals(a: SqliteDb, b: SqliteDb, opts: DbEqualsOptions = {}): DbEqualsResult {
  const skip = new Set(opts.skipTables ?? []);
  const ta = listUserTables(a).filter((t) => !skip.has(t));
  const tb = listUserTables(b).filter((t) => !skip.has(t));
  const diffs: string[] = [];

  if (ta.length !== tb.length || ta.some((t, i) => t !== tb[i])) {
    diffs.push(`tables differ: a=[${ta.join(',')}] b=[${tb.join(',')}]`);
    return { equal: false, diffs };
  }

  for (const t of ta) {
    const ra = rowsOf(a, t).filter((r) => !(r as { __SKIP__?: true }).__SKIP__);
    const rb = rowsOf(b, t).filter((r) => !(r as { __SKIP__?: true }).__SKIP__);
    if (ra.length !== rb.length) {
      diffs.push(`${t}: row count a=${ra.length} b=${rb.length}`);
      continue;
    }
    for (let i = 0; i < ra.length; i += 1) {
      if (!deepEqual(ra[i], rb[i])) {
        diffs.push(`${t} row ${i} differs: a=${JSON.stringify(ra[i])} b=${JSON.stringify(rb[i])}`);
      }
    }
  }

  return { equal: diffs.length === 0, diffs };
}
