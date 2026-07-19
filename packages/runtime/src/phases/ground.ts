import type { Capability } from '@runcor/capabilities';
import { wrap } from '@runcor/substrate';

import { NO_PROGRESS_THRESHOLD, readNoProgressCycles } from '../no-progress.js';
import { renderOpenQuestions } from '../open-questions.js';
import type { RuntimeMemoryAdapter } from '../sqlite-memory.js';
import { renderWatchdogCorrections } from '../watchdog-corrections.js';
import type {
  CycleContext,
  GroundOutput,
  MemoryWrite,
  RecallOutput,
  TasksView,
} from '../types.js';

/**
 * Per-memory-entry byte cap for the recent-actions display.
 *
 * Historical sizing note: run-3 evidence showed an 8-entry window catches
 * consecutive repetition but loses context older than ~80s, leading the
 * lattice to redo work that happened 10-20 cycles ago (re-read
 * package.json on cycles 2/11/20, dir src on 12/22, etc.). Prior code
 * displayed up to 24 entries via `recentEpisodic(24)`. FIX-008 removed
 * that separate query in favor of `prev.memories` (currently 8 entries
 * from `recall.reinforceRecalled(8)`), so the LLM sees exactly what
 * the substrate's Memory-law audits. To restore the wider window,
 * bump the reinforce limit in phases/recall.ts.
 */
const RECENT_ACTION_MAX_BYTES = 280;

/**
 * Caps for the watchdog-corrections recall section (three-tier watchdog Step 1).
 *
 * TODO(dial): make these dial-able via the operator review-cadence dial when
 * the re-run shows whether 6/1500 is too few (corrections dropped before the
 * lattice acts) or too many (drowning the prompt budget). Hardcoded for v1 to
 * keep the recall wire focused — turning these into true dials adds a dial
 * schema entry + a per-cycle read path, which is more than a few lines.
 */
const WATCHDOG_CORRECTIONS_LIMIT = 6;
const WATCHDOG_CORRECTIONS_BYTE_BUDGET = 1500;

/**
 * Caps for the Tier-3 open-questions recall section (Step 4).
 *
 * Denser per row than corrections — each row renders four lines (header
 * + lattice position + watchdog position + no-object reason). Tighter
 * count cap to keep the per-cycle prompt bounded; equal byte budget
 * because each entry is structurally longer. TODO(dial): same dial-ability
 * note as corrections.
 */
const OPEN_QUESTIONS_LIMIT = 4;
const OPEN_QUESTIONS_BYTE_BUDGET = 1500;

/**
 * Caps for surfacing sensed DATA in the reality slice (not just status). Per-sense
 * bounds any one sense; total bounds the whole senses block so a many-sense lattice
 * cannot blow the context window. 4 KB/sense × up to 16 KB total.
 */
const PER_SENSE_DATA_CAP = 4096;
const TOTAL_SENSE_DATA_CAP = 16384;

/**
 * ground — substrate-wrap the cycle's prompt (slice 5).
 *
 * Per constitution Principle VIII + spec FR-018: every model call's
 * prompt is wrapped by the substrate; the eleven laws compile to the
 * TOP of the prompt; the entity cannot suppress or reorder them.
 *
 * The wrap takes:
 *   - the cycle's perception summary (reality slice)
 *   - the lattice's composed identity prior
 *   - the cycle's instruction
 * and returns an RppPrompt — a branded string type the engine
 * accepts. Callers MUST pass this prompt unchanged to engine.call().
 */
