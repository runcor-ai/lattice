import { parse } from '@runcor/rpp-parser';

import {
  DeciderError,
  isValidR,
  type DecideRequest,
  type DecideResult,
  type Decider,
  type DeciderDeps,
} from './types.js';

/**
 * Strip prose preamble / markdown code fences before parsing.
 *
 * Models trained on prose rarely return bare R++. They wrap it in
 * ```rpp ... ``` (or ``` ... ```) fences, or precede it with a
 * sentence like "Here is the R++ output:". Both are common and
 * harmless; rejecting them just burns retries. We extract the first
 * fenced block if present; otherwise we slice from the first R++
 * keyword we recognise. Returns the original text if neither
 * pattern matches (parser will produce real diagnostics then).
 */
const RPP_BLOCK_KEYWORDS_RE =
  /^(TARGET|TOKENS|FORMAT|MAP|DATA|INIT|STRUCTURE|COMPONENT|SECTION|VIEW|BEHAVIOR|CHECKLIST)\b/m;

export function extractRpp(text: string): string {
  const fence = text.match(/```(?:rpp|r\+\+|)\s*\n([\s\S]*?)\n```/i);
  if (fence && RPP_BLOCK_KEYWORDS_RE.test(fence[1]!)) return fence[1]!;
  const m = text.match(RPP_BLOCK_KEYWORDS_RE);
  if (m && m.index !== undefined) return text.slice(m.index);
  return text;
}

/**
 * SingleModelDecider — default. One call to the configured
 * ModelBackend. If the response fails R++ parse-validation, retries
 * up to 2 times (each retry recorded in the trace). On final
 * failure, throws DeciderError(kind='parse_failure').
 *
 * Slice 8 ships this as the baseline; slice 11 will plumb it into
 * goal proposal, identity reflective update, skill synthesis.
 */
export class SingleModelDecider implements Decider {
  readonly name = 'single-model';
  private readonly engine;
  private readonly maxRetries: number;

  constructor(deps: DeciderDeps, opts: { maxRetries?: number } = {}) {
    this.engine = deps.engine;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  async decide(req: DecideRequest): Promise<DecideResult> {
    let totalIn = 0;
    let totalOut = 0;
    let lastDiagnostics: string[] = [];

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const callRequest = {
        prompt: req.prompt,
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
        ...(req.abortSignal !== undefined ? { abortSignal: req.abortSignal } : {}),
      };
      const result = await this.engine.call(callRequest);
      totalIn += result.usage.input;
      totalOut += result.usage.output;
      const parsed = parse(extractRpp(result.text));
      if (isValidR(parsed)) {
        return {
          output: parsed,
          usage: { input: totalIn, output: totalOut },
          reasoning: attempt > 0 ? `parsed on attempt ${attempt + 1}` : undefined,
        } as DecideResult;
      }
      lastDiagnostics = parsed.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => `${d.code}: ${d.message}`);
      // Record the retry so the operator can see parse-quality issues.
      req.trace.write({
        kind: 'operator',
        cycle: req.cycle,
        at_ms: Date.now(),
        action: 'lifecycle',
        detail:
          `decider=single-model retry ${attempt + 1}/${this.maxRetries} ` +
          `parse_errors=${lastDiagnostics.length}`,
      });
    }
    throw new DeciderError(
      `single-model decider: R++ parse failed after ${this.maxRetries + 1} attempts — ${lastDiagnostics.join('; ').slice(0, 200)}`,
      'parse_failure',
    );
  }
}
