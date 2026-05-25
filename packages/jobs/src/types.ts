/**
 * Jobs — the work-completion model (intent §3.1, §9.5; spec FR-033..040;
 * constitution Principle XIII).
 *
 * A Job is a discrete piece of work with a defined "done". It lives
 * in plan memory as a checklist of items. Each item carries a
 * completion check (deterministic hooks + optional judgement pass)
 * and a state. An item is `passed` only when its completion check
 * actually passes — never by assertion. Failed checks iterate.
 * Deferral is the escape hatch — requires a valid externally-grounded
 * reason AND an unblock condition.
 */

export type JobStatus = 'open' | 'closed_full' | 'closed_partial';
export type ItemState = 'open' | 'passed' | 'deferred';

export interface Job {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly status: JobStatus;
  readonly opened_at_cycle: number;
  readonly opened_at_ms: number;
  readonly closed_at_cycle: number | null;
  readonly closed_at_ms: number | null;
  readonly why: string;
}

export interface Item {
  readonly id: string;
  readonly job_id: string;
  readonly ordinal: number;
  readonly description: string;
  readonly state: ItemState;
  readonly iteration_count: number;
  readonly completion_check: string;
  readonly passed_at_cycle: number | null;
  readonly deferred_at_cycle: number | null;
  readonly defer_reason: string | null;
  readonly unblock_condition: string | null;
  readonly unblock_test: string | null;
}

/**
 * CompletionCheck — declarative spec stored as JSON in
 * plan_item.completion_check. Each hook references a function
 * registered in the runtime's CheckRegistry by `name`. The judgement
 * pass is invoked only when all deterministic hooks pass.
 */
export interface CompletionCheckSpec {
  readonly hooks: readonly DeterministicHook[];
  readonly judgement?: JudgementPassSpec;
  /** After this many failed iterations, escalate to operator. Default 5. */
  readonly iterationCap?: number;
}

export interface DeterministicHook {
  readonly name: string;
  /** Optional arguments the hook function reads at run time. */
  readonly args?: Readonly<Record<string, unknown>>;
}

export interface JudgementPassSpec {
  /** Free-form prompt addition for the decider to evaluate. */
  readonly criterion: string;
}

export type CheckOutcome =
  | { result: 'passed' }
  | { result: 'failed'; reason: string }
  | { result: 'judgement_required'; criterion: string };

/**
 * Deferral validation — slice 9 ships a deterministic check (regex
 * over the reason text). Slice 11 can plug an LLM fallback to catch
 * less-obvious rejections.
 */
export interface DeferralProposal {
  readonly itemId: string;
  readonly reason: string;
  readonly unblockCondition: string;
  readonly unblockTest: string;
}

export type DeferralValidation =
  | { admit: true }
  | { admit: false; reason: string };

/**
 * Unblock test — slice 9 supports a small DSL stored as JSON:
 *   { kind: 'sense_data_contains', sense: 'inbox', needle: 'budget' }
 *   { kind: 'sense_present', sense: 'github' }
 *   { kind: 'cycle_after', cycle: 42 }
 *
 * The unblock-watcher in `observe` evaluates these against the
 * perception snapshot every cycle.
 */
export type UnblockTestSpec =
  | { readonly kind: 'sense_data_contains'; readonly sense: string; readonly needle: string }
  | { readonly kind: 'sense_present'; readonly sense: string }
  | { readonly kind: 'cycle_after'; readonly cycle: number };
