import type { ModelBackend } from '@runcor/engine';
import { Memory } from '@runcor/memory';
import { wrap } from '@runcor/substrate';

import type { Db } from './db.js';

/**
 * Three-clock memory (Item 1).
 *
 * The slow clock (re-plan / lesson-promotion) already exists as the
 * `@runcor/slowclock` worker. This adds the two faster, Claude-powered
 * clocks that keep working memory oriented:
 *
 *   - FAST (every cycle): rewrite the previous situation report + this
 *     cycle's outcome into a short "here is where we are" report. The
 *     next cycle's prompt reads THIS instead of re-deriving state from
 *     raw history — the fix for the v3 "forgot everything it did" drift.
 *   - MEDIUM (every N cycles): compact recent episodic memory into a
 *     tighter mid-horizon semantic record so working memory does not
 *     bloat between slow-clock consolidations.
 *
 * Both run inside the cycle's write phase (post-write inter-cycle work)
 * and therefore pause automatically when the lattice pauses (Item 9):
 * no cycle, no clock tick. Each is wrapped so a model hiccup can never
 * break the cycle.
 */

export const MEDIUM_CLOCK_EVERY = 20;

export function readSituation(db: Db): string | null {
  const row = db
    .prepare(`SELECT body FROM situation_current WHERE id = 'self'`)
    .get() as { body: string } | undefined;
  return row?.body ?? null;
}

function writeSituation(db: Db, body: string, cycle: number, at_ms: number): void {
  db.prepare(
    `INSERT INTO situation_current (id, body, updated_at_cycle, updated_at_ms)
     VALUES ('self', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       body = excluded.body,
       updated_at_cycle = excluded.updated_at_cycle,
       updated_at_ms = excluded.updated_at_ms`,
  ).run(body, cycle, at_ms);
}

export interface FastClockDeps {
  readonly db: Db;
  readonly engine: ModelBackend;
  readonly cycle: number;
  readonly at_ms: number;
  readonly identityComposed: string;
  /** A compact description of what happened this cycle (action/result/judgement). */
  readonly cycleOutcome: string;
  /** Recent raw context (used only to ground the rewrite). */
  readonly recentContext: string;
  readonly abortSignal: AbortSignal;
}

/** Fast clock — rewrite the running situation report. */
export async function runFastClock(deps: FastClockDeps): Promise<void> {
  const prev = readSituation(deps.db) ?? '(none yet)';
  const prompt = wrap({
    cycle: deps.cycle,
    at_ms: deps.at_ms,
    identityComposed: deps.identityComposed,
    realitySliceSummary: deps.recentContext ? `recent context:\n${deps.recentContext}` : '(no recent context)',
    instruction: [
      'You maintain a SHORT running situation report for yourself across cycles.',
      'Rewrite the PREVIOUS report plus the LATEST cycle outcome into at most 8 lines capturing:',
      'the current task/goal, what was just done, what is pending or blocked, and the next obvious step.',
      'Drop stale detail. Plain prose lines only — no markdown headings, no R++.',
      '',
      `PREVIOUS report:\n${prev}`,
      '',
      `LATEST cycle ${deps.cycle} outcome:\n${deps.cycleOutcome}`,
    ].join('\n'),
  });
  const res = await deps.engine.call({ prompt, modelHint: 'fast', maxTokens: 256, abortSignal: deps.abortSignal });
  const body = res.text.trim();
  if (body.length > 0) writeSituation(deps.db, body, deps.cycle, deps.at_ms);
}

export interface MediumClockDeps {
  readonly db: Db;
  readonly engine: ModelBackend;
  readonly cycle: number;
  readonly at_ms: number;
  readonly identityComposed: string;
  /** Recent episodic memory, newest last, to compact. */
  readonly recentEpisodic: string;
  readonly abortSignal: AbortSignal;
}

/** Medium clock — compact recent episodic memory into a mid-horizon semantic record. */
export async function runMediumClock(deps: MediumClockDeps): Promise<void> {
  if (!deps.recentEpisodic.trim()) return;
  const prompt = wrap({
    cycle: deps.cycle,
    at_ms: deps.at_ms,
    identityComposed: deps.identityComposed,
    realitySliceSummary: `recent episodic memory (newest last):\n${deps.recentEpisodic}`,
    instruction: [
      'Compact the recent episodic memory above into a tight mid-horizon summary, at most 12 lines.',
      'Keep durable facts, decisions, and lessons; drop transient per-cycle noise and exact timestamps.',
      'Plain prose lines only — no markdown headings, no R++.',
    ].join('\n'),
  });
  const res = await deps.engine.call({ prompt, modelHint: 'balanced', maxTokens: 400, abortSignal: deps.abortSignal });
  const body = res.text.trim();
  if (body.length > 0) {
    new Memory(deps.db).write(
      'semantic',
      { body, why: `medium-clock compaction at cycle ${deps.cycle}`, admissionTag: 'decision', source_kind: 'derived' },
      { cycle: deps.cycle, at_ms: deps.at_ms },
    );
  }
}
