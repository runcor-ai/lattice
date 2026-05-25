import { Memory, type MemoryWriteRequest } from '@runcor/memory';
import type { Database as SqliteDb } from 'better-sqlite3';

import type { MemoryRecallView, MemorySink, MemoryWrite } from './types.js';

/**
 * RuntimeMemoryAdapter — wraps `@runcor/memory.Memory` (the real
 * four-system store) into the MemorySink + MemoryRecallView surfaces
 * the runtime's cycle phases expect.
 *
 * Slice 4 replacement for the slice-3 SqliteMemorySink that lived
 * here directly. All persistence + admission + decay logic now lives
 * in `@runcor/memory`; the runtime is a thin caller.
 */
export class RuntimeMemoryAdapter implements MemorySink, MemoryRecallView {
  readonly memory: Memory;
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
    this.memory = new Memory(db);
  }

  /** Direct DB handle — used by the subconscious sweep (slice 6). */
  dbHandle(): SqliteDb {
    return this.db;
  }

  write(entry: MemoryWrite, ctx: { cycle: number; at_ms: number }): void {
    if (entry.system === 'plan') {
      throw new Error(
        `memory.write for system='plan' is owned by @runcor/jobs (slice 9); ` +
          `use that package's API instead`,
      );
    }
    const req: MemoryWriteRequest = {
      body: entry.body,
      why: entry.why,
      admissionTag: entry.admissionTag,
    };
    this.memory.write(entry.system, req, ctx);
  }

  recentEpisodic(limit: number): readonly MemoryWrite[] {
    const rows = this.memory.episodic.recent(limit);
    return rows.map((e) => ({
      system: 'episodic' as const,
      body: e.body,
      why: e.why,
      admissionTag: 'cycle-outcome' as const,
    }));
  }

  size(system?: MemoryWrite['system']): number {
    if (system === 'episodic') return this.memory.episodic.totalCount();
    if (system === 'semantic') return this.memory.semantic.totalCount();
    if (system === 'identity') return this.memory.identity.count();
    return this.memory.totalSize();
  }

  /**
   * Test-only dump of all episodic rows (oldest-first). Kept for
   * backward-compat with the slice 1/2/3 test fixtures that import
   * `lattice.memory.all()`.
   */
  all(): readonly (MemoryWrite & { cycle: number; at_ms: number })[] {
    const rows = this.memory.episodic.all();
    return rows.map((r) => ({
      system: 'episodic' as const,
      body: r.body,
      why: r.why,
      admissionTag: 'cycle-outcome' as const,
      cycle: r.cycle,
      at_ms: r.written_at_ms,
    }));
  }
}

// Backwards-compat alias for the old slice-3 class name during the
// transition. The slice-1..3 test fixtures import `SqliteMemorySink`
// by name; this lets them continue working unchanged.
export { RuntimeMemoryAdapter as SqliteMemorySink };
