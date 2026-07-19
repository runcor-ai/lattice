import type { CyclePhase, PhaseTraceEntry } from '@runcor/trace';

import { act } from './phases/act.js';
import { decide } from './phases/decide.js';
import { ground } from './phases/ground.js';
import { judge } from './phases/judge.js';
import { observe } from './phases/observe.js';
import { pulse } from './phases/pulse.js';
import { recall } from './phases/recall.js';
import { write } from './phases/write.js';
import type { ActOutput, CycleContext, CycleResult, PhaseRunners } from './types.js';

export const DEFAULT_PHASES: PhaseRunners = {
  observe,
  ground,
  recall,
  decide,
  act,
  judge,
  write,
  pulse,
};

/**
 * FIX-006 (2026-07-18): compose the act phase's `output_summary` string from
 * the ActOutput's discriminated fields. Prior format collapsed three orthogonal
 * facts into one bit:
 *   - DID DISPATCH (pre-spawn substrate law refused vs capability invoked)
 *   - EXIT CODE (if invoked: 0 or nonzero)
 *   - failure category (Persistence vs No-progress vs Read-cap vs exec_error vs …)
 *
 * New format:
 *   - `result=ok;exit=<N>`               — capability ran; N is child exit code
 *     (only when actData.exitCode is a number, e.g. shell-exec)
 *   - `result=ok`                        — capability succeeded, no exit-code shape
 *   - `result=no-action`                 — architect chose no action this cycle
 *   - `result=refused_by_substrate;law=<name>` — Persistence / No-progress / Read-cap
 *     refused pre-spawn. The full reason lives in actFailedReason / episodic memory.
 *   - `result=denied`                    — permission gate rejected the invoke
 *   - `result=exec_error`                — capability threw during invoke, or action
 *     was not found (structural lookup miss subsumed here for compactness)
 *
 * The output_summary is the surface field operators read at a glance in the trace;
 * full detail remains in `actFailedReason` and `memory_episodic`. This resolves the
 * FIX-006 c50 silent-fail (publish-app exit 1 read as ok) and the c27/c30/c32
 * Persistence-refusal-looks-like-check-failure conflation.
 */
export function formatActSummary(actOutput: ActOutput): string {
  if (actOutput.actResult === 'ok') {
    const data = actOutput.actData as { exitCode?: unknown } | undefined;
    if (data && typeof data === 'object' && typeof data.exitCode === 'number') {
      return `result=ok;exit=${data.exitCode}`;
    }
    return 'result=ok';
  }
  if (actOutput.actResult === 'no-action') return 'result=no-action';
  // actResult === 'failed'
  const kind = actOutput.actFailureKind;
  if (kind === 'persistence' || kind === 'no-progress' || kind === 'read-cap') {
    return `result=refused_by_substrate;law=${kind}`;
  }
  if (kind === 'denied') return 'result=denied';
  // 'exec_error', 'action_not_found', or undefined (defensive fallback for older
  // ActOutput shapes) — all bucketed as exec_error for the summary. Callers
  // still get the exact reason from actFailedReason.
  return 'result=exec_error';
}

/**
 * runCycle — execute one pass through the eight phases in pinned
 * order (constitution Principle VI; spec FR-001).
 *
 * Each phase produces exactly one trace entry per cycle, including
 * phases that produced no useful work (FR-002).
 */
export async function runCycle(
  ctx: CycleContext,
  phases: PhaseRunners = DEFAULT_PHASES,
): Promise<CycleResult> {
  type R = { observe?: unknown; ground?: unknown; recall?: unknown; decide?: unknown; act?: unknown; judge?: unknown; write?: unknown; pulse?: unknown };
  const out: R = {};
  let currentPhase: CyclePhase = 'observe';

  const runPhase = async <T>(
    name: CyclePhase,
    fn: () => Promise<T>,
    summary: (result: T) => string,
  ): Promise<T> => {
    currentPhase = name;
    const startedAt = Date.now();
    let result: T;
    let phaseResult: 'ok' | 'failed' = 'ok';
    let failedReason: string | undefined;
    try {
      result = await fn();
    } catch (err) {
      phaseResult = 'failed';
      failedReason = err instanceof Error ? err.message : String(err);
      const entry: PhaseTraceEntry = {
        kind: 'phase',
        cycle: ctx.cycle,
        at_ms: startedAt,
        phase: name,
        duration_ms: Date.now() - startedAt,
        result: phaseResult,
        failed_reason: failedReason,
      };
      ctx.trace.write(entry);
      throw err;
    }
    const entry: PhaseTraceEntry = {
      kind: 'phase',
      cycle: ctx.cycle,
      at_ms: startedAt,
      phase: name,
      duration_ms: Date.now() - startedAt,
      result: phaseResult,
      output_summary: summary(result),
    };
    ctx.trace.write(entry);
    return result;
  };

  try {
    out.observe = await runPhase(
      'observe',
      () => phases.observe(ctx),
      (r: any) => `senses=${Object.keys(r.perception.senses).length}`,
    );
    // FIX-008: recall runs BEFORE ground so ground can inject prev.memories.
    out.recall = await runPhase(
      'recall',
      () => phases.recall(ctx, out.observe as any),
      (r: any) => `memories=${r.memories.length}`,
    );
    out.ground = await runPhase(
      'ground',
      () => phases.ground(ctx, out.recall as any),
      (r: any) => `prompt_bytes=${r.groundedPrompt.length}`,
    );
    out.decide = await runPhase(
      'decide',
      () => phases.decide(ctx, out.ground as any),
      (r: any) =>
        `action=${r.chosenAction ?? '(none)'};blocks=${r.decision.output.ast.blocks.length}`,
    );
    out.act = await runPhase(
      'act',
      () => phases.act(ctx, out.decide as any),
      // FIX-006: use the three-state summary formatter so the trace surface
      // distinguishes refused_by_substrate / exec_error / exit=N instead of
      // collapsing them into a single result=failed/ok bit.
      (r: ActOutput) => formatActSummary(r),
    );
    out.judge = await runPhase(
      'judge',
      () => phases.judge(ctx, out.act as any),
      (r: any) => `judgement=${r.judgement}`,
    );
    out.write = await runPhase(
      'write',
      () => phases.write(ctx, out.judge as any),
      (r: any) => `writes=${r.memoryWrites}`,
    );
    out.pulse = await runPhase(
      'pulse',
      () => phases.pulse(ctx, out.write as any),
      () => 'continue=true',
    );

    return {
      cycle: ctx.cycle,
      outcome: 'completed',
      write: out.write as any,
      pulse: out.pulse as any,
    };
  } catch (err) {
    return {
      cycle: ctx.cycle,
      outcome: ctx.abortSignal.aborted ? 'aborted' : 'failed',
      failedAt: currentPhase,
      failedReason: err instanceof Error ? err.message : String(err),
    };
  }
}
