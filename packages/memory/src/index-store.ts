import { randomUUID } from 'node:crypto';

import type { Database as SqliteDb, Statement } from 'better-sqlite3';

import type { MemoryIndexEntry } from './types.js';

/**
 * MemoryIndex — one short description line per stored memory across
 * all four systems (intent §9.4; FR-016).
 *
 * Recall is index-plus-cheap-selector: enumerate the index, then a
 * cheap LLM pass selects the few relevant items. Writes go through
 * here in the same transaction as the underlying memory write so the
 * index never drifts from the stores.
 */
interface InsertParams {
  id: string;
  table: MemoryIndexEntry['memory_table'];
  memId: string;
  desc: string;
  at: number;
}

export class MemoryIndex {
  private readonly insert: Statement<[InsertParams]>;
  private readonly listAll: Statement<[]>;
  private readonly del: Statement<[{ table: string; memId: string }]>;
  private readonly count: Statement<[]>;

  constructor(private readonly db: SqliteDb) {
    this.insert = db.prepare<[InsertParams]>(
      `INSERT INTO memory_index (id, memory_table, memory_id, description, written_at_ms)
       VALUES (@id, @table, @memId, @desc, @at)`,
    );
    this.listAll = db.prepare<[]>(
      `SELECT id, memory_table, memory_id, description, written_at_ms FROM memory_index
       ORDER BY written_at_ms DESC`,
    );
    this.del = db.prepare<[{ table: string; memId: string }]>(
      `DELETE FROM memory_index WHERE memory_table = @table AND memory_id = @memId`,
    );
    this.count = db.prepare<[]>(`SELECT COUNT(*) AS n FROM memory_index`);
  }

  add(
    table: MemoryIndexEntry['memory_table'],
    memoryId: string,
    description: string,
    writtenAtMs: number,
  ): void {
    this.insert.run({
      id: randomUUID(),
      table,
      memId: memoryId,
      desc: description.slice(0, 120),
      at: writtenAtMs,
    });
  }

  remove(table: MemoryIndexEntry['memory_table'], memoryId: string): void {
    this.del.run({ table, memId: memoryId });
  }

  all(): readonly MemoryIndexEntry[] {
    return this.listAll.all() as MemoryIndexEntry[];
  }

  size(): number {
    return (this.count.get() as { n: number }).n;
  }
}
