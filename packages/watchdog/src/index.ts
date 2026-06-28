import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type { Database as SqliteDb } from 'better-sqlite3';

/**
 * Watchdog — read-only observer riding the slow clock.
 *
 * Catches divergences and routes them through the drift-review correction
 * channel (intent §12; spec US11). Every kind here is Tier 1 or Tier 2
 * (RULES — object-settleable). Tier 3 surfaces (open questions) live in a
 * separate physical table and a separate render path; they do NOT pass
 * through this module.
 *
 * Detectors today:
 *   - tool_unused        — Tier 1; a tool is available + stated as needed +
 *                          unused in the recent window.
 *   - claim_vs_disk      — Tier 1; a passed plan_item claims an artifact at
 *                          a path that is absent or empty on disk.
 *   - gate_content_unmet — Tier 2; a passed plan_item has a content_contains
 *                          gate whose needle is not satisfied by the file
 *                          NOW. The gate spec is the persistent re-readable
 *                          object; the file is the persistent re-readable
 *                          object. Both are state, not event.
 *   - gate_minbytes_unmet — Tier 2; a passed plan_item has a file_exists
 *                          gate with minBytes>0 whose size requirement is
 *                          not met NOW. Same state-vs-event reasoning.
 *
 * ### Tier-2 admission rule: STATE, not EVENT
 *
 * A watchdog detector can rule against a claim ONLY when the claim is
 * backed by a PERSISTENT, RE-READABLE OBJECT — a file's bytes, a file's
 * size, a row in a database table. These are STATES that exist NOW and
 * would still exist if read again next cycle.
 *
 * Claims backed by EVENT-RESULTS — an exit code from a past process, an
 * HTTP response, a one-time computation — are NOT in scope. Re-checking
 * an event requires re-creating it (executing the command, making the
 * request), which violates the observer line. And re-running an event at
 * cycle C2 says nothing about what the event returned at cycle C1; the
 * historical claim is unverifiable read-only.
 *
 * The single exception: if an event-result has been PERSISTED to a
 * re-readable object (e.g. a gate-state JSONL, a completion-check result
 * row), reading that persisted state IS in scope — the object exists now
 * and is re-readable. Whenever a new event-style gate appears, the test
 * for inclusion is: "does a persistent record of its result exist? If
 * yes, read it. If no, out of scope."
 *
 * This is the reusable principle for every future detector — not a
 * one-off exclusion of command_exits_zero / http_status_is.
 *
 * ### Observer line
 *
 * The watchdog is an observer, NEVER an actor:
 *   - no node:child_process anywhere (zero shell-exec of any flavour);
 *   - no write-flavour fs functions (the read-only-invariant test enforces
 *     a distinctive denylist; the runtime write-spy is the co-guard);
 *   - only read functions used (existsSync, statSync, readFileSync; all
 *     three are read-only).
 *
 * Every kind MUST have a matching age-out arm in
 * @runcor/slowclock's AGE_OUT_HANDLERS. The Record type there is keyed by
 * `watchdog:${WatchdogKind}` so a missing arm fails to typecheck. Shipping a
 * detector without its age-out arm is unrepresentable.
 */

export const WATCHDOG_KINDS = [
  'tool_unused',
  'stated_need_unmet',
  'claim_vs_disk',
  'gate_content_unmet',
  'gate_minbytes_unmet',
] as const;
export type WatchdogKind = (typeof WATCHDOG_KINDS)[number];

export interface WatchdogFinding {
  readonly kind: WatchdogKind;
  readonly summary: string;
  readonly evidence: string;
}

/**
 * Tier-3 surface kinds — strictly disjoint from WatchdogKind. Tier-3 is the
 * SURFACE path: each kind here emits a WatchdogOpenQuestion (TWO positions
 * + a no-object reason), never a WatchdogFinding (one factual assertion).
 * Tier-3 NEVER writes to the corrections channel; the slow-clock routes
 * these to a separate physical table (drift_open_question) and a separate
 * recall section under a distinct header. The split is structural, not
 * by-convention.
 *
 * Each Tier-3 kind MUST have a matching entry in OPEN_QUESTION_AGE_OUT
 * (in @runcor/slowclock). The Record type there is keyed by
 * `tier3:${WatchdogTier3Kind}` so a missing arm fails to typecheck.
 *
 * Detectors:
 *   - frame_order — the job's body declares an expected sequence; the
 *     lattice's produced order diverges at a nameable position. The
 *     watchdog surfaces the divergence; the dialectic decides whether
 *     the spec was right or the lattice's reordering was right.
 */
