import {
  DeciderError,
  isValidR,
  SingleModelDecider,
  type Decider,
  type DecideRequest,
  type DecideResult,
  type DeciderDeps,
} from '@runcor/decider';
import type { ModelBackend } from '@runcor/engine';

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
  /**
   * Second voice for the Coach pass. When provided, the Coach challenges the
   * Player's draft using THIS backend (e.g. a non-Claude OpenRouter model) while
   * Player and Judge run on the primary engine — genuine two-instance dialectic.
   * Defaults to the primary engine if absent (so depth-0 and single-backend
   * dialectic are unchanged).
   */
  readonly coachEngine?: ModelBackend;
}

export class DialecticDecider implements Decider {
  readonly name = 'dialectic';
  private readonly engine;
  private readonly coachEngine: ModelBackend;
  private readonly depth: number;
  private readonly fallback: SingleModelDecider;
  /** Parse-failure retries for Player/Judge, mirroring SingleModelDecider (default 2). */
  private readonly maxRetries = 2;

  constructor(deps: DeciderDeps, opts: DialecticOptions) {
    this.engine = deps.engine;
    // Coach uses its own backend (a distinct second voice) when supplied;
    // otherwise it falls back to the primary engine (unchanged behavior).
    this.coachEngine = opts.coachEngine ?? deps.engine;
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

    // Player — retry up to maxRetries until valid R++ (mirrors SingleModelDecider).
    let draft = await runPlayer(this.engine, req.prompt, baseOpts);
    for (let attempt = 1; attempt <= this.maxRetries && !isValidR(draft.parsed); attempt += 1) {
      draft = await runPlayer(this.engine, req.prompt, baseOpts);
    }
    if (!isValidR(draft.parsed)) {
      throw new DeciderError(
        `dialectic player produced invalid R++ after ${this.maxRetries + 1} attempts: ${diagSummary(draft.parsed)}`,
        'parse_failure',
      );
    }
    // crude token accounting via prompt size — slice 12 will plumb real usage end-to-end
    totalIn += Math.ceil(req.prompt.length / 4);
    totalOut += Math.ceil(draft.text.length / 4);

    // Coach round(s) — depth=1 → 1 critique; depth=2 → 2 critiques; etc.
    // The Coach is a SECOND VOICE: the Judge reads its critique as TEXT (see runJudge),
    // so the coach output need NOT be valid R++ — it may be prose/JSON from any model
    // (e.g. a cheap OpenRouter Nemotron). Only the Player draft and the Judge verdict are
    // R++-validated. This lets a non-R++ coach genuinely challenge the draft.
    const critiques = [] as Array<Awaited<ReturnType<typeof runCoach>>>;
    for (let i = 0; i < this.depth; i += 1) {
      const c = await runCoach(this.coachEngine, req.prompt, draft, baseOpts);
      totalIn += Math.ceil(req.prompt.length / 4);
      totalOut += Math.ceil(c.text.length / 4);
      critiques.push(c);
    }

    // Judge — retry up to maxRetries until valid R++.
    let judged = await runJudge(this.engine, req.prompt, draft, critiques, baseOpts);
    for (let attempt = 1; attempt <= this.maxRetries && !isValidR(judged.parsed); attempt += 1) {
      judged = await runJudge(this.engine, req.prompt, draft, critiques, baseOpts);
    }
    if (!isValidR(judged.parsed)) {
      throw new DeciderError(
        `dialectic judge produced invalid R++ after ${this.maxRetries + 1} attempts: ${diagSummary(judged.parsed)}`,
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
