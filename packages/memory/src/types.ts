/**
 * Memory types — the four genuinely separate memory systems
 * (constitution Principle IV; intent spec §9.2).
 *
 *   1. Identity  — what the entity IS. PERMANENT (immune to decay).
 *   2. Plan      — where the entity is GOING. Rewritable but never evaporates.
 *   3. Episodic  — what HAPPENED. Decays per the exact formula.
 *   4. Semantic  — settled FACTS. Persists, correctable by the subconscious.
 *
 * Each system has its own store. The four stores are NOT collapsed
 * into a single decaying store (constitution principle).
 */

export type MemorySystem = 'identity' | 'plan' | 'episodic' | 'semantic';

export type AdmissionTag =
  /** A judgement, decision, or its reasoning — admit. */
  | 'decision'
  /** Stakeholder guidance — admit. */
  | 'guidance'
  /** Who is doing what / why — admit. */
  | 'attribution'
  /** Auto-recorded cycle outcome — admit. */
  | 'cycle-outcome'
  /** Stakeholder commitment / promise — admit. */
  | 'commitment'
  /** Re-perceivable file content — REJECT (re-perceive next cycle). */
  | 'file-content'
  /** Re-perceivable tracker / external-state snapshot — REJECT. */
  | 'tracker-state'
  /** Re-perceivable code / structure — REJECT. */
  | 'code-structure'
  /** Catch-all for "I don't know" — gated to require explicit operator override. */
  | 'unknown';

export type SemanticSource = 'promoted' | 'derived' | 'operator' | 'collaboration';

export interface BaseMemoryEntry {
  readonly id: string;
  readonly cycle: number;
  readonly written_at_ms: number;
  readonly body: string;
  readonly why: string;
}

export interface IdentityMemoryEntry extends BaseMemoryEntry {
  readonly system: 'identity';
}

export interface EpisodicMemoryEntry extends BaseMemoryEntry {
  readonly system: 'episodic';
  readonly reinforcement: number;
  readonly access_count: number;
  readonly last_access_ms: number;
  readonly durability: number | null;
}

export interface SemanticMemoryEntry extends BaseMemoryEntry {
  readonly system: 'semantic';
  readonly last_validated_ms: number;
  readonly source_kind: SemanticSource;
  readonly source_ref: string | null;
}

export type MemoryEntry = IdentityMemoryEntry | EpisodicMemoryEntry | SemanticMemoryEntry;

export interface MemoryIndexEntry {
  readonly id: string;
  readonly memory_table: 'identity' | 'plan_job' | 'plan_item' | 'episodic' | 'semantic';
  readonly memory_id: string;
  readonly description: string;
  readonly written_at_ms: number;
}

/**
 * RecallView — what a cycle's `recall` phase receives. Each entry
 * carries a human-readable age + a freshness caveat when stale
 * (FR-017).
 */
export interface RecalledMemory {
  readonly entry: MemoryEntry;
  readonly humanAge: string;
  /** Empty string when fresh; freshness caveat when stale. */
  readonly freshnessCaveat: string;
}
