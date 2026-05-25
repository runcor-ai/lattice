import { randomUUID } from 'node:crypto';

import type { Db } from './db.js';
import { MIGRATIONS } from './migrations.js';

/**
 * EntityStore — owns the `entity` singleton row (data-model.md §1).
 *
 * The `entity.cycle` column IS the lattice's cycle counter, the
 * single source of truth (constitution Principle II). On startup we
 * read it; after each completed cycle we increment it inside the
 * cycle's transaction.
 */
export interface EntityRow {
  readonly id: 'self';
  readonly lattice_id: string;
  readonly name: string;
  readonly created_at_ms: number;
  readonly cycle: number;
  readonly paused: 0 | 1;
  readonly schema_version: number;
}

export interface EnsureOptions {
  readonly name: string;
  readonly latticeId?: string;
}

export function currentSchemaVersion(): number {
  return MIGRATIONS[MIGRATIONS.length - 1]!.version;
}

export function ensureEntity(db: Db, opts: EnsureOptions): EntityRow {
  const existing = db.prepare(`SELECT * FROM entity WHERE id = 'self'`).get() as
    | EntityRow
    | undefined;
  if (existing) return existing;
  const row: EntityRow = {
    id: 'self',
    lattice_id: opts.latticeId ?? randomUUID(),
    name: opts.name,
    created_at_ms: Date.now(),
    cycle: 0,
    paused: 0,
    schema_version: currentSchemaVersion(),
  };
  db.prepare(
    `INSERT INTO entity (id, lattice_id, name, created_at_ms, cycle, paused, schema_version)
     VALUES (@id, @lattice_id, @name, @created_at_ms, @cycle, @paused, @schema_version)`,
  ).run(row);
  return row;
}

export function readEntity(db: Db): EntityRow {
  const row = db.prepare(`SELECT * FROM entity WHERE id = 'self'`).get() as
    | EntityRow
    | undefined;
  if (!row) throw new Error('entity row missing — ensureEntity() not called');
  return row;
}

export function setCycle(db: Db, cycle: number): void {
  db.prepare(`UPDATE entity SET cycle = ? WHERE id = 'self'`).run(cycle);
}

export function setPaused(db: Db, paused: boolean): void {
  db.prepare(`UPDATE entity SET paused = ? WHERE id = 'self'`).run(paused ? 1 : 0);
}
