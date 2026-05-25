/**
 * The episodic-memory decay formula (constitution Principle IV;
 * intent §9.3 — PINNED, must reproduce exactly):
 *
 *     M = R × ln(f + 1) × e^(-t / (τ × D))
 *
 * - M (durability)        : drives forget/promote decisions
 * - R (reinforcement)     : initial strength; reinforced on access
 * - f (access_count)      : how often the entry has been recalled
 * - t (age)               : SECONDS since the entry was last accessed
 * - τ (tau)               : durability time-constant (dial: memoryDurability.tau)
 * - D (durability dial)   : multiplier (dial: memoryDurability.D)
 *
 * The formula governs ONLY episodic memory (constitution Principle
 * IV); identity is permanent, plan and semantic have their own rules.
 *
 * Default thresholds (intent §9.3):
 *   - M < 0.05 → forget
 *   - M > 0.6  → promote (to semantic, with compression)
 *
 * Thresholds and τ, D are operator dials.
 */

export interface DecayParams {
  /** durability time-constant (dial: memoryDurability.tau). */
  readonly tau: number;
  /** durability multiplier (dial: memoryDurability.D). */
  readonly D: number;
  /** forget threshold (dial: promotionThreshold companion). */
  readonly forgetBelow: number;
  /** promote threshold (dial: promotionThreshold). */
  readonly promoteAbove: number;
}

export const DEFAULT_DECAY: DecayParams = Object.freeze({
  tau: 60 * 60 * 24 * 7, // one week, in seconds
  D: 1.0,
  forgetBelow: 0.05,
  promoteAbove: 0.6,
});

export interface DecayInput {
  readonly reinforcement: number;     // R
  readonly access_count: number;       // f
  readonly last_access_ms: number;     // contributes to t
}

/**
 * Compute durability M for an entry as of `now_ms` per the canonical
 * formula. Returns the unbounded value; callers compare to thresholds.
 */
export function durability(
  entry: DecayInput,
  now_ms: number,
  params: DecayParams = DEFAULT_DECAY,
): number {
  const t_seconds = Math.max(0, (now_ms - entry.last_access_ms) / 1000);
  const tau = Math.max(1, params.tau);
  const D = Math.max(0.000001, params.D);
  // PINNED — do not "simplify" or "refactor":
  // M = R × ln(f + 1) × e^(-t / (τ × D))
  return entry.reinforcement * Math.log(entry.access_count + 1) * Math.exp(-t_seconds / (tau * D));
}

export type DecayDecision = 'keep' | 'forget' | 'promote';

export function classify(
  entry: DecayInput,
  now_ms: number,
  params: DecayParams = DEFAULT_DECAY,
): { M: number; decision: DecayDecision } {
  const M = durability(entry, now_ms, params);
  if (M < params.forgetBelow) return { M, decision: 'forget' };
  if (M > params.promoteAbove) return { M, decision: 'promote' };
  return { M, decision: 'keep' };
}
