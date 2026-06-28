import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

import { Memory } from '@runcor/memory';
import {
  findGaps,
  findOpenQuestions,
  WATCHDOG_KINDS,
  WATCHDOG_TIER3_KINDS,
  type WatchdogFinding,
  type WatchdogKind,
  type WatchdogOpenQuestion,
  type WatchdogSkipNote,
  type WatchdogTier3Kind,
} from '@runcor/watchdog';
import type { Database as SqliteDb } from 'better-sqlite3';

/**
 * Drift review (intent §7; spec FR-028).
 *
 * The slow-clock pass that judges whether the entity has wandered —
 * off-purpose, off-character, or blind to something it should have acted on.
 * Writes findings as semantic memories with source_kind='derived'; does NOT
 * interrupt the fast loop.
 *
 * Watchdog findings flow through a separate `memory_semantic` body +
 * `memory_semantic_correction` audit pair, keyed `rule='watchdog:<kind>'`
 * (three-tier watchdog Step 1). The ground.ts recall section reads that
 * audit table directly.
 *
 * Every watchdog kind MUST have an entry in `AGE_OUT_HANDLERS` — the typed
 * Record makes a missing arm a compile error. Tests additionally enforce it
 * at runtime so a refactor that loosens the types still fails loudly.
 *
 * No node:fs WRITE functions and no node:child_process anywhere in this
 * file. The static and runtime read-only invariant tests enforce both.
 */

export interface DriftFinding {
  readonly kind: 'off_purpose' | 'off_character' | 'blind_spot' | 'no_drift';
  readonly summary: string;
  /** Optional evidence — trace cycles or memory ids that prompted the finding. */
  readonly evidence?: string;
  /**
   * Present only when the finding originated in the watchdog (kind='blind_spot').
   * Carries the watchdog's own kind verbatim so the drift-review writer can route
   * the finding through the watchdog-correction shape (audit row keyed
   * `rule='watchdog:<watchdogKind>'`) and the recall selector can scope by that
   * rule prefix. Engine-generic: nothing here knows the harness or task.
   */
  readonly watchdogKind?: WatchdogKind;
}

export interface DriftReviewContext {
  readonly cycle: number;
  readonly at_ms: number;
  /**
   * Optional base directory for the watchdog's claim_vs_disk detector when it
   * encounters relative paths. Explicit, no implicit process.cwd() — silent
   * cwd-based resolution would mean different results depending on who
   * started the slow-clock. If unset, relative claimed paths are SKIPPED and
   * a benign trace note is written (never throws).
   */
  readonly pathRoot?: string;
}

export interface DriftDetectorInputs {
  readonly db: SqliteDb;
  readonly cycle: number;
  /** Recent N substrate/operator/job trace bodies (caller decides N). */
  readonly recentTrace: readonly { kind: string; body: string; cycle: number }[];
  readonly pathRoot?: string;
  readonly onSkip?: (note: WatchdogSkipNote) => void;
}

export type DriftDetector = (
  inputs: DriftDetectorInputs,
) => readonly DriftFinding[];

/**
 * Default detector. Two pillars today:
 *   - Pillar 1: repeated substrate blocks on the same law → off_purpose.
 *   - Pillar 2: watchdog findings (tool_unused, claim_vs_disk, …) →
 *     blind_spot with the watchdog's own kind carried verbatim.
 */
export const defaultDetector: DriftDetector = ({
  db,
  cycle,
  recentTrace,
  pathRoot,
  onSkip,
}) => {
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
    const [topLaw, topCount] = [...counts.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0]!;
    if (topCount >= 10) {
      findings.push({
        kind: 'off_purpose',
        summary: `${topCount} substrate blocks on law=${topLaw} in the recent window`,
        evidence: `law=${topLaw}`,
      });
    }
  }

  // Pillar 2 — watchdog detectors. The watchdog's own kind is preserved
  // verbatim so the writer can route to the correction-pair shape with
  // `rule='watchdog:<kind>'`.
  const gaps = findGaps({
    db,
    currentCycle: cycle,
    ...(pathRoot !== undefined ? { pathRoot } : {}),
    ...(onSkip !== undefined ? { onSkip } : {}),
  });
  for (const g of gaps as readonly WatchdogFinding[]) {
    findings.push({
      kind: 'blind_spot',
      summary: g.summary,
      evidence: g.evidence,
      watchdogKind: g.kind,
    });
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
  /** Skip-notes emitted by the watchdog during this pass (also written to trace). */
  readonly skipNotes: readonly WatchdogSkipNote[];
  /** Tier-3 surfaces written to drift_open_question this pass. */
  readonly openQuestions: readonly WatchdogOpenQuestion[];
  /** IDs of drift_open_question rows written this pass (deduped). */
  readonly openQuestionIds: readonly string[];
}