export const WATCHDOG_TIER3_KINDS = ['frame_order'] as const;
export type WatchdogTier3Kind = (typeof WATCHDOG_TIER3_KINDS)[number];

/**
 * A Tier-3 surface row. The three text columns are mandatory and the
 * downstream schema (drift_open_question) enforces NOT-NULL CHECKs of
 * length > 0 — a row carrying only one position is structurally
 * unwritable, which is the safety property.
 */
export interface WatchdogOpenQuestion {
  readonly kind: WatchdogTier3Kind;
  readonly itemId: string | null;
  /** The lattice's existing claim, verbatim or as a direct quote. */
  readonly latticePosition: string;
  /** The watchdog's structural observation that contradicts at a named point. */
  readonly watchdogPosition: string;
  /** Why no external object adjudicates — required, never empty. */
  readonly noObjectReason: string;
}

/**
 * A skip-note — emitted when the watchdog encounters something it cannot
 * adjudicate (e.g. a relative claimed path with no pathRoot configured, a
 * file that exists but cannot be read). The slow-clock writes these to the
 * trace as a benign record. The watchdog NEVER throws on a single-item
 * input problem — a bad path or unreadable file must not crash the
 * slow-clock tick.
 *
 * `unreadable_file` is deliberately a SKIP, not a fail. "I couldn't read
 * it" is not "the gate failed." Telling the lattice a gate failed because
 * the watchdog can't read the file would write a false correction the
 * lattice reads as fact — the same dissent-suppression failure mode the
 * tier-1 false-positive in Step 2 was tightened to prevent.
 */
export interface WatchdogSkipNote {
  readonly reason:
    | 'relative_path_no_root'
    | 'malformed_completion_check'
    | 'unreadable_file';
  readonly detail: string;
}

export interface WatchdogInputs {
  readonly db: SqliteDb;
  readonly windowCycles?: number;
  readonly currentCycle: number;
  /**
   * Base directory for resolving relative claim paths in claim_vs_disk.
   * Explicit, no implicit process.cwd() — the resolution would silently
   * differ depending on who started the slow-clock. If unset, relative
   * claimed paths are SKIPPED (a SkipNote is emitted via `onSkip`).
   * Absolute claimed paths are checked regardless.
   */
  readonly pathRoot?: string;
  readonly onSkip?: (note: WatchdogSkipNote) => void;
}

/**
 * findGaps — runs every enabled detector and returns the union of findings.
 * Read-only. Filesystem use is restricted to existsSync + statSync +
 * readFileSync (all read functions).
 */
export function findGaps(inputs: WatchdogInputs): readonly WatchdogFinding[] {
  const out: WatchdogFinding[] = [];
  out.push(...detectToolUnused(inputs));
  out.push(...detectClaimVsDisk(inputs));
  out.push(...detectGateClaimVsScript(inputs));
  return out;
}

/* =============================== tool_unused =============================== */

