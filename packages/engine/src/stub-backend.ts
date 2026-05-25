import type {
  CostEstimate,
  ModelBackend,
  ModelCallRequest,
  ModelCallResult,
} from './types.js';

/**
 * StubBackend — a deterministic model backend for tests. Returns a
 * canned R++-ish response so slice 1 does not need a network or an
 * API key to prove the cycle turns.
 *
 * Real backends (DirectApiBackend → @anthropic-ai/sdk;
 * ClaudeCodeHostBackend → CLI driver) land in slice 12.
 */
export interface StubBackendOptions {
  readonly responder?: (req: ModelCallRequest) => string;
  readonly name?: string;
}

export class StubBackend implements ModelBackend {
  readonly name: string;
  private readonly responder: (req: ModelCallRequest) => string;

  constructor(opts: StubBackendOptions = {}) {
    this.name = opts.name ?? 'stub';
    this.responder =
      opts.responder ??
      ((_req) =>
        // Minimal valid R++ doc — parser-validated by the decider
        // (slice 8). Earlier slices accepted free text; the format
        // tightening for R++-everywhere lands here.
        'TARGET { output: "noop" }\nBEHAVIOR Decide {\n  No action this cycle.\n}\n');
  }

  async call(req: ModelCallRequest): Promise<ModelCallResult> {
    if (req.abortSignal?.aborted) {
      return {
        text: '',
        usage: { input: 0, output: 0 },
        modelUsed: this.name,
        finishReason: 'abort',
      };
    }
    const text = this.responder(req);
    return {
      text,
      usage: {
        input: Math.ceil(req.prompt.length / 4),
        output: Math.ceil(text.length / 4),
      },
      modelUsed: this.name,
      finishReason: 'stop',
    };
  }

  estimateCost(req: ModelCallRequest): CostEstimate {
    return {
      unit: 'tokens',
      amount: Math.ceil(req.prompt.length / 4),
      confidence: 'low',
    };
  }
}
