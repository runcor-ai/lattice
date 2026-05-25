import { randomUUID } from 'node:crypto';

import type { Database as SqliteDb, Statement } from 'better-sqlite3';

import type { SkillFrontmatter } from './skill-md.js';

/**
 * SkillStore — read/write the `skill` table (data-model.md §7).
 *
 * Skills are proposed-but-not-active by default (intent §13: "proposed,
 * not auto-applied"). Activation is gated by the autonomy dial.
 */

export interface Skill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly body_rpp: string;
  readonly abstraction: 'specific' | 'generic';
  readonly minted_at_cycle: number;
  readonly source_job_id: string | null;
  readonly source_item_id: string | null;
  readonly active: 0 | 1;
}

interface InsertParams {
  id: string;
  name: string;
  description: string;
  body_rpp: string;
  abstraction: 'specific' | 'generic';
  minted_at_cycle: number;
  source_job_id: string | null;
  source_item_id: string | null;
  active: 0 | 1;
}

export class SkillStore {
  private readonly insert: Statement<[InsertParams]>;
  private readonly setActive: Statement<[{ id: string; active: 0 | 1 }]>;
  private readonly readOne: Statement<[string]>;
  private readonly listAll: Statement<[]>;
  private readonly listActive: Statement<[]>;
  private readonly count: Statement<[]>;

  constructor(db: SqliteDb) {
    this.insert = db.prepare<[InsertParams]>(
      `INSERT INTO skill (id, name, description, body_rpp, abstraction, minted_at_cycle, source_job_id, source_item_id, active)
       VALUES (@id, @name, @description, @body_rpp, @abstraction, @minted_at_cycle, @source_job_id, @source_item_id, @active)`,
    );
    this.setActive = db.prepare<[{ id: string; active: 0 | 1 }]>(
      `UPDATE skill SET active = @active WHERE id = @id`,
    );
    this.readOne = db.prepare<[string]>(`SELECT * FROM skill WHERE id = ?`);
    this.listAll = db.prepare<[]>(`SELECT * FROM skill ORDER BY minted_at_cycle ASC`);
    this.listActive = db.prepare<[]>(`SELECT * FROM skill WHERE active = 1`);
    this.count = db.prepare<[]>(`SELECT COUNT(*) AS n FROM skill`);
  }

  add(args: {
    frontmatter: SkillFrontmatter;
    body_rpp: string;
    source_job_id?: string | null;
    source_item_id?: string | null;
    active?: boolean;
  }): Skill {
    const id = randomUUID();
    const row: InsertParams = {
      id,
      name: args.frontmatter.name,
      description: args.frontmatter.description,
      abstraction: args.frontmatter.abstraction,
      minted_at_cycle: args.frontmatter.minted_at_cycle,
      body_rpp: args.body_rpp,
      source_job_id: args.source_job_id ?? null,
      source_item_id: args.source_item_id ?? null,
      active: args.active ? 1 : 0,
    };
    this.insert.run(row);
    return { ...row, active: row.active };
  }

  activate(id: string): void {
    this.setActive.run({ id, active: 1 });
  }

  deactivate(id: string): void {
    this.setActive.run({ id, active: 0 });
  }

  get(id: string): Skill | null {
    return (this.readOne.get(id) as Skill | undefined) ?? null;
  }

  all(): readonly Skill[] {
    return this.listAll.all() as Skill[];
  }

  active(): readonly Skill[] {
    return this.listActive.all() as Skill[];
  }

  size(): number {
    return (this.count.get() as { n: number }).n;
  }
}
