import { randomUUID } from 'node:crypto';

import type { Database as SqliteDb, Statement } from 'better-sqlite3';

import { check, type AdmissionRequest } from './admission.js';
import { DEFAULT_DECAY, classify, durability, type DecayParams } from './decay.js';
import type { EpisodicMemoryEntry } from './types.js';

/**
 * EpisodicStore — what HAPPENED (constitution Principle IV.3).
 *
 * Decays per the canonical formula. The forget/promote sweeps are
 * called from the slow-clock consolidation pass (slice 7); they are
 * implemented here so the rule and its inputs stay co-located with
 * the store that owns the data.
 */
interface InsertParams {
  id: string;
  at: number;
  cycle: number;
  body: string;
  why: string;
  R: number;
}
interface AccessParams {
  now: number;
  id: string;
}
type CandidateRow = {
  id: string;
  written_at_ms: number;
  cycle: number;
  body: string;
  why: string;
  reinforcement: number;
  access_count: number;
  last_access_ms: number;
  durability: number | null;
};

export interface DecaySweepResult {
  readonly examined: number;
  readonly forgotten: number;
  readonly promoted: number;
  readonly kept: number;
}

export class EpisodicStore {
  private readonly insert: Statement<[InsertParams]>;
  private readonly listRecent: Statement<[number]>;
  private readonly accessTouch: Statement<[AccessParams]>;
  private readonly listAll: Statement<[]>;
  private readonly del: Statement<[string]>;
  private readonly updateDurability: Statement<[{ M: number; id: string }]>;
  private readonly count: Statement<[]>;

  constructor(private readonly db: SqliteDb) {
    this.insert = db.prepare<[InsertParams]>(
      `INSERT INTO memory_episodic
         (id, written_at_ms, cycle, body, why, reinforcement, access_count, last_access_ms)
       VALUES (@id, @at, @cycle, @body, @why, @R, 0, @at)`,
    );
    this.listRecent = db.prepare<[number]>(
      `SELECT id, written_at_ms, cycle, body, why,
              reinforcement, access_count, last_access_ms, durability
       FROM memory_episodic
       ORDER BY written_at_ms DESC LIMIT ?`,
    );
    this.accessTouch = db.prepare<[AccessParams]>(
      `UPDATE memory_episodic
         SET access_count = access_count + 1,
             last_access_ms = @now
       WHERE id = @id`,
    );
    this.listAll = db.prepare<[]>(
      `SELECT id, written_at_ms, cycle, body, why,
              reinforcement, access_count, last_access_ms, durability
       FROM memory_episodic ORDER BY written_at_ms ASC`,
    );
    this.del = db.prepare<[string]>(`DELETE FROM memory_episodic WHERE id = ?`);
    this.updateDurability = db.prepare<[{ M: number; id: string }]>(
      `UPDATE memory_episodic SET durability = @M WHERE id = @id`,
    );
    this.count = db.prepare<[]>(`SELECT COUNT(*) AS n FROM memory_episodic`);
  }

  write(
    req: Omit<AdmissionRequest, 'system'>,
    ctx: { cycle: number; at_ms: number; reinforcement?: number },
  ): EpisodicMemoryEntry {
    check({ ...req, system: 'episodic' });
    const id = randomUUID();
    const R = ctx.reinforcement ?? 1.0;
    this.insert.run({ id, at: ctx.at_ms, cycle: ctx.cycle, body: req.body, why: req.why, R });
    return {
      system: 'episodic',
      id,
      cycle: ctx.cycle,
      written_at_ms: ctx.at_ms,
      body: req.body,
      why: req.why,
      reinforcement: R,
      access_count: 0,
      last_access_ms: ctx.at_ms,
      durability: null,
    };
  }

  /** Most-recent `limit` entries, newest first. */
  recent(limit: number): readonly EpisodicMemoryEntry[] {
    const rows = this.listRecent.all(limit) as CandidateRow[];
    return rows.map(toEntry);
  }

  all(): readonly EpisodicMemoryEntry[] {
    const rows = this.listAll.all() as CandidateRow[];
    return rows.map(toEntry);
  }

  totalCount(): number {
    return (this.count.get() as { n: number }).n;
  }

  /** Called by recall when a memory is actually surfaced. */
  recordAccess(id: string, nowMs: number): void {
    this.accessTouch.run({ id, now: nowMs });
  }

  /**
   * Run forget + promote decisions across the store.
   *
   * - For each row, recompute M (and persist `durability` for inspection).
   * - If M < forgetBelow: delete (subject to caller veto).
   * - If M > promoteAbove: call `onPromote` (caller writes the semantic).
   * - Otherwise: keep.
   */
  sweep(
    nowMs: number,
    params: DecayParams = DEFAULT_DECAY,
    onPromote?: (row: EpisodicMemoryEntry, M: number) => void,
  ): DecaySweepResult {
    const rows = this.listAll.all() as CandidateRow[];
    let forgotten = 0;
    let promoted = 0;
    let kept = 0;
    for (const r of rows) {
      const entry = toEntry(r);
      const { M, decision } = classify(entry, nowMs, params);
      this.updateDurability.run({ id: r.id, M });
      if (decision === 'forget') {
        this.del.run(r.id);
        forgotten += 1;
      } else if (decision === 'promote') {
        if (onPromote) onPromote(entry, M);
        promoted += 1;
      } else {
        kept += 1;
      }
    }
    return { examined: rows.length, forgotten, promoted, kept };
  }

  /** Compute current durability for one entry — used by recall freshness. */
  durabilityOf(entry: EpisodicMemoryEntry, nowMs: number, params: DecayParams = DEFAULT_DECAY): number {
    return durability(entry, nowMs, params);
  }
}

function toEntry(r: CandidateRow): EpisodicMemoryEntry {
  return {
    system: 'episodic',
    id: r.id,
    cycle: r.cycle,
    written_at_ms: r.written_at_ms,
    body: r.body,
    why: r.why,
    reinforcement: r.reinforcement,
    access_count: r.access_count,
    last_access_ms: r.last_access_ms,
    durability: r.durability,
  };
}
