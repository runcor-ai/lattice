import { randomUUID } from 'node:crypto';

import type { Database as SqliteDb, Statement } from 'better-sqlite3';

import type { Item, ItemState, Job, JobStatus } from './types.js';

/**
 * Checklist — owns CRUD over plan_job and plan_item. Writes to
 * `plan_job` and `plan_item` (data-model.md §3). State transitions
 * are guarded: an item can only become `passed` via a real check;
 * pass-by-assertion is rejected and traced.
 */

interface NewJobArgs {
  readonly title: string;
  readonly source: string;
  readonly why: string;
  readonly cycle: number;
  readonly at_ms: number;
}

interface NewItemArgs {
  readonly description: string;
  readonly completion_check: string;
  readonly ordinal?: number;
}

interface CloseArgs {
  readonly status: 'closed_full' | 'closed_partial';
  readonly cycle: number;
  readonly at_ms: number;
}

interface UpdateStateArgs {
  readonly cycle: number;
  readonly state: ItemState;
  readonly passed_at_cycle: number | null;
  readonly deferred_at_cycle: number | null;
  readonly defer_reason: string | null;
  readonly unblock_condition: string | null;
  readonly unblock_test: string | null;
  readonly id: string;
}

export class PassByAssertionError extends Error {
  constructor(itemId: string) {
    super(
      `item ${itemId}: cannot mark 'passed' without running its completion check (FR-034)`,
    );
    this.name = 'PassByAssertionError';
  }
}

export class Checklist {
  private readonly insertJob: Statement<[Job]>;
  private readonly closeJob: Statement<[CloseArgs & { id: string }]>;
  private readonly readJob: Statement<[string]>;
  private readonly listOpenJobs: Statement<[]>;
  private readonly insertItem: Statement<[Item]>;
  private readonly listItems: Statement<[string]>;
  private readonly readItem: Statement<[string]>;
  private readonly updateState: Statement<[UpdateStateArgs]>;
  private readonly incrementIteration: Statement<[string]>;

  constructor(private readonly db: SqliteDb) {
    this.insertJob = db.prepare<[Job]>(
      `INSERT INTO plan_job (id, opened_at_cycle, opened_at_ms, title, source, status, closed_at_cycle, closed_at_ms, why)
       VALUES (@id, @opened_at_cycle, @opened_at_ms, @title, @source, @status, @closed_at_cycle, @closed_at_ms, @why)`,
    );
    this.closeJob = db.prepare<[CloseArgs & { id: string }]>(
      `UPDATE plan_job
         SET status = @status,
             closed_at_cycle = @cycle,
             closed_at_ms = @at_ms
       WHERE id = @id`,
    );
    this.readJob = db.prepare<[string]>(`SELECT * FROM plan_job WHERE id = ?`);
    this.listOpenJobs = db.prepare<[]>(
      `SELECT * FROM plan_job WHERE status = 'open' ORDER BY opened_at_cycle ASC`,
    );
    this.insertItem = db.prepare<[Item]>(
      `INSERT INTO plan_item (id, job_id, ordinal, description, state, iteration_count,
                              completion_check, passed_at_cycle, deferred_at_cycle,
                              defer_reason, unblock_condition, unblock_test)
       VALUES (@id, @job_id, @ordinal, @description, @state, @iteration_count,
               @completion_check, @passed_at_cycle, @deferred_at_cycle,
               @defer_reason, @unblock_condition, @unblock_test)`,
    );
    this.listItems = db.prepare<[string]>(
      `SELECT * FROM plan_item WHERE job_id = ? ORDER BY ordinal ASC`,
    );
    this.readItem = db.prepare<[string]>(`SELECT * FROM plan_item WHERE id = ?`);
    this.updateState = db.prepare<[UpdateStateArgs]>(
      `UPDATE plan_item
         SET state = @state,
             passed_at_cycle = @passed_at_cycle,
             deferred_at_cycle = @deferred_at_cycle,
             defer_reason = @defer_reason,
             unblock_condition = @unblock_condition,
             unblock_test = @unblock_test
       WHERE id = @id`,
    );
    this.incrementIteration = db.prepare<[string]>(
      `UPDATE plan_item SET iteration_count = iteration_count + 1 WHERE id = ?`,
    );
  }