function detectToolUnused(inputs: WatchdogInputs): readonly WatchdogFinding[] {
  const { db, currentCycle } = inputs;
  const window = inputs.windowCycles ?? 100;
  const sinceCycle = Math.max(0, currentCycle - window);

  const caps = db
    .prepare<[]>(
      `SELECT name FROM capability WHERE enabled = 1 AND role_action = 1`,
    )
    .all() as Array<{ name: string }>;
  if (caps.length === 0) return [];

  const goalBodies = db
    .prepare<[]>(`SELECT body FROM goal WHERE state IN ('proposed','active')`)
    .all() as Array<{ body: string }>;
  const itemBodies = db
    .prepare<[]>(
      `SELECT description AS body FROM plan_item WHERE state IN ('open','deferred')`,
    )
    .all() as Array<{ body: string }>;
  const stated = [...goalBodies, ...itemBodies].map((r) => r.body);

  const usageRows = db
    .prepare<[number]>(
      `SELECT body FROM trace WHERE kind = 'phase' AND phase = 'act' AND cycle >= ?`,
    )
    .all(sinceCycle) as Array<{ body: string }>;
  const usedNames = new Set<string>();
  for (const r of usageRows) {
    try {
      const parsed = JSON.parse(r.body) as { output_summary?: string };
      if (parsed.output_summary) {
        const m = /action=([\w-]+)/.exec(parsed.output_summary);
        if (m) usedNames.add(m[1]!);
      }
    } catch {
      /* skip malformed entries */
    }
  }

  const findings: WatchdogFinding[] = [];
  for (const cap of caps) {
    const mentioned = stated.some((b) =>
      b.toLowerCase().includes(cap.name.toLowerCase()),
    );
    if (mentioned && !usedNames.has(cap.name)) {
      findings.push({
        kind: 'tool_unused',
        summary: `tool "${cap.name}" appears in stated need but has not been used in last ${window} cycles`,
        evidence: `capability=${cap.name}; window=${window}`,
      });
    }
  }
  return findings;
}

/* ============================== claim_vs_disk ============================== */

/**
 * Tier-1 detector — a passed plan_item claims a deliverable file that is
 * absent or empty on disk. Binary; existence-only. No kind/format inspection
 * (that's a Tier-3-or-later detector).
 *
 * Sources of the claim:
 *   1. STRUCTURED — `completion_check` JSON; any hook's `args.path`.
 *   2. FREE-TEXT — `description`, via a CONSERVATIVE regex requiring at
 *      least one '/', an extension, and no URL prefix. Misses are
 *      preferred to false positives because a false positive writes a
 *      "correction" the lattice reads as fact, corroding the channel.
 *
 * Scope: `plan_item.state='passed'` only. Memory-body claim extraction is
 * deferred — too much surface for too much ambiguity (a memory body can
 * easily mention a path without claiming it exists).
 */
function detectClaimVsDisk(inputs: WatchdogInputs): readonly WatchdogFinding[] {
  const { db, pathRoot, onSkip } = inputs;

  const items = db
    .prepare<[]>(
      `SELECT id, description, completion_check FROM plan_item WHERE state = 'passed'`,
    )
    .all() as Array<{ id: string; description: string; completion_check: string }>;

  const findings: WatchdogFinding[] = [];
  for (const item of items) {
    const claimed = collectClaimedPaths(item, pathRoot, onSkip);
    for (const path of claimed) {
      const status = checkPathStatus(path);
      if (status === 'ok') continue;
      findings.push({
        kind: 'claim_vs_disk',
        summary: `plan_item ${item.id} claimed "${path}" but the file is ${status}`,
        evidence: `item_id=${item.id}; claimed_path=${path}; status=${status}`,
      });
    }
  }
  return findings;
}

/**
 * Path-token regex — extracts candidate file paths from prose.
 *   - At least one '.' followed by 1-8 word chars (file extension)
 *   - Word boundary after the extension
 *   - Character class restricted to [A-Za-z0-9_./-] (no spaces, no backslash;
 *     Windows backslash paths are out of v1 scope)
 *
 * Candidates are then filtered: must contain '/', must not follow '://'.
 */
const PATH_TOKEN_REGEX = /[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8}\b/g;

/**
 * Creation-verb gate for the free-text extractor.
 *
 * Calibrated against run-1: the description-free-text source caught two real
 * checklist-plan misses ("…write a checklist plan to <path>") AND one false
 * positive on a tool-invocation mention ("Run node <path>"). The false
 * positive demonstrated that "path appears in description" does NOT equal
 * "lattice claimed this artifact." A creation verb followed by a locative is
 * the structural signal that distinguishes a CLAIM ("wrote X to Y") from a
 * REFERENCE ("Run X" / "see Y" / "check Z").
 *
 * Conservative by design: a description that produces a deliverable without
 * using one of these verbs is a MISS, not a false positive. Misses are
 * recoverable (run-time mismatch shows up elsewhere); false positives
 * corrode the correction channel by telling the lattice a thing is wrong
 * when it isn't. The user-confirmed rule: prefer misses over false
 * positives, especially on a Tier-1 detector.
 *
 * Verbs included: write/wrote/writing, produce(d)(ing), save(d)(ing),
 * create(d)(ing), output, append(ed)(ing), add(ed)(ing), land(ed)(ing),
 * place(d)(ing), deliver(ed)(ing).
 * Locatives: to, at, into, in.
 */
