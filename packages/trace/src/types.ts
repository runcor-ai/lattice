/**
 * Trace types — the cognitive record (constitution Principle X).
 *
 * Every cycle, every subconscious correction, every job event, every
 * substrate flag, every operator action is recorded. See
 * specs/001-lattice-core/data-model.md §8 for the canonical row format.
 */

export const CYCLE_PHASES = [
  'observe',
  'ground',
  'recall',
  'decide',
  'act',
  'judge',
  'write',
  'pulse',
] as const;

export type CyclePhase = (typeof CYCLE_PHASES)[number];

export interface BaseTraceEntry {
  kind: TraceKind;
  cycle: number;
  at_ms: number;
}

export type TraceKind = 'phase' | 'subconscious' | 'job' | 'substrate' | 'operator';

export interface PhaseTraceEntry extends BaseTraceEntry {
  kind: 'phase';
  phase: CyclePhase;
  duration_ms: number;
  input_summary?: string;
  output_summary?: string;
  result: 'ok' | 'skipped' | 'failed';
  failed_reason?: string;
}

export interface SubconsciousTraceEntry extends BaseTraceEntry {
  kind: 'subconscious';
  rule: string;
  memory_id?: string;
  was?: string;
  now?: string;
}

export type JobEvent =
  | 'opened'
  | 'item_passed'
  | 'item_failed_iterating'
  | 'item_deferred'
  | 'item_unblocked'
  | 'closed_full'
  | 'closed_partial';

export interface JobTraceEntry extends BaseTraceEntry {
  kind: 'job';
  event: JobEvent;
  job_id: string;
  item_id?: string;
  detail?: string;
}

export type SubstrateOutcome = 'pass' | 'modify' | 'block' | 'escalate';

export interface SubstrateTraceEntry extends BaseTraceEntry {
  kind: 'substrate';
  phase: CyclePhase;
  outcome: SubstrateOutcome;
  law?: string;
  reason?: string;
}

export type OperatorAction =
  | 'dial_adjusted'
  | 'lifecycle'
  | 'job_handed'
  | 'escalation_decided'
  | 'restart_marker';

export interface OperatorTraceEntry extends BaseTraceEntry {
  kind: 'operator';
  action: OperatorAction;
  detail?: string;
}

export type TraceEntry =
  | PhaseTraceEntry
  | SubconsciousTraceEntry
  | JobTraceEntry
  | SubstrateTraceEntry
  | OperatorTraceEntry;
