import type { CyclePhase, PhaseTraceEntry } from '@runcor/trace';

import { act } from './phases/act.js';
import { decide } from './phases/decide.js';
import { ground } from './phases/ground.js';
import { judge } from './phases/judge.js';
import { observe } from './phases/observe.js';
import { pulse } from './phases/pulse.js';
import { recall } from './phases/recall.js';
import { write } from './phases/write.js';
import type { CycleContext, CycleResult, PhaseRunners } from './types.js';

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
      (r: any) => `result=${r.actResult}`,
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
