# Contract: ModelBackend

The way the engine reaches a model is a **swappable backend** (intent §14 +
constitution Principle XI). Two implementations are built and wired:

1. `DirectApiBackend` — calls a provider SDK (Anthropic by default).
2. `HostCliBackend` — drives a coding-agent CLI on the operator's machine
   as a host, letting an operator run the lattice over their subscription.

The lattice itself never sees which backend is active.

```ts
// packages/engine/src/types.ts

import { RppPrompt } from '@runcor/rpp-parser';

export interface ModelCallRequest {
  prompt: RppPrompt;          // already substrate-wrapped + R++-validated
  modelHint?: string;         // optional: 'fast' | 'balanced' | 'capable'
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

export interface ModelCallResult {
  text: string;               // raw text from the model (caller R++-parses)
  usage: TokenUsage;
  modelUsed: string;          // identifier returned by the backend
  finishReason: 'stop' | 'max_tokens' | 'tool_use' | 'abort';
}

export interface ModelBackend {
  readonly name: string;             // 'direct-api' | 'host-cli'
  call(req: ModelCallRequest): Promise<ModelCallResult>;
  estimateCost(req: ModelCallRequest): CostEstimate;  // for budget pre-check
}

export interface CostEstimate {
  unit: 'usd' | 'tokens' | 'seconds';
  amount: number;
  confidence: 'low' | 'medium' | 'high';
}
```

## Implementations

### `DirectApiBackend`

- Uses `@anthropic-ai/sdk` by default. API key sourced from the lattice's
  config (Bridge stores it; the lattice gets a handle, not the raw key).
- Retries with exponential backoff on transient errors (5xx, network).
- Returns immediately on 4xx (caller decides whether to retry differently).
- Maps `modelHint` to concrete model IDs via a config table.

### `HostCliBackend`

- Spawns the host CLI per call (or maintains a long-lived child process,
  TBD by implementation).
- Translates `RppPrompt` to the CLI's prompt format.
- Detects usage-limit responses and signals via a recognisable error
  (`UsageLimitError`) so the caller can defer the job per the spec's
  Edge Cases.
- The operator is responsible for confirming provider terms-of-service
  compliance (constitution Technology Stack note).

## Invariants

- The backend MUST NOT read or write the SQLite file.
- The backend MUST NOT call the substrate — the caller is responsible for
  wrapping prompts before calling the backend.
- The backend MUST honour `abortSignal`.
- `estimateCost()` MUST be cheap (no network calls).

## Failure modes

```ts
export class ModelBackendError extends Error {
  readonly kind:
    | 'auth'                  // credentials invalid / missing
    | 'rate_limited'          // backend-imposed throttle; retry after
    | 'usage_limit'           // provider plan limit reached (key signal for Edge Case)
    | 'network'               // transient connectivity
    | 'invalid_request'       // 4xx from provider
    | 'aborted';              // honoured abortSignal
  readonly retryAfterMs?: number;
}
```

The engine layer wraps backend calls with retry policy; persistent failures
are surfaced to the calling phase and recorded in the trace.
