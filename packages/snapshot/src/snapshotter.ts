import type { Database as SqliteDb } from 'better-sqlite3';

import type { SnapshotDestination } from './types.js';

/**
 * Snapshotter — orchestrates a snapshot: WAL-checkpoint the DB,
 * call `destination.put()`, write a row to `snapshot_log`.
 *
 * Failures are NON-BLOCKING for the cycle loop (FR-008 + Edge Case
 * "snapshot destination unreachable"). The lattice continues; the
 * failure is logged operationally and to `snapshot_log`.
 */
export interface SnapshotResult {
  readonly result: 'ok' | 'failed' | 'skipped';
  readonly bytes: number;
  readonly destinationUri?: string;
  readonly error?: string;
}

export class Snapshotter {
  constructor(
    private readonly db: SqliteDb,
    private readonly sqlitePath: string | null,
    private readonly destination: SnapshotDestination | null,
  ) {}

  async snapshot(cycle: number): Promise<SnapshotResult> {
    if (!this.destination) {
      this.recordLog(cycle, 'skipped', 'no-destination', 0, '(none)');
      return { result: 'skipped', bytes: 0 };
    }
    if (!this.sqlitePath || this.sqlitePath === ':memory:') {
      this.recordLog(cycle, 'skipped', 'in-memory db', 0, this.destination.describe());
      return { result: 'skipped', bytes: 0 };
    }
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      const key = `entity-cycle-${cycle}.sqlite`;
      const put = await this.destination.put(this.sqlitePath, key);
      this.recordLog(cycle, 'ok', undefined, put.bytes, put.destinationUri);
      return { result: 'ok', bytes: put.bytes, destinationUri: put.destinationUri };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.recordLog(cycle, 'failed', error, 0, this.destination.describe());
      return { result: 'failed', bytes: 0, error };
    }
  }

  private recordLog(
    cycle: number,
    result: 'ok' | 'failed' | 'skipped',
    error: string | undefined,
    bytes: number,
    destUri: string,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO snapshot_log (destination, destination_uri, at_cycle, at_ms, bytes, result, error)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.destination?.name ?? 'none',
          destUri,
          cycle,
          Date.now(),
          bytes,
          result,
          error ?? null,
        );
    } catch {
      // best-effort; snapshot bookkeeping failure is non-fatal
    }
  }
}
