import type { ModelBackend, TokenUsage } from '@runcor/engine';
import type { ParseResult } from '@runcor/rpp-parser';
import type { RppPrompt } from '@runcor/substrate';
import type { Trace } from '@runcor/trace';

/**
 * Decider — the LLM reasoning pass that any component can call for
 * deliberation (intent §11; constitution Principle XI).
 *
 * Two implementations ship — SingleModelDecider (default) and
 * DialecticDecider — both behind this one interface. The Bridge
 * dial (`dialecticDepth`) selects per lattice; the lattice itself
 * is unaware which is in effect.
 *
 * Every model call across the system goes through a Decider
 * (constitution Principle IX, NON-NEGOTIABLE).
 */

export interface DecideRequest {
  /**
   * Already substrate-wrapped (Principle VIII) and R++-validated
   * (Principle IX). The decider passes it through to ModelBackend
   * unchanged.
   */
  readonly prompt: RppPrompt;
  readonly cycle: number;
  readonly trace: Trace;
  readonly maxTokens?: number;
  readonly abortSignal?: AbortSignal;
}

export interface DecideResult {
  /** Parser-validated R++ tree of the model's output. */
  readonly output: ParseResult;
  /** Token usage summed across any internal calls. */
  readonly usage: TokenUsage;
  /** Optional summary the trace can store. */
  readonly reasoning?: string;
}

export interface Decider {
  readonly name: string;
  decide(req: DecideRequest): Promise<DecideResult>;
}

export class DeciderError extends Error {
  readonly kind:
    | 'parse_failure'
    | 'discern_block'
    | 'budget_exhausted'
    | 'backend_error';
  constructor(
    message: string,
    kind: 'parse_failure' | 'discern_block' | 'budget_exhausted' | 'backend_error',
    cause?: Error,
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DeciderError';
    this.kind = kind;
  }
}

/**
 * Validate a ParseResult — non-empty document with no error-severity
 * diagnostics. Used by every Decider implementation to decide whether
 * a model response is acceptable.
 */
export function isValidR(parse: ParseResult): boolean {
  if (parse.ast.blocks.length === 0) return false;
  return !parse.diagnostics.some((d) => d.severity === 'error');
}

/** Engine handle passed to deciders at construction. */
export interface DeciderDeps {
  readonly engine: ModelBackend;
}
