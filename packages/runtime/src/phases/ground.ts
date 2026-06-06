import type { Capability } from '@runcor/capabilities';
import { wrap } from '@runcor/substrate';

import type {
  CycleContext,
  GroundOutput,
  MemoryRecallView,
  ObserveOutput,
  TasksView,
} from '../types.js';

/**
 * Number of the lattice's own most-recent cycle-outcome memories to
 * surface in every cycle's reality slice. Run-3 evidence showed that
 * an 8-entry window catches consecutive repetition but loses context
 * older than ~80 seconds, leading the lattice to redo work that
 * happened 10-20 cycles ago (re-read package.json on cycles 2/11/20,
 * dir src on 12/22, etc.). 24 entries × ~280 bytes = ~6.7 KB — still
 * trivial for any modern model context, and covers ~4 minutes of
 * action history at a 10s/cycle pace.
 */
const RECENT_ACTIONS_LIMIT = 24;
const RECENT_ACTION_MAX_BYTES = 280;

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
  prev: ObserveOutput,
): Promise<GroundOutput> {
  const senseSummary = Object.values(prev.perception.senses)
    .map((r) => `- ${r.capability}: ${r.result}`)
    .join('\n');

  const actionMenu = renderActionMenu(ctx.actions);
  const tasksBlock = renderTasksBlock(ctx.tasks);
  // Item 10 — Layer 3: the active job's body, swapped in per job (empty
  // when no job is active).
  const jobBodyBlock = renderJobBody(ctx.tasks);
  // Item 1 — prefer the fast-clock situation report (a synthesized "here
  // is where we are") over re-injecting raw cycle history. Falls back to
  // the raw recent-actions block before the first fast-clock tick.
  const situation = ctx.recall.currentSituation();
  const contextBlock = situation
    ? `situation (your running summary — trust this over re-deriving state from scratch):\n${situation}`
    : renderRecentActions(ctx.recall);

  const groundedPrompt = wrap({
    cycle: ctx.cycle,
    at_ms: ctx.at_ms,
    identityComposed: ctx.identity.composed_body,
    realitySliceSummary: [
      `senses:\n${senseSummary || '(none enabled)'}`,
      contextBlock,
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
      '  why: "data-abc/out/features.md written this cycle with full citations"',
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
 * Without this, the cycle order (ground → recall → decide) means the
 * model only ever sees identity + senses + open tasks + instruction —
 * never its own action history. That blindness was the root cause of
 * the observed run-1 dir-loop and run-2 write-without-close failure
 * modes: the lattice repeatedly chose the same exploratory action
 * because nothing in its prompt reflected that the action had already
 * succeeded last cycle.
 *
 * The substrate's Memory law specifically requires referencing memory
 * when memory is available; this block makes that reference possible
 * by putting the memories in front of the model.
 *
 * Generic across all lattices, all backends, all tasks. The block is
 * empty (and elided) on cycle 1 when no prior memories exist.
 */
function renderRecentActions(recall: MemoryRecallView): string {
  const memories = recall.recentEpisodic(RECENT_ACTIONS_LIMIT);
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

function renderTasksBlock(tasks: TasksView | undefined): string {
  if (!tasks) return '';
  const jobs = tasks.listOpenJobs();
  if (jobs.length === 0) return 'open tasks: (none)';
  const lines: string[] = ['open tasks:'];
  for (const job of jobs) {
    lines.push(`- job "${job.title}" — ${job.why}`);
    const items = tasks.listOpenItems(job.id);
    if (items.length === 0) {
      lines.push('    (no open items)');
    } else {
      for (const it of items) {
        const iter = it.iteration_count > 0 ? ` (iter=${it.iteration_count})` : '';
        // Item id is shown so the lattice can copy it verbatim into
        // close-job-item's TOKENS block once the deliverable exists.
        lines.push(`    [ ] id=${it.id} — ${it.description}${iter}`);
      }
    }
  }
  return lines.join('\n');
}