export async function ground(
  ctx: CycleContext,
  prev: RecallOutput,
): Promise<GroundOutput> {
  // Surface the sensed DATA (capped), not just the 'ok'/'failed' status — without
  // this the entity is blind to its own corpus (a digest sense's content, a listing).
  // Hard caps keep many-sense lattices from blowing the context window.
  let senseDataBudget = TOTAL_SENSE_DATA_CAP;
  const senseSummary = Object.values(prev.perception.senses)
    .map((r) => {
      const head = `- ${r.capability}: ${r.result}`;
      if (r.result === 'failed' || senseDataBudget <= 0) return head;
      let d = renderSenseData(r.data);
      if (!d) return head;
      if (d.length > PER_SENSE_DATA_CAP) d = `${d.slice(0, PER_SENSE_DATA_CAP)}…[capped]`;
      if (d.length > senseDataBudget) d = `${d.slice(0, senseDataBudget)}…[budget]`;
      senseDataBudget -= d.length;
      const indented = d.split('\n').map((l) => `    ${l}`).join('\n');
      return `${head}\n${indented}`;
    })
    .join('\n');

  const actionMenu = renderActionMenu(ctx.actions);
  const tasksBlock = renderTasksBlock(ctx.tasks);
  // Item 10 — Layer 3: the active job's body, swapped in per job (empty
  // when no job is active).
  const jobBodyBlock = renderJobBody(ctx.tasks);
  // Item 1 — prefer the fast-clock situation report (a synthesized "here
  // is where we are") over re-injecting raw cycle history. Falls back to
  // the raw recent-actions block before the first fast-clock tick.
  // FIX-008: recall now runs before ground, so prev.memories carries the
  // memory set the substrate will audit. Render those memories directly so
  // the LLM sees the same set judge.ts audits against — closing the "two
  // disjoint memory paths" gap. When situation_current is populated, show
  // BOTH the narrative summary AND the raw memories: the summary gives the
  // LLM a running-state frame; the raw memory block is what the audit
  // checks against.
  const situation = ctx.recall.currentSituation();
  const recentActionsBlock = renderRecentActions(prev.memories);
  const contextBlock = situation
    ? (recentActionsBlock
        ? `situation (your running summary — trust this over re-deriving state from scratch):\n${situation}\n\n${recentActionsBlock}`
        : `situation (your running summary — trust this over re-deriving state from scratch):\n${situation}`)
    : recentActionsBlock;

  // Item 15 — when the work has stalled, lead the reality slice with a
  // high-salience posture-change demand so the decide call cannot miss it.
  const db = (ctx.memory as RuntimeMemoryAdapter).dbHandle();
  const noProgress = readNoProgressCycles(db);
  const noProgressBlock =
    noProgress >= NO_PROGRESS_THRESHOLD
      ? `NO PROGRESS — ${noProgress} cycles with no item closing or gate clearing. The current approach is NOT working. Before any more fetching, reading, or inventorying, STOP and re-examine YOUR OWN state and assumptions: Are you misusing a tool (a path that keeps failing? paths are relative to each tool's stated root — do not re-prepend the root, e.g. use "center.md", not "ledger/center.md")? Repeating an action that already failed? Ignoring data you ALREADY hold (your senses this cycle already surface the corpus content — reason over it instead of re-fetching)? And do NOT loop to perfect or verify one source: if a fact cannot be confirmed now (dead link, missing source), COMMIT your best integrated judgment and FLAG that claim as unverified — a sound analyst writes "this figure is unverified, flagged" and produces the deliverable, rather than chasing a single source. Produce the deliverable from what you already have.`
      : '';

  // Three-tier watchdog Step 1 — render unresolved watchdog corrections from
  // the slow-clock drift review. Object-cited; the citation does the
  // persuading. Tier-3 surfaces (open questions) will live in a separate table
  // and render under a different header (Step 4) — that physical separation,
  // not a tag, is what keeps a question from ever being rendered as a fact.
  const correctionsBlock = renderWatchdogCorrections(
    db,
    WATCHDOG_CORRECTIONS_LIMIT,
    WATCHDOG_CORRECTIONS_BYTE_BUDGET,
  );

  // Tier-3 open-questions section — physically separate selector reading a
  // different table than the corrections section. Distinct header marks the
  // no-authority caveat so the lattice's frame for these is "deliberate,"
  // not "accept as fact." Both sections render side by side; the wording is
  // the only signal.
  const openQuestionsBlock = renderOpenQuestions(
    db,
    OPEN_QUESTIONS_LIMIT,
    OPEN_QUESTIONS_BYTE_BUDGET,
  );

  const groundedPrompt = wrap({
    cycle: ctx.cycle,
    at_ms: ctx.at_ms,
    identityComposed: ctx.identity.composed_body,
    realitySliceSummary: [
      noProgressBlock,
      `senses:\n${senseSummary || '(none enabled)'}`,
      contextBlock,
      correctionsBlock,
      openQuestionsBlock,
      jobBodyBlock,
      tasksBlock,
    ]
      .filter((s) => s.length > 0)
      .join('\n\n'),
    instruction: [
      'Decide the best next single action this cycle.',
      '',
      'Respond ONLY in R++. No preamble, no apology, no markdown headings.',
      'You MAY wrap your response in a ```rpp ... ``` fence.',
      '',
      'Required blocks: TARGET (with `output: "<action-name>"`) and BEHAVIOR Decide.',
      'Optional: TOKENS { key: "value" ... } when the action needs input parameters.',
      '',
      'Available actions (pick exactly ONE — the TARGET.output value MUST exactly match one of the names below; do not invent, paraphrase, or use plain-English verbs):',
      actionMenu,
      '',
      'EXAMPLE — close a finished item:',
      '```rpp',
      'TARGET { output: "close-job-item" }',
      'TOKENS {',
      '  itemId: "the-item-uuid-from-the-open-tasks-list"',
      '  why: "output/features.md written this cycle with full citations"',
      '}',
      'BEHAVIOR Decide {',
      '  Item 3.1 deliverable produced; close so the next cycle progresses to 3.2.',
      '}',
      '```',
      '',
      'EXAMPLE — read a file:',
      '```rpp',
      'TARGET { output: "fs-read-content" }',
      'TOKENS {',
      '  path: "package.json"',
      '  maxBytes: 4000',
      '}',
      'BEHAVIOR Decide {',
      '  Need package.json to map dependencies for the migration plan.',
      '}',
      '```',
      '',
      'EXAMPLE — write a finding:',
      '```rpp',
      'TARGET { output: "fs-write" }',
      'TOKENS {',
      '  path: "findings/dependencies.md"',
      '  body: "# Dependencies\\n\\n- react@18.2"',
      '}',
      'BEHAVIOR Decide {',
      '  Persist initial dependency snapshot so the next cycle can build on it.',
      '}',
      '```',
      '',
      'EXAMPLE — no useful action:',
      '```rpp',
      'TARGET { output: "noop" }',
      'BEHAVIOR Decide {',
      '  No actionable evidence; remain in observe mode.',
      '}',
      '```',
      '',
      'In BEHAVIOR Decide: cite the evidence (sense reading, memory, or task item) by name in one sentence.',
      'When you have produced the deliverable for an open task item, close it on the next cycle via close-job-item using the item id shown in the open tasks block. Do not re-write a deliverable that already exists unless the previous version is materially wrong.',
      'If you are stuck — a tool call that keeps failing, the same action repeated, or a source you cannot retrieve — STOP and re-examine your OWN state before fetching or inventorying again: are you misusing a tool (paths are relative to each tool’s stated root — do NOT re-prepend the root), repeating an action that already failed, or ignoring data you ALREADY hold (the corpus content is in your senses THIS cycle — reason over it instead of re-fetching)? Do NOT loop to verify or perfect one source: if a fact cannot be confirmed now (dead link, a command syntax you cannot get right), COMMIT your best integrated judgment and FLAG that claim as unverified — a sound analyst writes "this figure is unverified, flagged" and produces the deliverable from what is already in hand rather than chasing one input.',
    ].join('\n'),
  });

  return { ...prev, groundedPrompt };
}

