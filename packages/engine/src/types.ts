/**
 * Engine types — the swappable model backend layer (intent §14;
 * constitution Principle XI; spec FR-018 + FR-024).
 *
 * Every model call is built and validated as R++ by the caller before
 * reaching the backend. The backend itself is a thin adapter; it does
 * not parse, wrap, discern, or persist.
 */

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cached_input?: number;
}

export interface CostEstimate {
  readonly unit: 'usd' | 'tokens' | 'seconds';
  readonly amount: number;
  readonly confidence: 'low' | 'medium' | 'high';
}

import type { RppPrompt } from '@runcor/substrate';
export type { RppPrompt };

export interface ModelCallRequest {
  /**
   * Slice 8 tightens this from raw string to RppPrompt
   * (constitution Principle IX — every model call validated as R++).
   * Only the substrate's wrap() can produce an RppPrompt; bare strings
   * fail at compile time.
   */
  readonly prompt: RppPrompt;
  readonly modelHint?: 'fast' | 'balanced' | 'capable';
  readonly maxTokens?: number;
  readonly abortSignal?: AbortSignal;
}

export interface ModelCallResult {
  readonly text: string;
  readonly usage: TokenUsage;
  readonly modelUsed: string;
  readonly finishReason: 'stop' | 'max_tokens' | 'tool_use' | 'abort';
}

export interface ModelBackend {
  readonly name: string;
  call(req: ModelCallRequest): Promise<ModelCallResult>;
  estimateCost(req: ModelCallRequest): CostEstimate;
}

export class ModelBackendError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'auth'
      | 'rate_limited'
      | 'usage_limit'
      | 'network'
      | 'invalid_request'
      | 'aborted',
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ModelBackendError';
  }
}