const CREATION_VERB_LOCATIVE = /\b(write|wrote|writing|produce|produced|producing|save|saved|saving|create|created|creating|output|outputting|append|appended|appending|add|added|adding|land|landed|landing|place|placed|placing|deliver|delivered|delivering)\b[\s\S]{0,120}?\b(to|at|into|in)\s+$/i;

function collectClaimedPaths(
  item: { id: string; description: string; completion_check: string },
  pathRoot: string | undefined,
  onSkip: ((n: WatchdogSkipNote) => void) | undefined,
): readonly string[] {
  const out = new Set<string>();

  // 1) Structured: completion_check JSON
  try {
    const cc = JSON.parse(item.completion_check) as {
      hooks?: ReadonlyArray<{ args?: { path?: unknown } }>;
    };
    for (const h of cc?.hooks ?? []) {
      const p = h?.args?.path;
      if (typeof p === 'string' && p.length > 0) {
        const r = resolveClaimedPath(p, pathRoot, onSkip);
        if (r) out.add(r);
      }
    }
  } catch {
    onSkip?.({
      reason: 'malformed_completion_check',
      detail: `plan_item ${item.id}: completion_check is not valid JSON; structured extraction skipped`,
    });
  }

  // 2) Free-text: description (conservative)
  if (typeof item.description === 'string') {
    for (const m of item.description.matchAll(PATH_TOKEN_REGEX)) {
      const candidate = m[0];
      const idx = m.index ?? 0;
      // URL exclusion: when the candidate begins with a slash, the regex may
      // have started AT the first '/' of '://' (consuming the '//' itself),
      // so the chars before are just "scheme:" — not "://". Detect the URL
      // scheme pattern in a 10-char lookback. Catches http://, https://,
      // ftp://, file://, ws://, wss://, etc.
      const lookback10 = item.description.slice(Math.max(0, idx - 10), idx);
      if (/[a-z][a-z0-9+.\-]*:$/i.test(lookback10)) continue;
      // Defence-in-depth: also catch the case where the candidate begins
      // partway into the URL (after the '://').
      if (item.description.slice(Math.max(0, idx - 3), idx).endsWith('://')) {
        continue;
      }
      // Must contain at least one slash (conservative — single-token filenames
      // are too ambiguous to count as a claim).
      if (!candidate.includes('/')) continue;
      // CREATION-VERB GATE — calibrated against run-1 (see comment on
      // CREATION_VERB_LOCATIVE). The text immediately before the path must
      // match "<creation-verb> … <locative>". Without that, this is a
      // reference (e.g. "Run node <path>"), not a claim. Misses preferred to
      // false positives.
      const lookbackVerb = item.description.slice(Math.max(0, idx - 200), idx);
      if (!CREATION_VERB_LOCATIVE.test(lookbackVerb)) continue;
      const r = resolveClaimedPath(candidate, pathRoot, onSkip);
      if (r) out.add(r);
    }
  }

  return [...out];
}

function resolveClaimedPath(
  p: string,
  pathRoot: string | undefined,
  onSkip: ((n: WatchdogSkipNote) => void) | undefined,
): string | null {
  if (isAbsolute(p)) return p;
  if (pathRoot) return resolve(pathRoot, p);
  onSkip?.({
    reason: 'relative_path_no_root',
    detail: `skipped relative path "${p}" — no pathRoot configured`,
  });
  return null;
}

