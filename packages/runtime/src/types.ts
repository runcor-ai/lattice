/**
 * Runtime types — the cycle's state machine and shared cycle context.
 *
 * Constitution Principle VI pins the eight phases in order:
 *   observe → ground → recall → decide → act → judge → write → pulse
 *
 * The phase order is enforced at the type level: each phase's output
 * type is the next phase's input type. You cannot call `decide` before
 * `recall` returned, etc.
 */

import type {
  Capability,
  PerceptionSnapshot,
} from '@runcor/capabilities';
import type { Decider, DecideResult } from '@runcor/decider';
import type { ModelBackend } from '@runcor/engine';
import type { AutonomyLevel, DiscernResult, RppPrompt } from '@runcor/substrate';
import type { CyclePhase, Trace } from '@runcor/trace';

export type { CyclePhase };
export type { AutonomyLevel, RppPrompt };

export interface LatticeIdentity {
  /**
   * Item 10 — the three seed layers, separated by cadence:
   *   - Layer 1 (persona): `composed_body`, injected into EVERY cycle's
   *     prompt as the identity assertion. Stable "who this lattice is".
   *   - Layer 2 (init): `initLayer`, one-time setup persisted into memory
   *     ONCE at startup, never re-sent into per-cycle prompts.
   *   - Layer 3 (job body): not stored here — it is the active job's
   *     `body`, swapped in per job by the prompt builder (ground.ts).
   */
  readonly composed_body: string;
  /** Layer 2 — one-time init content, promoted to memory at startup. */
  readonly initLayer?: string;
}

/**
 * MemoryWrite — what the runtime's `write` phase produces.
 *
 * Slice 4 added `admissionTag` (constitution Principle XII / FR-014):
 * every write declares what kind of thing it is, and the
 * `@runcor/memory.admission` gate rejects re-perceivable tags.
 */
export type RuntimeAdmissionTag =
  | 'decision'
  | 'guidance'
  | 'attribution'
  | 'cycle-outcome'
  | 'commitment'
  | 'unknown';

export interface MemoryWrite {
  readonly system: 'identity' | 'plan' | 'episodic' | 'semantic';
  readonly body: string;
  readonly why: string;
  readonly admissionTag: RuntimeAdmissionTag;
}

export interface MemorySink {
  write(entry: MemoryWrite, ctx: { cycle: number; at_ms: number }): void;
  size(system?: MemoryWrite['system']): number;
}

/**
 * MemoryRecallView — what `recall` reads. Slice 4 returns real
 * @runcor/memory entries.
 */
export interface MemoryRecallView {
  recentEpisodic(limit: number): readonly MemoryWrite[];
  /** Item 1 — the latest fast-clock situation report, or null before the first. */
  currentSituation(): string | null;
}

/**
 * A read-only view over the lattice's job state, surfaced to phases
 * that need to know what the operator has asked the lattice to do.
 * Implemented by JobsService (the runtime composes one per cycle).
 */
export interface TasksView {
  /** Open jobs in opened-at order. `body` is the Item 10 Layer-3 content. */
  listOpenJobs(): readonly { id: string; title: string; why: string; body: string }[];
  /**
   * Open items for a given job (status === 'open'). `gate` is the item's
   * live deterministic-gate verdict, evaluated against the filesystem this
   * cycle, so the reality slice can contradict a drifted situation summary
   * with ground truth (an item whose gate already passes, or the exact
   * condition still missing).
   */
  listOpenItems(jobId: string): readonly {
    id: string;
    description: string;
    iteration_count: number;
    gate: { passed: boolean; reason: string; deferred: boolean };
  }[];
}

/** Context shared by every phase of one cycle. Built fresh per cycle. */
export interface CycleContext {
  readonly cycle: number;
  readonly at_ms: number;
  readonly trace: Trace;
  readonly engine: ModelBackend;
  /** The configured decider for this lattice. Slice 8: SingleModelDecider or DialecticDecider. */
  readonly decider: Decider;
  readonly identity: LatticeIdentity;
  readonly senses: readonly Capability<unknown, unknown>[];
  readonly actions: readonly Capability<unknown, unknown>[];
  readonly memory: MemorySink;
  readonly recall: MemoryRecallView;
  readonly abortSignal: AbortSignal;
  /** Autonomy dial value for this cycle. Default 'medium'. Slice 14 reads from dial table. */
  readonly autonomy: AutonomyLevel;
  /** Optional tasks view; if absent, ground.ts skips the open-jobs section. */
  readonly tasks?: TasksView;
  /** Item 1 — when true, the write phase runs the fast/medium memory clocks. */
  readonly memoryClocks: boolean;
}

// Per-phase outputs (each phase's output is the next phase's input).
export interface ObserveOutput {
  readonly perception: PerceptionSnapshot;
}
export interface GroundOutput extends ObserveOutput {
  /** Slice 5: substrate-wrapped, R++-typed prompt. */
  readonly groundedPrompt: RppPrompt;
}
export interface RecallOutput extends GroundOutput {
  readonly memories: readonly MemoryWrite[];
}
export interface DecideOutput extends RecallOutput {
  /** Slice 8: parser-validated R++ tree + usage from the decider. */
  readonly decision: DecideResult;
  /** Plain-text rendering of the decision for downstream substrate checks. */
  readonly decisionText: string;
  readonly chosenAction: string | null;
  /** Input parameters for the chosen action, parsed from the R++ TOKENS block. */
  readonly chosenInput: Record<string, unknown>;
}
export interface ActOutput extends DecideOutput {
  readonly actResult: 'ok' | 'no-action' | 'failed';
  readonly actFailedReason?: string;
  /** Result data from the invoked capability (capped). Persisted to episodic memory by write. */
  readonly actData?: unknown;
}
export interface JudgeOutput extends ActOutput {
  readonly judgement: 'pass' | 'modify' | 'block' | 'escalate';
  /** Slice 5: full discernment result with per-law findings. */
  readonly discernment: DiscernResult;
  /** Resolved action after applying the autonomy dial. */
  readonly resolution: 'execute' | 'retry_decide' | 'wait_operator';
}
export interface WriteOutput extends JudgeOutput {
  readonly memoryWrites: number;
}
export interface PulseOutput {
  readonly continue: true;
}

/**
 * The eight phase signatures. The orchestrator (cycle.ts) is the only
 * caller of these in production; tests may invoke phases individually.
 */
export type PhaseRunners = {
  observe(ctx: CycleContext): Promise<ObserveOutput>;
  ground(ctx: CycleContext, prev: ObserveOutput): Promise<GroundOutput>;
  recall(ctx: CycleContext, prev: GroundOutput): Promise<RecallOutput>;
  decide(ctx: CycleContext, prev: RecallOutput): Promise<DecideOutput>;
  act(ctx: CycleContext, prev: DecideOutput): Promise<ActOutput>;
  judge(ctx: CycleContext, prev: ActOutput): Promise<JudgeOutput>;
  write(ctx: CycleContext, prev: JudgeOutput): Promise<WriteOutput>;
  pulse(ctx: CycleContext, prev: WriteOutput): Promise<PulseOutput>;
};

export interface CycleResult {
  readonly cycle: number;
  readonly outcome: 'completed' | 'aborted' | 'failed';
  readonly write?: WriteOutput;
  readonly pulse?: PulseOutput;
  readonly failedAt?: CyclePhase;
  readonly failedReason?: string;
}