export function driftReview(
  db: SqliteDb,
  ctx: DriftReviewContext,
  detect: DriftDetector = defaultDetector,
): DriftReviewResult {
  // Step 1 of the three-tier watchdog: before detecting new divergences, AGE
  // OUT any unresolved watchdog corrections whose underlying object-divergence
  // has resolved. Audit row preserved (forensic history); only the
  // resolved_at_* fields flip. Bounded — only currently-unresolved
  // watchdog-rule rows are re-evaluated.
  ageOutWatchdogCorrections(db, ctx);

  // Pull a window of recent trace entries (last 200).
  const rows = db
    .prepare(`SELECT kind, body, cycle FROM trace ORDER BY id DESC LIMIT 200`)
    .all() as Array<{ kind: string; body: string; cycle: number }>;

  // Collect skip-notes the watchdog emits during this pass. The list is
  // written to the trace at the end as a single benign record. Never throws —
  // a bad path in one item must not crash the tick.
  const skipNotes: WatchdogSkipNote[] = [];
  const findings = detect({
    db,
    cycle: ctx.cycle,
    recentTrace: rows.reverse(),
    ...(ctx.pathRoot !== undefined ? { pathRoot: ctx.pathRoot } : {}),
    onSkip: (n) => skipNotes.push(n),
  });
  const memory = new Memory(db);
  const correctionIds: string[] = [];

  for (const f of findings) {
    if (f.kind === 'no_drift') continue;

    if (f.kind === 'blind_spot' && f.watchdogKind) {
      // Skip if an unresolved correction for the same rule + source_ref
      // already exists — avoid re-asserting the same gap on every pass before
      // it ages out. (The age-out pass above clears resolved rows; an
      // unresolved row matching means the lattice has already been told.)
      const dup = db
        .prepare<[string, string]>(
          `SELECT msc.id FROM memory_semantic_correction msc
           JOIN memory_semantic ms ON ms.id = msc.semantic_id
           WHERE msc.rule = ?
             AND ms.source_ref = ?
             AND msc.resolved_at_ms IS NULL
           LIMIT 1`,
        )
        .get(`watchdog:${f.watchdogKind}`, f.evidence ?? '') as
        | { id: string }
        | undefined;
      if (dup) {
        correctionIds.push(dup.id);
        continue;
      }

      const r = memory.write(
        'semantic',
        {
          body: `[watchdog:${f.watchdogKind}] ${f.summary}`,
          why: `watchdog: ${f.watchdogKind} @ cycle ${ctx.cycle}`,
          admissionTag: 'guidance',
          source_kind: 'derived',
          source_ref: f.evidence ?? null,
        },
        { cycle: ctx.cycle, at_ms: ctx.at_ms },
      );
      db.prepare<[string, string, number, string, string, string, number]>(
        `INSERT INTO memory_semantic_correction
           (id, semantic_id, cycle, was, now_is, rule, at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        r.id,
        ctx.cycle,
        wasShapeFor(f.watchdogKind),
        f.summary,
        `watchdog:${f.watchdogKind}`,
        ctx.at_ms,
      );
      correctionIds.push(r.id);
      continue;
    }

    // Non-watchdog drift findings (off_purpose, off_character) keep the
    // single-row semantic write. Out of scope for the three-tier watchdog;
    // they do not enter the recall selector (which filters rule LIKE
    // 'watchdog:%').
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

  // Persist the watchdog's skip-notes as a benign trace entry so the operator
  // can audit what was skipped without flooding the prompt. Single insert per
  // pass; no recall surface.
  if (skipNotes.length > 0) {
    db.prepare<[number, number, string]>(
      `INSERT INTO trace (cycle, at_ms, kind, body)
       VALUES (?, ?, 'operator', ?)`,
    ).run(
      ctx.cycle,
      ctx.at_ms,
      JSON.stringify({ action: 'watchdog_skipped', notes: skipNotes }),
    );
  }

  // Tier-3 surface path — strictly separate from the corrections write path
  // above. Open questions land ONLY in drift_open_question; this code DOES
  // NOT touch memory_semantic or memory_semantic_correction. The age-out is
  // resolution-keyed (a memory marker the lattice writes), not object-keyed.
  ageOutOpenQuestions(db, ctx);
  const { questions, ids: openQuestionIds } = surfaceOpenQuestions(db, ctx);

  return { findings, correctionIds, skipNotes, openQuestions: questions, openQuestionIds };
}

/* =========================== Tier-3 open-question path =========================== */

/**
 * Tier-3 write path — STRICTLY separate from the corrections path. Each
 * open question is INSERTed into drift_open_question (and only that table).
 * This function does NOT call memory.write, does NOT insert into
 * memory_semantic_correction, and never participates in the corrections
 * selector. The physical separation is enforced by the table schema (the
 * three position-text columns have NOT-NULL CHECKs of length > 0) and by
 * the corrections selector reading a different table.
 *
 * Dedup: an unresolved row with the same (kind, item_id, lattice_position,
 * watchdog_position) is treated as the same question; we don't re-write it.
 */
function surfaceOpenQuestions(
  db: SqliteDb,
  ctx: DriftReviewContext,
): { questions: readonly WatchdogOpenQuestion[]; ids: readonly string[] } {
  const questions = findOpenQuestions({ db });
  if (questions.length === 0) return { questions, ids: [] };

  // Dedup against ANY row with the same fingerprint — resolved or not.
  // Once the lattice has deliberated a question with this fingerprint, re-
  // emitting it on a later pass would be the watchdog re-raising a question
  // the lattice already decided. The lattice's resolution memory carries the
  // verdict forward; the watchdog stays out.
  const dupStmt = db.prepare<[string, string | null, string, string]>(
    `SELECT id FROM drift_open_question
     WHERE kind = ? AND COALESCE(item_id, '') = COALESCE(?, '')
       AND lattice_position = ? AND watchdog_position = ?
     LIMIT 1`,
  );
  const insertStmt = db.prepare<[
    string, string, number, number, string | null, string, string, string,
  ]>(
    `INSERT INTO drift_open_question
       (id, kind, cycle, at_ms, item_id, lattice_position, watchdog_position, no_object_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const ids: string[] = [];
  for (const q of questions) {
    const dup = dupStmt.get(
      q.kind,
      q.itemId,
      q.latticePosition,
      q.watchdogPosition,
    ) as { id: string } | undefined;
    if (dup) {
      ids.push(dup.id);
      continue;
    }
    const id = randomUUID();
    insertStmt.run(
      id,
      q.kind,
      ctx.cycle,
      ctx.at_ms,
      q.itemId,
      q.latticePosition,
      q.watchdogPosition,
      q.noObjectReason,
    );
    ids.push(id);
  }
  return { questions, ids };
}

/* ----- Tier-3 age-out: decision-keyed, NEVER object-keyed ----- */

type OpenQuestionRule = `tier3:${WatchdogTier3Kind}`;

interface OpenQuestionContext {
  readonly db: SqliteDb;
  readonly questionId: string;
}

interface OpenQuestionResolver {
  /**
   * Returns the memory_semantic.id that resolves this question, or null
   * if no resolution is recorded yet. Resolution is recorded by the
   * lattice writing a semantic memory whose body contains the substring
   * `resolves-question:<question_id>` — a minimal marker that requires
   * no new action type.
   */
  readonly resolvedBy: (ctx: OpenQuestionContext) => string | null;
}

/**
 * OPEN_QUESTION_AGE_OUT — a separate registry from AGE_OUT_HANDLERS. The
 * typed Record makes a Tier-3 kind without a resolver a COMPILE error
 * (mirror of the Tier-1/2 pattern). Critically, this registry uses a
 * DIFFERENT resolver shape than AGE_OUT_HANDLERS — it never checks a
 * filesystem object, only the lattice's recorded resolution. Reusing the
 * Tier-1/2 arms here would either nag forever (no file ever resolves a
 * question) or falsely age-out (a file matching by coincidence). The
 * distinct shape is the protection.
 */
export const OPEN_QUESTION_AGE_OUT: Record<OpenQuestionRule, OpenQuestionResolver> = {
  'tier3:frame_order': { resolvedBy: resolvedByLatticeMarker },
};

function resolvedByLatticeMarker(ctx: OpenQuestionContext): string | null {
  // Look for the marker `resolves-question:<question_id>` in any semantic
  // memory body. SQLite LIKE is binary-safe and the question_id is a UUID
  // (no LIKE wildcards), so we can scan directly.
  const marker = `resolves-question:${ctx.questionId}`;
  const row = ctx.db
    .prepare<[string]>(
      `SELECT id FROM memory_semantic WHERE body LIKE ? LIMIT 1`,
    )
    .get(`%${marker}%`) as { id: string } | undefined;
  return row?.id ?? null;
}

function ageOutOpenQuestions(db: SqliteDb, ctx: DriftReviewContext): void {
  const open = db
    .prepare<[]>(
      `SELECT id, kind FROM drift_open_question WHERE resolved_at_ms IS NULL`,
    )
    .all() as Array<{ id: string; kind: string }>;
  if (open.length === 0) return;

  const markResolved = db.prepare<[number, number, string, string]>(
    `UPDATE drift_open_question
        SET resolved_at_ms = ?, resolved_at_cycle = ?, resolved_by_memory_id = ?
      WHERE id = ?`,
  );

  for (const row of open) {
    const ruleKey = `tier3:${row.kind}` as OpenQuestionRule;
    const resolver = OPEN_QUESTION_AGE_OUT[ruleKey];
    if (!resolver) continue; // unknown kind — leave alone (safety net)
    const memoryId = resolver.resolvedBy({ db, questionId: row.id });
    if (memoryId) markResolved.run(ctx.at_ms, ctx.cycle, memoryId, row.id);
  }
}

// Re-export Tier-3 kinds so the guard test can import both
// WATCHDOG_TIER3_KINDS and OPEN_QUESTION_AGE_OUT from one module.
export { WATCHDOG_TIER3_KINDS };

/* =========================== watchdog correction shapes =========================== */

function wasShapeFor(kind: WatchdogKind): string {
  switch (kind) {
    case 'tool_unused':
    case 'stated_need_unmet':
      return 'stated need; no usage in window';
    case 'claim_vs_disk':
      return 'claim of artifact existence on disk';
    case 'gate_content_unmet':
      return 'gate spec required file content matching needle';
    case 'gate_minbytes_unmet':
      return 'gate spec required file size threshold';
  }
}

/* =========================== age-out dispatch table =========================== */

type AgeOutRule = `watchdog:${WatchdogKind}`;

interface AgeOutContext {
  readonly db: SqliteDb;
  readonly sourceRef: string | null;
  readonly cycle: number;
  readonly at_ms: number;
}

interface AgeOutHandler {
  /** Returns true iff the underlying object-divergence has resolved. */
  readonly isResolved: (ctx: AgeOutContext) => boolean;
}

/**
 * AGE_OUT_HANDLERS — the typed Record makes a missing arm a COMPILE error,
 * not just a runtime test failure. Adding a new WatchdogKind without an arm
 * here will not type-check, which means a half-done detector cannot be
 * shipped. The runtime guard test in age-out-handlers.test.ts is the
 * belt-and-braces co-check against a refactor that loosens the typing.
 */
export const AGE_OUT_HANDLERS: Record<AgeOutRule, AgeOutHandler> = {
  'watchdog:tool_unused': { isResolved: isResolvedByToolUsage },
  'watchdog:stated_need_unmet': { isResolved: isResolvedByToolUsage },
  'watchdog:claim_vs_disk': { isResolved: isResolvedByFileOnDisk },
  'watchdog:gate_content_unmet': { isResolved: isResolvedByContentMatch },
  'watchdog:gate_minbytes_unmet': { isResolved: isResolvedByMinBytes },
};

function isResolvedByToolUsage(ctx: AgeOutContext): boolean {
  const capMatch = /capability=([\w-]+)/.exec(ctx.sourceRef ?? '');
  const windowMatch = /window=(\d+)/.exec(ctx.sourceRef ?? '');
  if (!capMatch) return false;
  const capName = capMatch[1]!;
  const window = windowMatch ? Number(windowMatch[1]) : 100;
  const sinceCycle = Math.max(0, ctx.cycle - window);
  const usage = ctx.db
    .prepare<[number]>(
      `SELECT body FROM trace WHERE kind = 'phase' AND phase = 'act' AND cycle >= ?`,
    )
    .all(sinceCycle) as Array<{ body: string }>;
  return usage.some((u) => {
    try {
      const parsed = JSON.parse(u.body) as { output_summary?: string };
      const m = /action=([\w-]+)/.exec(parsed.output_summary ?? '');
      return m?.[1] === capName;
    } catch {
      return false;
    }
  });
}

function isResolvedByFileOnDisk(ctx: AgeOutContext): boolean {
  // source_ref shape: 'item_id=<uuid>; claimed_path=<path>; status=absent|empty'
  const m = /claimed_path=([^;]+)/.exec(ctx.sourceRef ?? '');
  if (!m) return false;
  const path = m[1]!.trim();
  if (!existsSync(path)) return false;
  try {
    const st = statSync(path);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * Age-out for gate_content_unmet — re-runs the same content_contains check
 * shape against the file's current bytes. Resolves when the needle is
 * satisfied. If the file has gone missing the check fails (claim_vs_disk
 * would then own the divergence on the next pass).
 *
 * source_ref shape:
 *   'item_id=<uuid>; gate_path=<path>; needle=<urlencoded>; isRegex=<bool>; status=not_matching'
 */
function isResolvedByContentMatch(ctx: AgeOutContext): boolean {
  const ref = ctx.sourceRef ?? '';
  const pathMatch = /gate_path=([^;]+)/.exec(ref);
  const needleMatch = /needle=([^;]+)/.exec(ref);
  const isRegexMatch = /isRegex=(true|false)/.exec(ref);
  if (!pathMatch || !needleMatch) return false;
  const path = pathMatch[1]!.trim();
  let needle: string;
  try {
    needle = decodeURIComponent(needleMatch[1]!.trim());
  } catch {
    return false;
  }
  const isRegex = isRegexMatch?.[1] === 'true';
  if (!existsSync(path)) return false;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  if (isRegex) {
    try {
      return new RegExp(needle, 'm').test(text);
    } catch {
      return false;
    }
  }
  return text.includes(needle);
}

/**
 * Age-out for gate_minbytes_unmet — resolves when the file now meets the
 * recorded byte threshold.
 *
 * source_ref shape:
 *   'item_id=<uuid>; gate_path=<path>; required_bytes=<N>; actual_bytes=<M>; status=undersize'
 */
function isResolvedByMinBytes(ctx: AgeOutContext): boolean {
  const ref = ctx.sourceRef ?? '';
  const pathMatch = /gate_path=([^;]+)/.exec(ref);
  const reqMatch = /required_bytes=(\d+)/.exec(ref);
  if (!pathMatch || !reqMatch) return false;
  const path = pathMatch[1]!.trim();
  const required = Number(reqMatch[1]);
  if (!existsSync(path)) return false;
  try {
    const st = statSync(path);
    return st.isFile() && st.size >= required;
  } catch {
    return false;
  }
}

function ageOutWatchdogCorrections(
  db: SqliteDb,
  ctx: DriftReviewContext,
): void {
  const open = db
    .prepare<[]>(
      `SELECT msc.id AS id, msc.rule AS rule, ms.source_ref AS source_ref
       FROM memory_semantic_correction msc
       JOIN memory_semantic ms ON ms.id = msc.semantic_id
       WHERE msc.rule LIKE 'watchdog:%' AND msc.resolved_at_ms IS NULL`,
    )
    .all() as Array<{ id: string; rule: string; source_ref: string | null }>;
  if (open.length === 0) return;

  const markResolved = db.prepare<[number, number, string]>(
    `UPDATE memory_semantic_correction
        SET resolved_at_ms = ?, resolved_at_cycle = ?
      WHERE id = ?`,
  );

  for (const row of open) {
    const handler = AGE_OUT_HANDLERS[row.rule as AgeOutRule];
    if (!handler) {
      // Unknown watchdog rule — leave alone. Better to keep a finding
      // surfaced than to silently age out something we don't know how to
      // verify. This branch is also the runtime safety net under a
      // not-yet-loaded refactor that loosens the typed Record.
      continue;
    }
    const resolved = handler.isResolved({
      db,
      sourceRef: row.source_ref,
      cycle: ctx.cycle,
      at_ms: ctx.at_ms,
    });
    if (resolved) markResolved.run(ctx.at_ms, ctx.cycle, row.id);
  }
}

// Re-export WATCHDOG_KINDS so the guard test can import both `WATCHDOG_KINDS`
// and `AGE_OUT_HANDLERS` from a single module. Keeps the assertion site
// untangled.
export { WATCHDOG_KINDS };