function checkPathStatus(p: string): 'absent' | 'empty' | 'ok' {
  if (!existsSync(p)) return 'absent';
  try {
    const st = statSync(p);
    if (!st.isFile()) return 'absent';
    return st.size > 0 ? 'ok' : 'empty';
  } catch {
    return 'absent';
  }
}

/* ========================== gate_claim_vs_script ========================== */

/**
 * Tier-2 detectors — read the gate SPEC (the hook config in
 * completion_check) and check whether the gate would pass NOW against the
 * persistent object it gates on. Both the spec and the object are STATES
 * that exist now and are re-readable; this is the admission rule for any
 * Tier-2 detector (see file header for the STATE-vs-EVENT principle).
 *
 * Two sub-detectors v1:
 *   - gate_content_unmet: content_contains hook whose needle is not
 *     satisfied by the file's current bytes.
 *   - gate_minbytes_unmet: file_exists hook with minBytes>0 whose size
 *     requirement the file does not meet now.
 *
 * No-double-emit guard: a MISSING or EMPTY file is one divergence,
 * already owned by claim_vs_disk (Tier 1). Tier 2 only fires when the
 * file EXISTS WITH CONTENT but the gate's specific requirement is unmet.
 * That keeps one underlying problem from generating two corrections.
 *
 * Event-style gates (command_exits_zero, http_status_is) are deliberately
 * NOT here — re-checking them would require executing the event, and
 * re-running an event at cycle C2 says nothing about what happened at
 * cycle C1. If a persisted last-run-exit record is added in the future,
 * a reader-style detector can be added.
 */
function detectGateClaimVsScript(
  inputs: WatchdogInputs,
): readonly WatchdogFinding[] {
  const { db, pathRoot, onSkip } = inputs;
  const items = db
    .prepare<[]>(
      `SELECT id, completion_check FROM plan_item WHERE state = 'passed'`,
    )
    .all() as Array<{ id: string; completion_check: string }>;

  const findings: WatchdogFinding[] = [];

  for (const item of items) {
    let cc: { hooks?: ReadonlyArray<{ name?: unknown; args?: Record<string, unknown> }> };
    try {
      cc = JSON.parse(item.completion_check) as typeof cc;
    } catch {
      // Already noted by claim_vs_disk's extractor; don't double-note.
      continue;
    }
    for (const h of cc?.hooks ?? []) {
      if (h?.name === 'content_contains') {
        const finding = checkContentContainsGate(
          item.id,
          h.args ?? {},
          pathRoot,
          onSkip,
        );
        if (finding) findings.push(finding);
      } else if (h?.name === 'file_exists') {
        const finding = checkFileExistsMinBytesGate(
          item.id,
          h.args ?? {},
          pathRoot,
          onSkip,
        );
        if (finding) findings.push(finding);
      }
      // command_exits_zero / http_status_is / step_acknowledged are
      // event-style or no-object — out of scope (see file header).
    }
  }

  return findings;
}

/**
 * Re-applies the content_contains hook's check shape verbatim — the same
 * String.includes vs RegExp.test branch the live gate uses — so the
 * watchdog's verdict matches exactly what the gate itself would return.
 */
function checkContentContainsGate(
  itemId: string,
  args: Record<string, unknown>,
  pathRoot: string | undefined,
  onSkip: ((n: WatchdogSkipNote) => void) | undefined,
): WatchdogFinding | null {
  const rawPath = typeof args.path === 'string' ? args.path : '';
  const needle = typeof args.needle === 'string' ? args.needle : '';
  // Hook spec invalid → not our problem to rule on.
  if (!rawPath || !needle) return null;
  const isRegex = args.isRegex === true;

  const resolved = resolveClaimedPath(rawPath, pathRoot, onSkip);
  if (!resolved) return null; // skip-note already emitted

  // Absent or empty → claim_vs_disk territory. No-double-emit.
  const status = checkPathStatus(resolved);
  if (status !== 'ok') return null;

  let text: string;
  try {
    text = readFileSync(resolved, 'utf8');
  } catch (err) {
    // "I couldn't read it" is not "the gate failed" — skip-and-note.
    onSkip?.({
      reason: 'unreadable_file',
      detail: `plan_item ${itemId}: file ${resolved} exists but could not be read (${err instanceof Error ? err.message : String(err)})`,
    });
    return null;
  }

  const matches = isRegex
    ? safeRegexTest(needle, text)
    : text.includes(needle);
  // Regex compile error → we can't rule. Skip silently — invalid spec is
  // the lattice's problem to surface; the watchdog doesn't ventriloquize.
  if (matches === null) return null;
  if (matches) return null;

  const needleSummary = needle.length > 60 ? `${needle.slice(0, 57)}…` : needle;
  return {
    kind: 'gate_content_unmet',
    summary: `plan_item ${itemId} is passed but content_contains gate at "${resolved}" no longer ${isRegex ? 'matches' : 'contains'} needle "${needleSummary}"`,
    evidence: `item_id=${itemId}; gate_path=${resolved}; needle=${encodeURIComponent(needle)}; isRegex=${isRegex}; status=not_matching`,
  };
}

