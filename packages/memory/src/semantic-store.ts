import { randomUUID } from 'node:crypto';

import type { Database as SqliteDb, Statement } from 'better-sqlite3';

import { check, type AdmissionRequest } from './admission.js';
import type { SemanticMemoryEntry, SemanticSource } from './types.js';

/**
 * SemanticStore — settled FACTS and RULES (constitution Principle IV.4).
 *
 * Persists; correctable by the subconscious sweep (slice 6); is the
 * promotion target for episodic memories that have proven durable.
 * Every write records `source_kind`:
 *   - 'promoted'     : an episodic memory promoted via the decay sweep
 *   - 'derived'      : derived by the drift review (slow clock)
 *   - 'operator'     : operator-provided
 *   - 'collaboration': received from a peer (read-only, per Principle XIV)
 */
interface InsertParams {
  id: string;
  at: number;
  validated: number;
  cycle: number;
  body: string;
  why: string;
  source_kind: SemanticSource;
  source_ref: string | null;
}
interface CorrectionParams {
  id: string;
  semantic_id: string;
  cycle: number;
  was: string;
  now_is: string;
  rule: string;
  at_ms: number;
}
type Row = {
  id: string;
  written_at_ms: number;
  last_validated_ms: number;
  cycle: number;
  body: string;
  why: string;
  source_kind: SemanticSource;
  source_ref: string | null;
};

export class SemanticStore {
  private readonly insert: Statement<[InsertParams]>;
  private readonly listAll: Statement<[]>;
  private readonly readOne: Statement<[string]>;
  private readonly update: Statement<[{ body: string; validated: number; id: string }]>;
  private readonly insertCorrection: Statement<[CorrectionParams]>;
  private readonly count: Statement<[]>;

  constructor(private readonly db: SqliteDb) {
    this.insert = db.prepare<[InsertParams]>(
      `INSERT INTO memory_semantic
         (id, written_at_ms, last_validated_ms, cycle, body, why, source_kind, source_ref)
       VALUES (@id, @at, @validated, @cycle, @body, @why, @source_kind, @source_ref)`,
    );
    this.listAll = db.prepare<[]>(
      `SELECT id, written_at_ms, last_validated_ms, cycle, body, why, source_kind, source_ref
       FROM memory_semantic ORDER BY written_at_ms ASC`,
    );
    this.readOne = db.prepare<[string]>(
      `SELECT id, written_at_ms, last_validated_ms, cycle, body, why, source_kind, source_ref
       FROM memory_semantic WHERE id = ?`,
    );
    this.update = db.prepare<[{ body: string; validated: number; id: string }]>(
      `UPDATE memory_semantic SET body = @body, last_validated_ms = @validated WHERE id = @id`,
    );
    this.insertCorrection = db.prepare<[CorrectionParams]>(
      `INSERT INTO memory_semantic_correction
         (id, semantic_id, cycle, was, now_is, rule, at_ms)
       VALUES (@id, @semantic_id, @cycle, @was, @now_is, @rule, @at_ms)`,
    );
    this.count = db.prepare<[]>(`SELECT COUNT(*) AS n FROM memory_semantic`);
  }

  write(
    req: Omit<AdmissionRequest, 'system'> & { source_kind?: SemanticSource; source_ref?: string | null },
    ctx: { cycle: number; at_ms: number },
  ): SemanticMemoryEntry {
    check({ ...req, system: 'semantic' });
    const id = randomUUID();
    const source_kind = req.source_kind ?? 'operator';
    const source_ref = req.source_ref ?? null;
    this.insert.run({
      id,
      at: ctx.at_ms,
      validated: ctx.at_ms,
      cycle: ctx.cycle,
      body: req.body,
      why: req.why,
      source_kind,
      source_ref,
    });
    return {
      system: 'semantic',
      id,
      cycle: ctx.cycle,
      written_at_ms: ctx.at_ms,
      last_validated_ms: ctx.at_ms,
      body: req.body,
      why: req.why,
      source_kind,
      source_ref,
    };
  }

  all(): readonly SemanticMemoryEntry[] {
    return (this.listAll.all() as Row[]).map(toEntry);
  }

  get(id: string): SemanticMemoryEntry | null {
    const r = this.readOne.get(id) as Row | undefined;
    return r ? toEntry(r) : null;
  }

  /**
   * Apply a subconscious correction (slice 6).
   *   - Update body and last_validated_ms
   *   - Insert a correction-audit row
   */
  correct(args: {
    semantic_id: string;
    was: string;
    now_is: string;
    rule: string;
    cycle: number;
    at_ms: number;
  }): void {
    this.update.run({ body: args.now_is, validated: args.at_ms, id: args.semantic_id });
    this.insertCorrection.run({
      id: randomUUID(),
      semantic_id: args.semantic_id,
      cycle: args.cycle,
      was: args.was,
      now_is: args.now_is,
      rule: args.rule,
      at_ms: args.at_ms,
    });
  }

  totalCount(): number {
    return (this.count.get() as { n: number }).n;
  }
}

function toEntry(r: Row): SemanticMemoryEntry {
  return {
    system: 'semantic',
    id: r.id,
    cycle: r.cycle,
    written_at_ms: r.written_at_ms,
    last_validated_ms: r.last_validated_ms,
    body: r.body,
    why: r.why,
    source_kind: r.source_kind,
    source_ref: r.source_ref,
  };
}
