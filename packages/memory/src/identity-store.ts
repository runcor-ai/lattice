import { randomUUID } from 'node:crypto';

import type { Database as SqliteDb, Statement } from 'better-sqlite3';

import { check, type AdmissionRequest } from './admission.js';
import type { IdentityMemoryEntry } from './types.js';

/**
 * IdentityStore — what the entity IS (constitution Principle IV.1).
 *
 * PERMANENT. Immune to the decay formula. Writes always carry their
 * "why". A separate `identity_current` singleton holds the composed
 * R++ identity prior used by the substrate's `ground` phase.
 */
interface InsertParams {
  id: string;
  at: number;
  cycle: number;
  body: string;
  why: string;
}
interface ComposeParams {
  body: string;
  at: number;
  cycle: number;
}

export class IdentityStore {
  private readonly insert: Statement<[InsertParams]>;
  private readonly listAll: Statement<[]>;
  private readonly readComposed: Statement<[]>;
  private readonly upsertComposed: Statement<[ComposeParams]>;

  constructor(private readonly db: SqliteDb) {
    this.insert = db.prepare<[InsertParams]>(
      `INSERT INTO memory_identity (id, written_at_ms, cycle, body, why)
       VALUES (@id, @at, @cycle, @body, @why)`,
    );
    this.listAll = db.prepare<[]>(
      `SELECT id, written_at_ms, cycle, body, why FROM memory_identity ORDER BY written_at_ms ASC`,
    );
    this.readComposed = db.prepare<[]>(
      `SELECT composed_body, composed_at_ms, composed_at_cycle FROM identity_current WHERE id='self'`,
    );
    this.upsertComposed = db.prepare<[ComposeParams]>(
      `INSERT INTO identity_current (id, composed_body, composed_at_ms, composed_at_cycle)
       VALUES ('self', @body, @at, @cycle)
       ON CONFLICT(id) DO UPDATE SET
         composed_body = @body,
         composed_at_ms = @at,
         composed_at_cycle = @cycle`,
    );
  }

  write(
    req: Omit<AdmissionRequest, 'system'>,
    ctx: { cycle: number; at_ms: number },
  ): IdentityMemoryEntry {
    check({ ...req, system: 'identity' });
    const id = randomUUID();
    this.insert.run({ id, at: ctx.at_ms, cycle: ctx.cycle, body: req.body, why: req.why });
    return {
      system: 'identity',
      id,
      cycle: ctx.cycle,
      written_at_ms: ctx.at_ms,
      body: req.body,
      why: req.why,
    };
  }

  all(): readonly IdentityMemoryEntry[] {
    const rows = this.listAll.all() as Array<{
      id: string;
      written_at_ms: number;
      cycle: number;
      body: string;
      why: string;
    }>;
    return rows.map((r) => ({
      system: 'identity' as const,
      id: r.id,
      written_at_ms: r.written_at_ms,
      cycle: r.cycle,
      body: r.body,
      why: r.why,
    }));
  }

  composed(): { body: string; atMs: number; atCycle: number } | null {
    const row = this.readComposed.get() as
      | { composed_body: string; composed_at_ms: number; composed_at_cycle: number }
      | undefined;
    if (!row) return null;
    return {
      body: row.composed_body,
      atMs: row.composed_at_ms,
      atCycle: row.composed_at_cycle,
    };
  }

  setComposed(body: string, ctx: { cycle: number; at_ms: number }): void {
    this.upsertComposed.run({ body, at: ctx.at_ms, cycle: ctx.cycle });
  }

  count(): number {
    const r = this.db.prepare<[]>(`SELECT COUNT(*) AS n FROM memory_identity`).get() as { n: number };
    return r.n;
  }
}
