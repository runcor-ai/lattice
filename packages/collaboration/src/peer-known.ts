import type { Database as SqliteDb, Statement } from 'better-sqlite3';

import type { PeerKnown, RegistryEntry } from './types.js';

/**
 * PeerKnownStore — this lattice's record of which peers it has
 * SEEN on the registry (intent §15.1; data-model.md §12).
 *
 * NOT shared memory — this is OUR snapshot, in OUR SQLite, of peer
 * names the registry has shown us. Other lattices have their own
 * (different) records.
 */

interface UpsertParams {
  id: string;
  essence: string;
  registry_url: string;
  first_seen_cycle: number;
  last_seen_cycle: number;
  last_seen_ms: number;
}

export class PeerKnownStore {
  private readonly upsert: Statement<[UpsertParams]>;
  private readonly readAll: Statement<[]>;
  private readonly readOne: Statement<[string]>;
  private readonly count: Statement<[]>;

  constructor(db: SqliteDb) {
    this.upsert = db.prepare<[UpsertParams]>(
      `INSERT INTO peer_known (id, essence, registry_url, first_seen_cycle, last_seen_cycle, last_seen_ms)
       VALUES (@id, @essence, @registry_url, @first_seen_cycle, @last_seen_cycle, @last_seen_ms)
       ON CONFLICT(id) DO UPDATE SET
         essence = @essence,
         registry_url = @registry_url,
         last_seen_cycle = @last_seen_cycle,
         last_seen_ms = @last_seen_ms`,
    );
    this.readAll = db.prepare<[]>(`SELECT * FROM peer_known ORDER BY last_seen_cycle DESC`);
    this.readOne = db.prepare<[string]>(`SELECT * FROM peer_known WHERE id = ?`);
    this.count = db.prepare<[]>(`SELECT COUNT(*) AS n FROM peer_known`);
  }

  /** Merge a registry snapshot into the peer_known table. */
  ingest(
    entries: readonly RegistryEntry[],
    ctx: { cycle: number; registry_url: string },
  ): void {
    const ms = Date.now();
    for (const e of entries) {
      this.upsert.run({
        id: e.lattice_id,
        essence: e.essence,
        registry_url: ctx.registry_url,
        first_seen_cycle: ctx.cycle,
        last_seen_cycle: ctx.cycle,
        last_seen_ms: ms,
      });
    }
  }

  all(): readonly PeerKnown[] {
    return this.readAll.all() as PeerKnown[];
  }

  get(id: string): PeerKnown | null {
    return (this.readOne.get(id) as PeerKnown | undefined) ?? null;
  }

  size(): number {
    return (this.count.get() as { n: number }).n;
  }
}
