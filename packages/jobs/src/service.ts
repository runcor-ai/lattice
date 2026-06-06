import type { Database as SqliteDb } from 'better-sqlite3';

import { Checklist, PassByAssertionError } from './checklist.js';
import type {
  CheckRegistry} from './completion-check.js';
import {
  builtinRegistry,
  defaultIterationCap,
  isKnownHook,
  parseSpec,
  runDeterministicHooks,
} from './completion-check.js';
import { validateDeferral } from './deferral.js';
import { onPlanFileReady } from './plan-chain.js';
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
  readonly outcome: 'passed' | 'failed_iterating' | 'judgement_required' | 'iteration_cap_exceeded' | 'blocked';
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

  openJob(args: { title: string; source: string; why: string; cycle: number; at_ms: number; body?: string }): Job {
    return this.checklist.openJob(args);
  }

  addItem(
    jobId: string,
    args: { description: string; spec: CompletionCheckSpec; source?: string; blocked_by?: string | null },
  ): Item {
    const completion_check = JSON.stringify(args.spec);
    return this.checklist.addItem(jobId, {
      description: args.description,
      completion_check,
      ...(args.source ? { source: args.source } : {}),
      ...(args.blocked_by !== undefined ? { blocked_by: args.blocked_by } : {}),
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
  async attemptCheck(
    itemId: string,
    ctx: { cycle: number; mode?: 'lattice' | 'auto' },
  ): Promise<CheckAttemptResult> {
    const item = this.checklist.getItem(itemId);
    if (!item) throw new Error(`item ${itemId} not found`);

    // Item 5 — ordered chaining: an item cannot pass until its blocker
    // passes. Reported as 'blocked' (no hooks run, no iteration consumed)
    // so the lattice cannot skip ahead and the sweep simply waits.
    if (item.blocked_by) {
      const blocker = this.checklist.getItem(item.blocked_by);
      if (blocker && blocker.state !== 'passed') {
        return {
          outcome: 'blocked',
          item,
          reason: `blocked until "${blocker.description.slice(0, 60)}" passes`,
        };
      }
    }

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

    const out = await runDeterministicHooks(spec, this.registry, { item, cycle: ctx.cycle, mode });
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
    const passed = this.checklist.getItem(itemId)!;
    // Item 5 — when the Item 4 plan gate passes, parse the plan file and
    // append the chained plan_step items (once). This is the single
    // onPlanFileReady trigger point.
    if (passed.source === 'system') {
      onPlanFileReady(this.checklist, passed);
    }
    return { outcome: 'passed', item: passed };
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

  /**
   * Item 8 — append a lattice-authored item to an OPEN job. Shared by the
   * bridge endpoint and the in-process append-plan-item capability so both
   * run the same validation + audit. Append-only; never mutates existing
   * items. Rejects (does not throw) on every invalid case so callers map
   * cleanly to HTTP status / capability result.
   *
   * Validation: job exists and is open; gate type is in the built-in
   * vocabulary; the optional blocker exists on the same job; and the
   * per-job lattice-append cap is not exceeded (a coarse runaway guard —
   * the spec's per-cycle cap needs cross-request state the stateless
   * append path lacks; see grounding doc).
   */
  appendLatticeItem(
    jobId: string,
    args: { description: string; gateType: string; gateArgs?: Record<string, unknown>; blockedBy?: string | null },
    ctx: { cycle: number; at_ms: number; trace?: { write(entry: AppendTraceEntry): void }; maxPerJob?: number },
  ): AppendResult {
    const job = this.checklist.getJob(jobId);
    if (!job) return { ok: false, code: 'job_not_found', reason: `job ${jobId} not found` };
    if (job.status !== 'open') return { ok: false, code: 'job_not_open', reason: `job is ${job.status}; cannot append` };
    if (typeof args.description !== 'string' || args.description.trim().length === 0) {
      return { ok: false, code: 'invalid_request', reason: 'description is required' };
    }
    if (!isKnownHook(args.gateType)) {
      return { ok: false, code: 'invalid_gate', reason: `unknown gate type: ${args.gateType}` };
    }
    if (args.blockedBy) {
      const blocker = this.checklist.getItem(args.blockedBy);
      if (!blocker || blocker.job_id !== jobId) {
        return { ok: false, code: 'invalid_blocker', reason: `blocker ${args.blockedBy} not found on job ${jobId}` };
      }
    }
    const cap = ctx.maxPerJob ?? 25;
    const appended = this.checklist.items(jobId).filter((i) => i.source === 'lattice_appended').length;
    if (appended >= cap) {
      return { ok: false, code: 'append_cap', reason: `lattice-append cap (${cap}) reached for job ${jobId}` };
    }

    const item = this.addItem(jobId, {
      description: args.description,
      spec: { hooks: [{ name: args.gateType, args: args.gateArgs ?? {} }] },
      source: 'lattice_appended',
      blocked_by: args.blockedBy ?? null,
    });
    ctx.trace?.write({
      kind: 'job',
      cycle: ctx.cycle,
      at_ms: ctx.at_ms,
      event: 'item_appended',
      job_id: jobId,
      item_id: item.id,
      detail: `lattice appended: ${args.description.slice(0, 60)}${args.blockedBy ? ` (blocked_by ${args.blockedBy})` : ''}`,
    });
    return { ok: true, item };
  }
}

/** Minimal trace surface appendLatticeItem writes to (a `job` entry). */
interface AppendTraceEntry {
  kind: 'job';
  cycle: number;
  at_ms: number;
  event: 'item_appended';
  job_id: string;
  item_id?: string;
  detail?: string;
}

export type AppendResult =
  | { ok: true; item: Item }
  | { ok: false; code: 'job_not_found' | 'job_not_open' | 'invalid_request' | 'invalid_gate' | 'invalid_blocker' | 'append_cap'; reason: string };
