import type { Database as SqliteDb } from 'better-sqlite3';

import { Checklist, PassByAssertionError } from './checklist.js';
import type {
  CheckRegistry} from './completion-check.js';
import {
  builtinRegistry,
  defaultIterationCap,
  parseSpec,
  runDeterministicHooks,
} from './completion-check.js';
import { validateDeferral } from './deferral.js';
import { attemptClose, type ClosureResult } from './sign-off.js';
import type {
  CompletionCheckSpec,
  DeferralProposal,
  DeferralValidation,
  Item,
  Job,
} from './types.js';
import { checkUnblocked, type PerceptionLike, type UnblockedItem } from './unblock-watcher.js';

/**
 * JobsService — the high-level API the runtime + tests use.
 *
 * Composes Checklist + CompletionCheck registry + deferral
 * validation + unblock watcher + sign-off.
 */
export interface CheckAttemptResult {
  readonly outcome: 'passed' | 'failed_iterating' | 'judgement_required' | 'iteration_cap_exceeded';
  readonly item: Item;
  readonly reason?: string;
  readonly criterion?: string;
}

export class JobsService {
  readonly checklist: Checklist;
  readonly registry: CheckRegistry;
  private readonly db: SqliteDb;

  constructor(
    db: SqliteDb,
    opts: { registry?: CheckRegistry } = {},
  ) {
    this.db = db;
    this.checklist = new Checklist(db);
    this.registry = opts.registry ?? builtinRegistry();
  }

  openJob(args: { title: string; source: string; why: string; cycle: number; at_ms: number }): Job {
    return this.checklist.openJob(args);
  }

  addItem(jobId: string, args: { description: string; spec: CompletionCheckSpec }): Item {
    const completion_check = JSON.stringify(args.spec);
    return this.checklist.addItem(jobId, {
      description: args.description,
      completion_check,
    });
  }

  /**
   * Attempt a completion check for one item.
   *   - Passed (no judgement needed) → mark passed.
   *   - Passed (judgement required) → return so caller (decider) can evaluate.
   *   - Failed                       → increment iteration; check cap.
   *
   * `mode`:
   *   - `'lattice'` (default) — the lattice itself is checking. Failure
   *     increments iteration_count and counts against the per-item
   *     iteration cap. This is the appropriate mode for the
   *     close-job-item action (the lattice is asserting it believes
   *     the item is done) and for any explicit operator close.
   *   - `'auto'` — the subconscious sweep is polling cheaply every
   *     cycle to see if a deterministic hook now passes. Failure does
   *     NOT increment iteration_count and does NOT consume budget.
   *     This respects Principle V: code-only polling is the
   *     subconscious's job, not "the lattice tried and failed."
   *
   * Without the mode separation, the subconscious sweep would
   * exhaust every item's iteration cap before its deliverable file
   * ever exists — the polling itself would lock the item closed.
   * That bug was caught in the 2026-05-25 ABC port run (cycle 28
   * hit Phase C's marker but the item couldn't pass — iter=5/5).
   */
  attemptCheck(
    itemId: string,
    ctx: { cycle: number; mode?: 'lattice' | 'auto' },
  ): CheckAttemptResult {
    const item = this.checklist.getItem(itemId);
    if (!item) throw new Error(`item ${itemId} not found`);
    const spec = parseSpec(item.completion_check);
    const cap = defaultIterationCap(spec);
    const mode = ctx.mode ?? 'lattice';

    if (item.iteration_count >= cap) {
      return {
        outcome: 'iteration_cap_exceeded',
        item,
        reason: `iteration_count ${item.iteration_count} >= cap ${cap}`,
      };
    }

    const out = runDeterministicHooks(spec, this.registry, { item, cycle: ctx.cycle });
    if (out.result === 'failed') {
      if (mode === 'lattice') {
        this.checklist.incrementIterationOf(itemId);
        return { outcome: 'failed_iterating', item: this.checklist.getItem(itemId)!, reason: out.reason };
      }
      // auto mode: do NOT increment iteration_count. The sweep ran
      // and the hook said no — just report it and move on. The
      // lattice's own attempts (via close-job-item) still consume
      // budget normally.
      return { outcome: 'failed_iterating', item, reason: out.reason };
    }
    if (out.result === 'judgement_required') {
      return { outcome: 'judgement_required', item, criterion: out.criterion };
    }
    this.checklist.markPassed(itemId, ctx.cycle, /* assertedCheckRun */ true);
    return { outcome: 'passed', item: this.checklist.getItem(itemId)! };
  }

  /**
   * The judgement pass produced its verdict — called by the
   * runtime's decide phase after running the decider.
   */
  recordJudgement(
    itemId: string,
    verdict: { passed: boolean; reason?: string },
    cycle: number,
  ): Item {
    if (verdict.passed) {
      this.checklist.markPassed(itemId, cycle, /* assertedCheckRun */ true);
    } else {
      this.checklist.incrementIterationOf(itemId);
    }
    return this.checklist.getItem(itemId)!;
  }

  /**
   * Refuses pass-by-assertion (FR-034). Use attemptCheck or
   * recordJudgement instead.
   */
  markPassed(itemId: string): never {
    throw new PassByAssertionError(itemId);
  }

  defer(proposal: DeferralProposal, ctx: { cycle: number }): DeferralValidation {
    const validation = validateDeferral(proposal);
    if (!validation.admit) return validation;
    this.checklist.markDeferred(proposal.itemId, {
      cycle: ctx.cycle,
      reason: proposal.reason,
      unblockCondition: proposal.unblockCondition,
      unblockTest: proposal.unblockTest,
    });
    return validation;
  }

  unblockItem(itemId: string): void {
    this.checklist.unblock(itemId);
  }

  detectUnblocked(perception: PerceptionLike): readonly UnblockedItem[] {
    return checkUnblocked(this.db, perception);
  }

  close(args: {
    jobId: string;
    cycle: number;
    at_ms: number;
    autonomy: 'low' | 'medium' | 'high';
    operatorApproved?: boolean;
  }): ClosureResult {
    return attemptClose(this.checklist, args);
  }
}