function renderActionMenu(actions: readonly Capability<unknown, unknown>[]): string {
  const enabled = actions.filter((a) => a.role.action && a.isEnabled());
  if (enabled.length === 0) {
    return '  (none — only noop is available)';
  }
  return enabled
    .map((a) => {
      const flags: string[] = [];
      if (a.destructive) flags.push('destructive');
      if (a.readOnly) flags.push('read-only');
      const flagsTag = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
      return `  - "${a.name}"${flagsTag} — ${a.description}`;
    })
    .join('\n');
}

/**
 * Surface the lattice's own most-recent cycle-outcome memories in the
 * reality slice so the deciding model can SEE what it just did.
 *
 * FIX-008 (2026-07-18): now takes the memory array directly instead of
 * pulling from a MemoryRecallView. The caller passes `prev.memories`
 * from the recall phase, so the LLM sees exactly the set the substrate's
 * Memory-law audits against (previously the two paths were disjoint —
 * recall pulled 8, this function pulled 24 via a separate query, and
 * judge.ts audited the 8 the LLM never saw).
 *
 * Historical note: with the old cycle order (ground → recall → decide),
 * the model would have seen identity + senses + open tasks + instruction
 * but never its own action history — that blindness caused the run-1
 * dir-loop and run-2 write-without-close failure modes. The new order
 * (recall → ground → decide) makes prev.memories available in ground,
 * and this block puts them in front of the model.
 *
 * Generic across all lattices, all backends, all tasks. The block is
 * empty (and elided) on cycle 1 when no prior memories exist.
 *
 * Window size note: prev.memories currently contains up to 8 entries
 * (from `recall.reinforceRecalled(8)` in recall.ts). Prior behavior
 * displayed up to 24 via `recentEpisodic(RECENT_ACTIONS_LIMIT=24)`;
 * dropping to 8 aligns display with the audited set. Increasing the
 * recall count in recall.ts is a follow-on tweak, not part of FIX-008.
 * RECENT_ACTION_MAX_BYTES still caps per-entry body size.
 */
