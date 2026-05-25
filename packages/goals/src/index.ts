import { randomUUID } from 'node:crypto';

import type { Database as SqliteDb, Statement } from 'better-sqlite3';

/**
 * Goals — the discovered intention stack (intent §10; spec US11).
 *
 * A goal is a statement of intent the lattice is trying to achieve.
 * Goals form a stack: a top-level goal may produce sub-goals during
 * decide. Each goal has a state (proposed/active/satisfied/abandoned)
 * and a "why".
 */

export type GoalState = 'proposed' | 'active' | 'satisfied' | 'abandoned';

export interface Goal {
  readonly id: string;
  readonly body: string;
  readonly proposed_at_cycle: number;
  readonly parent_id: string | null;
  readonly state: GoalState;
  readonly why: string;
}

interface InsertParams {
  id: string;
  body: string;
  proposed_at_cycle: number;
  parent_id: string | null;
  state: GoalState;
  why: string;
}
interface UpdateStateParams {
  id: string;
  state: GoalState;
}

export class GoalsStore {
  private readonly insert: Statement<[InsertParams]>;
  private readonly listAll: Statement<[]>;
  private readonly listActive: Statement<[]>;
  private readonly readOne: Statement<[string]>;
  private readonly updateState: Statement<[UpdateStateParams]>;
  private readonly countByState: Statement<[]>;

  constructor(db: SqliteDb) {
    this.insert = db.prepare<[InsertParams]>(
      `INSERT INTO goal (id, body, proposed_at_cycle, parent_id, state, why)
       VALUES (@id, @body, @proposed_at_cycle, @parent_id, @state, @why)`,
    );
    this.listAll = db.prepare<[]>(`SELECT * FROM goal ORDER BY proposed_at_cycle ASC`);
    this.listActive = db.prepare<[]>(
      `SELECT * FROM goal WHERE state IN ('proposed','active') ORDER BY proposed_at_cycle ASC`,
    );
    this.readOne = db.prepare<[string]>(`SELECT * FROM goal WHERE id = ?`);
    this.updateState = db.prepare<[UpdateStateParams]>(
      `UPDATE goal SET state = @state WHERE id = @id`,
    );
    this.countByState = db.prepare<[]>(
      `SELECT state, COUNT(*) AS n FROM goal GROUP BY state`,
    );
  }

  propose(args: {
    body: string;
    cycle: number;
    why: string;
    parentId?: string | null;
  }): Goal {
    if (!args.why || args.why.trim() === '') throw new Error('goal.why is required (FR-015)');
    const goal: Goal = {
      id: randomUUID(),
      body: args.body,
      proposed_at_cycle: args.cycle,
      parent_id: args.parentId ?? null,
      state: 'proposed',
      why: args.why,
    };
    this.insert.run(goal);
    return goal;
  }

  activate(id: string): void {
    this.updateState.run({ id, state: 'active' });
  }

  satisfy(id: string): void {
    this.updateState.run({ id, state: 'satisfied' });
  }

  abandon(id: string): void {
    this.updateState.run({ id, state: 'abandoned' });
  }

  get(id: string): Goal | null {
    return (this.readOne.get(id) as Goal | undefined) ?? null;
  }

  all(): readonly Goal[] {
    return this.listAll.all() as Goal[];
  }

  active(): readonly Goal[] {
    return this.listActive.all() as Goal[];
  }

  counts(): Record<GoalState, number> {
    const rows = this.countByState.all() as Array<{ state: GoalState; n: number }>;
    const out: Record<GoalState, number> = {
      proposed: 0,
      active: 0,
      satisfied: 0,
      abandoned: 0,
    };
    for (const r of rows) out[r.state] = r.n;
    return out;
  }
}