  openJob(args: NewJobArgs): Job {
    if (!args.why || args.why.trim() === '') {
      throw new Error('job.why is required (FR-015)');
    }
    const job: Job = {
      id: randomUUID(),
      title: args.title,
      source: args.source,
      status: 'open',
      opened_at_cycle: args.cycle,
      opened_at_ms: args.at_ms,
      closed_at_cycle: null,
      closed_at_ms: null,
      why: args.why,
    };
    this.insertJob.run(job);
    return job;
  }

  getJob(id: string): Job | null {
    return (this.readJob.get(id) as Job | undefined) ?? null;
  }

  listOpen(): readonly Job[] {
    return this.listOpenJobs.all() as Job[];
  }

  addItem(jobId: string, args: NewItemArgs): Item {
    const items = this.items(jobId);
    const ordinal = args.ordinal ?? items.length;
    const item: Item = {
      id: randomUUID(),
      job_id: jobId,
      ordinal,
      description: args.description,
      state: 'open',
      iteration_count: 0,
      completion_check: args.completion_check,
      passed_at_cycle: null,
      deferred_at_cycle: null,
      defer_reason: null,
      unblock_condition: null,
      unblock_test: null,
    };
    this.insertItem.run(item);
    return item;
  }

  items(jobId: string): readonly Item[] {
    return this.listItems.all(jobId) as Item[];
  }

  getItem(id: string): Item | null {
    return (this.readItem.get(id) as Item | undefined) ?? null;
  }

  /**
   * Mark an item as passed — ONLY callable from runCompletionCheck()
   * (slice 9 enforces this via the `assertedCheckRun: true` flag,
   * which only that helper sets). External callers get
   * PassByAssertionError.
   */
  markPassed(itemId: string, cycle: number, assertedCheckRun = false): void {
    if (!assertedCheckRun) {
      throw new PassByAssertionError(itemId);
    }
    const current = this.getItem(itemId);
    if (!current) throw new Error(`item ${itemId} not found`);
    this.updateState.run({
      id: itemId,
      state: 'passed',
      passed_at_cycle: cycle,
      deferred_at_cycle: null,
      defer_reason: null,
      unblock_condition: null,
      unblock_test: null,
      cycle,
    });
  }

  markDeferred(
    itemId: string,
    args: {
      cycle: number;
      reason: string;
      unblockCondition: string;
      unblockTest: string;
    },
  ): void {
    const current = this.getItem(itemId);
    if (!current) throw new Error(`item ${itemId} not found`);
    this.updateState.run({
      id: itemId,
      state: 'deferred',
      passed_at_cycle: null,
      deferred_at_cycle: args.cycle,
      defer_reason: args.reason,
      unblock_condition: args.unblockCondition,
      unblock_test: args.unblockTest,
      cycle: args.cycle,
    });
  }

  /** Clear deferral and reopen the item — used when unblock condition is met. */
  unblock(itemId: string): void {
    const current = this.getItem(itemId);
    if (!current) throw new Error(`item ${itemId} not found`);
    this.updateState.run({
      id: itemId,
      state: 'open',
      passed_at_cycle: null,
      deferred_at_cycle: null,
      defer_reason: null,
      unblock_condition: null,
      unblock_test: null,
      cycle: 0,
    });
  }

  incrementIterationOf(itemId: string): void {
    this.incrementIteration.run(itemId);
  }

  closeJobWith(jobId: string, args: CloseArgs): JobStatus {
    this.closeJob.run({ ...args, id: jobId });
    return args.status;
  }
}