function renderRecentActions(memories: readonly MemoryWrite[]): string {
  if (memories.length === 0) return '';
  const lines = ['recent actions (oldest first, most-recent last) — your own action history this run:'];
  for (const m of memories) {
    lines.push('  ' + truncate(m.body, RECENT_ACTION_MAX_BYTES));
  }
  lines.push(
    'If the recent actions show you already produced a deliverable, do NOT re-produce it — close the corresponding task item.',
  );
  lines.push(
    'If the same action with the same input has run more than twice without changing the situation, choose a different action.',
  );
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Render a sense's DATA to a readable string for the reality slice. Recognises the
 * digest sense (content) and the fs-read listing (file names); falls back to compact
 * JSON. Caller caps length. Returns '' when there's nothing useful to show.
 */
function renderSenseData(data: unknown): string {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if (typeof o.digest === 'string') return o.digest; // fs-digest sense — corpus content
    if (Array.isArray(o.entries)) {
      const list = (o.entries as Array<{ path: string; bytes: number }>).map(
        (e) => `${e.path} (${e.bytes}b)`,
      );
      return `files (${(o.fileCount as number) ?? list.length}):\n${list.join('\n')}`;
    }
    try {
      return JSON.stringify(o);
    } catch {
      return String(o);
    }
  }
  return String(data);
}

/**
 * Item 10 — Layer 3: surface the active job's body. The first open job
 * with non-empty body content is treated as active (the spec assumes one
 * active job at a time). Empty when no job is active.
 */
function renderJobBody(tasks: TasksView | undefined): string {
  if (!tasks) return '';
  const active = tasks.listOpenJobs().find((j) => j.body && j.body.trim().length > 0);
  if (!active) return '';
  return `current job (Layer 3 — "${active.title}"):\n${active.body.trim()}`;
}

