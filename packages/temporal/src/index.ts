import { randomUUID } from 'node:crypto';

import type { Database as SqliteDb, Statement } from 'better-sqlite3';

/**
 * Temporal — deadlines and commitments in CYCLES (intent §10;
 * constitution Technology Stack note).
 *
 * The canonical unit is the cycle, not wall-clock time. The
 * consumer (operator setting up the lattice) maps cycles to clock
 * time externally. Pressure bands escalate as the deadline nears.
 */

export type PressureBand = 'green' | 'yellow' | 'orange' | 'red';

export interface Commitment {
  readonly id: string;
  readonly description: string;
  readonly deadline_cycle: number;
  readonly pressure_band: PressureBand;
  readonly job_id: string | null;
  readonly source: string;
}

interface InsertParams {
  id: string;
  description: string;
  deadline_cycle: number;
  pressure_band: PressureBand;
  job_id: string | null;
  source: string;
}

/**
 * Compute the pressure band given the current cycle and the
 * deadline. Default mapping (operator-tunable in slice 14):
 *
 *   cycles_remaining / total_horizon >= 0.5   → green
 *   0.25 <= ratio < 0.5                       → yellow
 *   0 <= ratio < 0.25                         → orange
 *   ratio < 0                                 → red (overdue)
 *
 * `total_horizon` defaults to `deadline_cycle - opened_at_cycle`,
 * but callers can supply it directly when the commitment didn't
 * carry an opened_at_cycle.
 */
export function pressureBand(
  currentCycle: number,
  deadlineCycle: number,
  totalHorizon: number,
): PressureBand {
  if (currentCycle > deadlineCycle) return 'red';
  if (totalHorizon <= 0) {
    // No horizon — treat as imminent.
    return 'orange';
  }
  const remaining = deadlineCycle - currentCycle;
  const ratio = remaining / totalHorizon;
  if (ratio >= 0.5) return 'green';
  if (ratio >= 0.25) return 'yellow';
  if (ratio >= 0) return 'orange';
  return 'red';
}

export class CommitmentsStore {
  private readonly insert: Statement<[InsertParams]>;
  private readonly listAll: Statement<[]>;
  private readonly readOne: Statement<[string]>;
  private readonly updateBand: Statement<[{ id: string; pressure_band: PressureBand }]>;
  private readonly deleteOne: Statement<[string]>;

  constructor(db: SqliteDb) {
    this.insert = db.prepare<[InsertParams]>(
      `INSERT INTO commitment (id, description, deadline_cycle, pressure_band, job_id, source)
       VALUES (@id, @description, @deadline_cycle, @pressure_band, @job_id, @source)`,
    );
    this.listAll = db.prepare<[]>(
      `SELECT * FROM commitment ORDER BY deadline_cycle ASC`,
    );
    this.readOne = db.prepare<[string]>(`SELECT * FROM commitment WHERE id = ?`);
    this.updateBand = db.prepare<[{ id: string; pressure_band: PressureBand }]>(
      `UPDATE commitment SET pressure_band = @pressure_band WHERE id = @id`,
    );
    this.deleteOne = db.prepare<[string]>(`DELETE FROM commitment WHERE id = ?`);
  }

  add(args: {
    description: string;
    deadline_cycle: number;
    source: string;
    job_id?: string | null;
    /** Optional pre-computed initial band; otherwise 'green'. */
    initial_band?: PressureBand;
  }): Commitment {
    const c: Commitment = {
      id: randomUUID(),
      description: args.description,
      deadline_cycle: args.deadline_cycle,
      pressure_band: args.initial_band ?? 'green',
      job_id: args.job_id ?? null,
      source: args.source,
    };
    this.insert.run(c);
    return c;
  }

  all(): readonly Commitment[] {
    return this.listAll.all() as Commitment[];
  }

  get(id: string): Commitment | null {
    return (this.readOne.get(id) as Commitment | undefined) ?? null;
  }

  /**
   * Recompute every commitment's pressure band given the current
   * cycle and per-commitment total_horizon (default = `deadline_cycle`
   * if no horizon known). Returns the commitments whose band moved.
   */
  refreshBands(currentCycle: number): readonly Commitment[] {
    const all = this.all();
    const moved: Commitment[] = [];
    for (const c of all) {
      const horizon = Math.max(1, c.deadline_cycle);
      const newBand = pressureBand(currentCycle, c.deadline_cycle, horizon);
      if (newBand !== c.pressure_band) {
        this.updateBand.run({ id: c.id, pressure_band: newBand });
        moved.push({ ...c, pressure_band: newBand });
      }
    }
    return moved;
  }

  remove(id: string): void {
    this.deleteOne.run(id);
  }
}