/**
 * Re-checks the minBytes requirement of a file_exists hook. ONLY fires
 * when the file exists with content and is under the threshold — absent
 * and empty cases belong to claim_vs_disk.
 */
function checkFileExistsMinBytesGate(
  itemId: string,
  args: Record<string, unknown>,
  pathRoot: string | undefined,
  onSkip: ((n: WatchdogSkipNote) => void) | undefined,
): WatchdogFinding | null {
  const rawPath = typeof args.path === 'string' ? args.path : '';
  const minBytes = typeof args.minBytes === 'number' ? args.minBytes : 0;
  // No minBytes requirement → nothing for Tier-2 to evaluate.
  if (!rawPath || minBytes <= 0) return null;

  const resolved = resolveClaimedPath(rawPath, pathRoot, onSkip);
  if (!resolved) return null;

  // Absent / empty / not-a-file → claim_vs_disk territory. No-double-emit.
  if (checkPathStatus(resolved) !== 'ok') return null;

  let actualBytes: number;
  try {
    actualBytes = statSync(resolved).size;
  } catch {
    return null;
  }
  if (actualBytes >= minBytes) return null;

  return {
    kind: 'gate_minbytes_unmet',
    summary: `plan_item ${itemId} is passed but file_exists gate at "${resolved}" requires >=${minBytes} bytes; file is ${actualBytes} bytes`,
    evidence: `item_id=${itemId}; gate_path=${resolved}; required_bytes=${minBytes}; actual_bytes=${actualBytes}; status=undersize`,
  };
}

/**
 * Compiles a needle as a regex (single-line, multi-line flag) and returns
 * the match result, or null on compile failure. Matches the live hook's
 * `new RegExp(needle, 'm').test(text)` exactly.
 */
function safeRegexTest(needle: string, text: string): boolean | null {
  try {
    return new RegExp(needle, 'm').test(text);
  } catch {
    return null;
  }
}

/* ============================== Tier-3 surface ============================== */

export interface OpenQuestionInputs {
  readonly db: SqliteDb;
}

/**
 * findOpenQuestions — the Tier-3 surface detector.
 *
 * Each call evaluates each active job for the frame_order check:
 *   1. Parse expected sequence from the job body using THREE strict
 *      engine-generic parsers (numbered list, arrow chain, "Step N:"
 *      prefix). If no parser yields a clean ≥2-item sequence, emit
 *      nothing for that job.
 *   2. Derive produced sequence from passed plan_items (excluding
 *      source='plan_step' administrative scaffolding).
 *   3. Walk both sequences side by side; at each position, treat them
 *      as matching if their normalised tokens share ≥1 significant
 *      element. If they're disjoint, emit ONE surface for the FIRST
 *      such divergence.
 *
 * The detector NEVER rules. It surfaces a divergence with both
 * positions quoted verbatim and the explicit "no authoritative object"
 * note. The lattice's dialectic resolves whether the spec was right or
 * the lattice's reordering was right.
 *
 * Read-only. Touches only plan_job and plan_item.
 */
export function findOpenQuestions(
  inputs: OpenQuestionInputs,
): readonly WatchdogOpenQuestion[] {
  const out: WatchdogOpenQuestion[] = [];
  out.push(...detectFrameOrder(inputs));
  return out;
}