export function renderTasksBlock(tasks: TasksView | undefined): string {
  if (!tasks) return '';
  const jobs = tasks.listOpenJobs();
  if (jobs.length === 0) return 'open tasks: (none)';
  const lines: string[] = [
    'open tasks (the gate line under each item is checked live against the filesystem THIS cycle — trust it over your running summary):',
  ];
  for (const job of jobs) {
    lines.push(`- job "${job.title}" — ${job.why}`);
    const items = tasks.listOpenItems(job.id);
    if (items.length === 0) {
      lines.push('    (no open items)');
    } else {
      for (const it of items) {
        const iter = it.iteration_count > 0 ? ` (iter=${it.iteration_count})` : '';
        const blk = it.blockedBy ? ` (blocked by ord=${it.blockedBy.ordinal} open)` : '';
        const ops = it.source === 'operator' ? ' (operator-attestation — closeable only by operator endpoint)' : '';
        lines.push(`    [ ] id=${it.id} — ${it.description}${iter}${blk}${ops}`);
        // Closeability signal — the line under each open item that tells the
        // architect what's REAL about this item's gate, regardless of hook
        // tier. The matrix:
        //   - blocked → no gate line (blocker annotation on the line above is the signal)
        //   - source='operator' → "awaiting operator attestation" (never "close this", even when all
        //     siblings passed — the architect MUST NOT be lured by a near-ready operator item)
        //   - cheap_pass → "gate OK — close this item" (unchanged from prior behaviour)
        //   - cheap_pass_costly_pending → "gate OK — cheap satisfied; close will run the costly <hook>"
        //   - cheap_fail → "gate NOT MET — <specific reason>" (unchanged)
        //   - costly_only step_acknowledged → "ready — acknowledgement gate; close with justification"
        //   - costly_only operator_attested (defence-in-depth — should be unreachable
        //     since source=='operator' branch fires first, but handled here too)
        //   - costly_only command_exits_zero/http_status_is → "costly — close will run <hook>"
        //   - unknown_hook → "gate UNKNOWN — <reason>"
        // Reserved: "NOT MET" is for cheap hooks that actually failed. A
        // costly-only item never renders NOT MET. The pre-fix renderer
        // emitted "gate NOT MET — costly gate — verified only on explicit
        // close" for costly-only items, which actively misled the
        // architect (run-3 phase-3 stall: ord=8 reachable + step_acknowledged
        // rendered NOT MET, ord=1 file_exists-on-stale-file rendered "close
        // this" — six wrong picks before the no-progress circuit-breaker fired).
        const g = it.gate;
        if (it.blockedBy) {
          // Blocker annotation already on the item line above; suppressing
          // the gate line keeps the prompt compact and the signal singular.
        } else if (it.source === 'operator') {
          lines.push(`         gate: awaiting operator attestation — closeable only by POST /api/lattices/:id/items/:item_id/attest, not by architect`);
        } else if (g) {
          switch (g.kind) {
            case 'cheap_pass':
              lines.push(`         gate OK — ${g.reason}`);
              break;
            case 'cheap_pass_costly_pending':
              lines.push(`         gate OK — cheap checks satisfied; close-job-item will run the costly ${g.costlyHook ?? 'gate'} check`);
              break;
            case 'cheap_fail':
              lines.push(`         gate NOT MET — ${g.reason}`);
              break;
            case 'costly_only':
              if (g.costlyHook === 'step_acknowledged') {
                lines.push(`         gate: ready — acknowledgement gate; close-job-item with a one-line justification to close`);
              } else if (g.costlyHook === 'operator_attested') {
                // Defence-in-depth — source='operator' branch above already handled
                // the typical case. This catches the rare non-operator item that
                // somehow declared an operator_attested gate.
                lines.push(`         gate: awaiting operator attestation — closeable only by POST /api/lattices/:id/items/:item_id/attest, not by architect`);
              } else {
                lines.push(`         gate: costly — close-job-item will run ${g.costlyHook ?? 'the costly gate'}`);
              }
              break;
            case 'unknown_hook':
              lines.push(`         gate UNKNOWN — ${g.reason}`);
              break;
          }
        }
      }
    }
  }
  return lines.join('\n');
}
