import type { Database as SqliteDb } from 'better-sqlite3';

import {
  type AppliedCorrection,
  type SweepContext,
  type SweepObservation,
  type SweepResult,
  type SweepRule,
} from './subconscious-types.js';
import { DEFAULT_RULES } from './sweep-rules.js';

/**
 * runSubconsciousSweep — the deterministic, every-cycle pass
 * (constitution Principle V; spec FR-030..032).
 *
 * For each rule:
 *   detect() — find candidates
 *   for each candidate:
 *     if canAct(): apply() AND record an AppliedCorrection
 *     else      : record a SweepObservation (judgement required)
 *
 * The caller is responsible for the SQLite transaction. The runtime
 * runs the sweep inside the cycle's existing BEGIN/COMMIT so the
 * sweep's writes commit atomically with the cycle's other writes
 * (or roll back together on a crash).
 *
 * Per FR-031: when the sweep acts it MUST also FLAG the correction
 * so the same cycle's judgement (and the next cycle's recall) can
 * see it. The flag is the AppliedCorrection record returned here;
 * the runtime is responsible for writing it to the trace + threading
 * it forward.
 */
export function runSubconsciousSweep(
  db: SqliteDb,
  ctx: SweepContext,
  rules: readonly SweepRule[] = DEFAULT_RULES,
): SweepResult {
  const applied: AppliedCorrection[] = [];
  const observedOnly: SweepObservation[] = [];

  for (const rule of rules) {
    const candidates = rule.detect(db);
    for (const c of candidates) {
      if (rule.canAct(c)) {
        rule.apply(db, c, ctx);
        applied.push({
          rule: c.rule,
          memoryTable: c.memoryTable,
          memoryId: c.memoryId,
          was: c.was ?? '(none)',
          now_is: c.now_is ?? '(none)',
          cycle: ctx.cycle,
          at_ms: ctx.at_ms,
        });
      } else {
        observedOnly.push({
          rule: c.rule,
          memoryTable: c.memoryTable,
          memoryId: c.memoryId,
          detail: c.detail,
          reason: 'requires_judgement',
        });
      }
    }
  }

  return { applied, observedOnly };
}
