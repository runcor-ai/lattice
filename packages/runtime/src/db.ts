import Database from 'better-sqlite3';
import type { Database as SqliteDb } from 'better-sqlite3';

/**
 * db — open the lattice's single SQLite file in WAL mode, per
 * constitution Principle II (the database IS the entity).
 *
 * Use `':memory:'` for tests; production lattices pass a real file
 * path. The caller is responsible for claiming the lockfile BEFORE
 * opening — the lockfile protects against two fast-clock processes
 * targeting the same file (spec FR-010 + Edge Case).
 */

export type Db = SqliteDb;

export interface OpenOptions {
  readonly fileMustExist?: boolean;
  readonly readonly?: boolean;
  /** Skip WAL pragmas. Test-only — production always uses WAL. */
  readonly skipWalConfig?: boolean;
}

export function openDb(path: string, opts: OpenOptions = {}): Db {
  const db = new Database(path, {
    fileMustExist: opts.fileMustExist ?? false,
    readonly: opts.readonly ?? false,
  });

  if (!opts.readonly && !opts.skipWalConfig) {
    // WAL mode is required for crash-safe writes that don't block
    // readers (the Bridge's inspect stream is a concurrent reader).
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('wal_autocheckpoint = 1000');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function closeDb(db: Db): void {
  if (db.open) {
    db.close();
  }
}
