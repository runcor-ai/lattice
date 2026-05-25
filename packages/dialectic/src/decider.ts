import {
  DeciderError,
  isValidR,
  SingleModelDecider,
  type Decider,
  type DecideRequest,
  type DecideResult,
  type DeciderDeps,
} from '@runcor/decider';

import { runCoach } from './coach.js';
import { runJudge } from './judge.js';
import { runPlayer } from './player.js';

/**
 * DialecticDecider — Player drafts → Coach challenges → Judge selects.
 *
 * `depth=0` falls through to SingleModelDecider (selectDecider does
 * this; included here for symmetry if a caller constructs us directly).
 * `depth=1` runs Player → 1×Coach → Judge.
 * `depth>=2` adds extra Coach rounds before Judge.
 *
 * Each internal output is R++-validated. A failed validation at any
 * stage throws DeciderError(kind='parse_failure'); slice 11 may add
 * per-stage retry policy. The substrate's discern() lands on the
 * Judge's output back in the cycle's `judge` phase — the dialectic's
 * stages themselves are not separately discerned (slice 11 wires
 * stage-by-stage discernment when the watchdog needs deeper audit).
 */
export interface DialecticOptions {
  readonly depth: number;
}

export class DialecticDecider implements Decider {
  readonly name = 'dialectic';
  private readonly engine;
  private readonly depth: number;
  private readonly fallback: SingleModelDecider;

  constructor(deps: DeciderDeps, opts: DialecticOptions) {
    this.engine = deps.engine;
    this.depth = Math.max(0, Math.floor(opts.depth));
    this.fallback = new SingleModelDecider(deps);
  }

  async decide(req: DecideRequest): Promise<DecideResult> {
    if (this.depth === 0) return this.fallback.decide(req);

    const baseOpts = {
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.abortSignal !== undefined ? { abortSignal: req.abortSignal } : {}),
    };

    let totalIn = 0;
    let totalOut = 0;

    // Player
    const draft = await runPlayer(this.engine, req.prompt, baseOpts);
    if (!isValidR(draft.parsed)) {
      throw new DeciderError(
        `dialectic player produced invalid R++: ${diagSummary(draft.parsed)}`,
        'parse_failure',
      );
    }
    // crude token accounting via prompt size — slice 12 will plumb real usage end-to-end
    totalIn += Math.ceil(req.prompt.length / 4);
    totalOut += Math.ceil(draft.text.length / 4);

    // Coach round(s) — depth=1 → 1 critique; depth=2 → 2 critiques; etc.
    const critiques = [] as Array<Awaited<ReturnType<typeof runCoach>>>;
    for (let i = 0; i < this.depth; i += 1) {
      const c = await runCoach(this.engine, req.prompt, draft, baseOpts);
      if (!isValidR(c.parsed)) {
        throw new DeciderError(
          `dialectic coach produced invalid R++: ${diagSummary(c.parsed)}`,
          'parse_failure',
        );
      }
      totalIn += Math.ceil(req.prompt.length / 4);
      totalOut += Math.ceil(c.text.length / 4);
      critiques.push(c);
    }

    // Judge
    const judged = await runJudge(this.engine, req.prompt, draft, critiques, baseOpts);
    if (!isValidR(judged.parsed)) {
      throw new DeciderError(
        `dialectic judge produced invalid R++: ${diagSummary(judged.parsed)}`,
        'parse_failure',
      );
    }
    totalIn += Math.ceil(req.prompt.length / 4);
    totalOut += Math.ceil(judged.text.length / 4);

    req.trace.write({
      kind: 'operator',
      cycle: req.cycle,
      at_ms: Date.now(),
      action: 'lifecycle',
      detail: `decider=dialectic depth=${this.depth} (player+${critiques.length}×coach+judge)`,
    });

    return {
      output: judged.parsed,
      usage: { input: totalIn, output: totalOut },
      reasoning: `dialectic depth=${this.depth}`,
    } as DecideResult;
  }
}

function diagSummary(parsed: { diagnostics: ReadonlyArray<{ code: string; severity: string }> }): string {
  return parsed.diagnostics
    .filter((d) => d.severity === 'error')
    .map((d) => d.code)
    .join(',') || '(no blocks)';
}
