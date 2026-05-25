import { Memory } from '@runcor/memory';
import { findGaps, type WatchdogFinding } from '@runcor/watchdog';
import type { Database as SqliteDb } from 'better-sqlite3';

/**
 * Drift review (intent §7; spec FR-028).
 *
 * The slow-clock pass that judges whether the entity has wandered —
 * off-purpose, off-character, or blind to something it should have
 * acted on. Writes findings as semantic memories with
 * source_kind='derived'; does NOT interrupt the fast loop.
 *
 * Slice 7 ships a deterministic STUB drift detector (slice 8 wires a
 * Decider-driven LLM pass; slice 11 wires the watchdog's needs-vs-
 * tools gap finder). The detector is pluggable via the `detect`
 * option so tests and later slices can swap it out.
 */

export interface DriftFinding {
  readonly kind: 'off_purpose' | 'off_character' | 'blind_spot' | 'no_drift';
  readonly summary: string;
  /** Optional evidence — trace cycles or memory ids that prompted the finding. */
  readonly evidence?: string;
}

export interface DriftReviewContext {
  readonly cycle: number;
  readonly at_ms: number;
}

export interface DriftDetectorInputs {
  readonly db: SqliteDb;
  readonly cycle: number;
  /** Recent N substrate/operator/job trace bodies (caller decides N). */
  readonly recentTrace: readonly { kind: string; body: string; cycle: number }[];
}

export type DriftDetector = (inputs: DriftDetectorInputs) => readonly DriftFinding[];

/**
 * Default detector — slice 7 stub. Flags:
 *   - A run of >= 10 consecutive cycles in which the substrate
 *     blocked the same law (potential off-purpose).
 *   - Otherwise: `no_drift`.
 *
 * Slice 8 replaces with a Decider-driven judgement; slice 11 adds
 * the watchdog's gap finder.
 */
export const defaultDetector: DriftDetector = ({ db, cycle, recentTrace }) => {
  const findings: DriftFinding[] = [];

  // Pillar 1 — repeated substrate blocks on the same law.
  const blocks = recentTrace
    .filter((t) => t.kind === 'substrate')
    .map((t) => {
      try {
        return JSON.parse(t.body) as { law?: string; outcome?: string };
      } catch {
        return null;
      }
    })
    .filter(
      (parsed): parsed is { law: string; outcome: string } =>
        parsed !== null && parsed.outcome === 'block',
    );

  if (blocks.length >= 10) {
    const counts = new Map<string, number>();
    for (const b of blocks) counts.set(b.law, (counts.get(b.law) ?? 0) + 1);
    const [topLaw, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    if (topCount >= 10) {
      findings.push({
        kind: 'off_purpose',
        summary: `${topCount} substrate blocks on law=${topLaw} in the recent window`,
        evidence: `law=${topLaw}`,
      });
    }
  }

  // Pillar 2 — watchdog gap finder (slice 11).
  const gaps = findGaps({ db, currentCycle: cycle });
  for (const g of gaps as readonly WatchdogFinding[]) {
    findings.push({ kind: 'blind_spot', summary: g.summary, evidence: g.evidence });
  }

  if (findings.length === 0) {
    findings.push({ kind: 'no_drift', summary: 'no drift detected this pass' });
  }
  return findings;
};

export interface DriftReviewResult {
  readonly findings: readonly DriftFinding[];
  /** IDs of semantic memories written as a result. */
  readonly correctionIds: readonly string[];
}

export function driftReview(
  db: SqliteDb,
  ctx: DriftReviewContext,
  detect: DriftDetector = defaultDetector,
): DriftReviewResult {
  // Pull a window of recent trace entries (last 200).
  const rows = db
    .prepare(
      `SELECT kind, body, cycle FROM trace ORDER BY id DESC LIMIT 200`,
    )
    .all() as Array<{ kind: string; body: string; cycle: number }>;

  const findings = detect({ db, cycle: ctx.cycle, recentTrace: rows.reverse() });
  const memory = new Memory(db);
  const correctionIds: string[] = [];

  for (const f of findings) {
    if (f.kind === 'no_drift') continue;
    const r = memory.write(
      'semantic',
      {
        body: `[drift:${f.kind}] ${f.summary}`,
        why: `slow-clock drift review @ cycle ${ctx.cycle}`,
        admissionTag: 'guidance',
        source_kind: 'derived',
        source_ref: f.evidence ?? null,
      },
      { cycle: ctx.cycle, at_ms: ctx.at_ms },
    );
    correctionIds.push(r.id);
  }
  return { findings, correctionIds };
}