function detectFrameOrder(inputs: OpenQuestionInputs): WatchdogOpenQuestion[] {
  const { db } = inputs;
  const jobs = db
    .prepare<[]>(`SELECT id, title, body FROM plan_job WHERE status = 'open'`)
    .all() as Array<{ id: string; title: string; body: string }>;

  const out: WatchdogOpenQuestion[] = [];
  for (const job of jobs) {
    if (!job.body || job.body.trim().length === 0) continue;
    const expected = parseExpectedSequence(job.body);
    if (expected.length < 2) continue;

    const produced = db
      .prepare<[string]>(
        `SELECT id, description, passed_at_cycle
         FROM plan_item
         WHERE job_id = ? AND state = 'passed' AND source != 'plan_step'
         ORDER BY passed_at_cycle ASC, ordinal ASC`,
      )
      .all(job.id) as Array<{
      id: string;
      description: string;
      passed_at_cycle: number;
    }>;
    if (produced.length === 0) continue;

    const divergence = firstDivergence(expected, produced);
    if (!divergence) continue;

    const expectedTrunc = truncateLabel(divergence.expectedLabel, 120);
    const producedTrunc = truncateLabel(divergence.producedLabel, 120);
    const positionNumber = divergence.index + 1; // human-readable: 1-based

    out.push({
      kind: 'frame_order',
      itemId: divergence.producedItemId,
      latticePosition: `produced "${producedTrunc}" at position ${positionNumber} (chronological closure order in job "${job.title}")`,
      watchdogPosition: `job body declared expected order with "${expectedTrunc}" at position ${positionNumber}; produced order diverges here`,
      noObjectReason:
        'the expected sequence comes from the job\'s stated body; the produced sequence comes from actual closures. No external object adjudicates whether the lattice\'s order was correct or the spec\'s order should have held — the lattice\'s dialectic decides.',
    });
  }

  return out;
}

/* ---------- Sequence parsing (three strict engine-generic parsers) ---------- */

/**
 * Parse the longest clean expected sequence out of a job body. Tries three
 * parsers and takes the longest result. Each parser is conservative:
 *
 *   - Numbered list: consecutive lines `^N. text` with N = 1, 2, 3, …
 *   - "Step N:"   : consecutive lines `^Step N[:.] text` with N = 1, 2, 3, …
 *   - Arrow chain: a single line `A -> B -> C` (or `A → B → C`) with ≥3 tokens
 *
 * No domain words, no fuzzy matching, no partial sequences. If a parser
 * does not produce a clean sequential numbering starting at 1, it returns
 * empty. Engine-generic.
 */
function parseExpectedSequence(body: string): readonly string[] {
  const candidates = [
    parseNumberedList(body),
    parseStepPrefixList(body),
    parseArrowChain(body),
  ];
  let best: readonly string[] = [];
  for (const c of candidates) {
    if (c.length >= 2 && c.length > best.length) best = c;
  }
  return best;
}

/** Parser 1: `^\s*(\d+)[.)]\s+<text>` with sequential numbering 1, 2, 3, … */
function parseNumberedList(body: string): readonly string[] {
  const re = /^\s*(\d+)[.)]\s+(.+?)\s*$/gm;
  return parseSequentialList(body, re);
}

/** Parser 2: `^\s*Step\s+(\d+)\s*[:.]\s*<text>` with sequential numbering 1, 2, 3, … */
function parseStepPrefixList(body: string): readonly string[] {
  const re = /^\s*step\s+(\d+)\s*[:.]\s*(.+?)\s*$/gim;
  return parseSequentialList(body, re);
}

/**
 * Shared parser: find the longest CONTIGUOUS run of matches whose numbers
 * are exactly 1, 2, 3, …. A break in sequence ends the run; later runs are
 * considered but only one is returned (the longest).
 */
