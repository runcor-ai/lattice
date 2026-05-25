import type { Database as SqliteDb } from 'better-sqlite3';

/**
 * Subconscious sweep types (constitution Principle V; spec
 * FR-030..032).
 *
 * The sweep runs every cycle in the write phase. It fixes ONLY flat,
 * judgement-free problems. Anything requiring judgement is detected,
 * traced as such, and left for the work layer.
 */

export interface SweepCandidate {
  /** Which sweep rule raised this candidate. */
  readonly rule: string;
  /** Which table the candidate sits in (for the audit). */
  readonly memoryTable: 'identity' | 'episodic' | 'semantic' | 'memory_index';
  /** The offending row's id. */
  readonly memoryId: string;
  /** Human-readable detail of what is wrong. */
  readonly detail: string;
  /** When acting: the pre-image. */
  readonly was?: string;
  /** When acting: the post-image. */
  readonly now_is?: string;
}

export interface SweepRule {
  readonly name: string;
  /** Find candidate rows that look wrong. MUST be cheap. */
  detect(db: SqliteDb): readonly SweepCandidate[];
  /**
   * Can this candidate be fixed deterministically (no judgement)?
   * If false, the sweep DETECTS but does not act — Principle V.
   */
  canAct(c: SweepCandidate): boolean;
  /** Apply the fix. Caller is responsible for transactional context. */
  apply(db: SqliteDb, c: SweepCandidate, ctx: SweepContext): void;
}

export interface SweepContext {
  readonly cycle: number;
  readonly at_ms: number;
}

export interface AppliedCorrection {
  readonly rule: string;
  readonly memoryTable: SweepCandidate['memoryTable'];
  readonly memoryId: string;
  readonly was: string;
  readonly now_is: string;
  readonly cycle: number;
  readonly at_ms: number;
}

export interface SweepObservation {
  readonly rule: string;
  readonly memoryTable: SweepCandidate['memoryTable'];
  readonly memoryId: string;
  readonly detail: string;
  readonly reason: 'requires_judgement';
}

export interface SweepResult {
  /** Candidates that were acted on. */
  readonly applied: readonly AppliedCorrection[];
  /** Candidates the sweep saw but refused to act on (Principle V). */
  readonly observedOnly: readonly SweepObservation[];
}