function parseSequentialList(body: string, re: RegExp): readonly string[] {
  const matches: Array<{ n: number; label: string }> = [];
  for (const m of body.matchAll(re)) {
    const n = Number(m[1]);
    const label = (m[2] ?? '').trim();
    if (Number.isFinite(n) && label.length > 0) matches.push({ n, label });
  }
  if (matches.length < 2) return [];

  let best: string[] = [];
  let current: string[] = [];
  let expected = 1;
  for (const m of matches) {
    if (m.n === expected) {
      current.push(m.label);
      expected += 1;
    } else if (m.n === 1) {
      if (current.length > best.length) best = current;
      current = [m.label];
      expected = 2;
    } else {
      if (current.length > best.length) best = current;
      current = [];
      expected = 1;
    }
  }
  if (current.length > best.length) best = current;
  return best.length >= 2 ? best : [];
}

/**
 * Parser 3: a single line containing `A -> B -> C` or `A → B → C` with ≥3
 * tokens separated by arrows.
 *
 * Calibrated against run-1: a line like
 *   `- **Review frameworks:** /blueteam (defensive → .ai/reports/), /redteam …`
 * uses `→` as a "writes-to" annotation inside a comma-separated parenthetical
 * list — NOT as a pipeline declaration. Splitting on `→` produces fragments
 * with commas and unbalanced parens. To stay engine-generic AND conservative,
 * reject any candidate where:
 *   (a) the line starts with a Markdown bullet marker (`-`, `*`, or `>`) —
 *       bulleted prose is description, not a pipeline declaration;
 *   (b) any fragment contains a comma — pipeline tokens are clean labels;
 *   (c) any fragment contains unbalanced parens — fragmented prose, not labels.
 * Misses preferred to false positives, per the Tier-3 surfacing bar.
 */
function parseArrowChain(body: string): readonly string[] {
  const ARROW = /\s*(?:->|→)\s*/;
  const BULLET_PREFIX = /^[-*>]\s/;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!/->|→/.test(line)) continue;
    if (BULLET_PREFIX.test(line)) continue;
    const parts = line
      .split(ARROW)
      .map((p) => p.replace(/[.,;:!?]+$/, '').trim())
      .filter((p) => p.length > 0);
    if (parts.length < 3) continue;
    // Reject if any fragment looks like running prose (commas / unbalanced parens).
    let dirty = false;
    for (const p of parts) {
      if (p.includes(',')) {
        dirty = true;
        break;
      }
      const opens = (p.match(/\(/g) ?? []).length;
      const closes = (p.match(/\)/g) ?? []).length;
      if (opens !== closes) {
        dirty = true;
        break;
      }
    }
    if (dirty) continue;
    return parts;
  }
  return [];
}

/* ---------- First-divergence detection (token-overlap match) ---------- */

const STOPWORDS = new Set([
  'the', 'and', 'with', 'from', 'into', 'this', 'that', 'for', 'are', 'was',
  'were', 'has', 'have', 'had', 'not', 'but', 'all', 'any', 'one', 'two',
]);

function tokens(label: string): Set<string> {
  const out = new Set<string>();
  for (const raw of label.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function tokensShare(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

interface Divergence {
  readonly index: number;
  readonly expectedLabel: string;
  readonly producedLabel: string;
  readonly producedItemId: string;
}

function firstDivergence(
  expected: readonly string[],
  produced: ReadonlyArray<{ id: string; description: string }>,
): Divergence | null {
  const lim = Math.min(expected.length, produced.length);
  for (let i = 0; i < lim; i++) {
    const expTokens = tokens(expected[i]!);
    const prodTokens = tokens(produced[i]!.description);
    // Either label being token-empty (e.g. all stopwords) → cannot rule;
    // treat as match to stay conservative (no surface).
    if (expTokens.size === 0 || prodTokens.size === 0) continue;
    if (tokensShare(expTokens, prodTokens)) continue;
    return {
      index: i,
      expectedLabel: expected[i]!,
      producedLabel: produced[i]!.description,
      producedItemId: produced[i]!.id,
    };
  }
  // Length differences are NOT divergences:
  //   - produced shorter than expected → incomplete progress, not disagreement
  //   - produced longer than expected → additions beyond spec, not disagreement
  return null;
}

function truncateLabel(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}
