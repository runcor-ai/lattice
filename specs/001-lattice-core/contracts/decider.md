# Contract: Decider

The decider is the LLM reasoning pass that any component can call when it
needs deliberation (intent §11). The lattice has **two built and wired
deciders** — single-model and dialectic — selectable per lattice via the
`dialecticDepth` dial. The Bridge dial position is what chooses, not the
caller.

Callers depend on `Decider`, never on a specific implementation.

```ts
// packages/decider/src/types.ts

import { RppPrompt, RppParseResult } from '@runcor/rpp-parser';
import { Trace } from '@runcor/trace';

/**
 * A request the decider deliberates over.
 * `prompt` is already substrate-wrapped and R++-validated by the caller.
 */
export interface DecideRequest {
  prompt: RppPrompt;          // pre-wrapped by substrate (Principle VIII + IX)
  cycle: number;
  trace: Trace;               // for the decider to record its own steps
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

export interface DecideResult {
  output: RppParseResult;     // the decider's parser-validated output
  usage: TokenUsage;          // tokens spent across all internal calls
  reasoning?: string;         // optional summary the trace can store
}

export interface Decider {
  readonly name: string;       // 'single-model' | 'dialectic'
  decide(req: DecideRequest): Promise<DecideResult>;
}
```

## Implementations

### `SingleModelDecider` (default)

- One call to the configured `ModelBackend` (see model-backend.md).
- Validates the response against R++ via `rpp-parser`.
- Re-prompts up to 2 times on parse failure (these re-prompts ARE recorded
  in the trace).
- Returns `DecideResult` or throws `DeciderError` on definitive failure.

### `DialecticDecider`

- Three internal calls per request: **Player** drafts → **Coach**
  challenges → **Judge** selects.
- Each internal call is itself R++-wrapped.
- Depth controlled by `dialecticDepth` dial: `depth = 0` falls through to
  `SingleModelDecider`; `depth = 1` runs one Player/Coach/Judge round;
  higher depths run additional Coach rounds before Judge.
- Reuses `runcor-ai/runcor-dialectic` logic with attribution.

## Invariants

- The decider MUST NOT directly read or write the SQLite file. It receives
  prompts via `DecideRequest`; persistence is the caller's responsibility.
- The decider MUST call the substrate's `discern()` on its own internal
  outputs before returning (so an internal Player/Coach output that
  violates a law is caught inside the decider, not by the outer cycle).
- The decider MUST record its own internal steps (Player draft, Coach
  challenges, Judge selection) to the trace under `kind: 'decider'`.
- The decider MUST honour `abortSignal` — if the cycle is interrupted, the
  decider returns control promptly.
- The decider MUST NOT exceed `req.maxTokens` total across its internal
  calls; it returns a `DecideResult` with whatever it produced and a
  `usage` reflecting the cap reached.

## Failure modes

```ts
export class DeciderError extends Error {
  readonly kind:
    | 'parse_failure'        // output failed R++ parsing after retries
    | 'discern_block'        // an internal output was blocked by substrate
    | 'budget_exhausted'     // hit token cap before a valid result
    | 'backend_error';       // model backend returned an error
  readonly cause?: Error;
}
```

The caller decides whether to surface the error (typically: log to trace,
retry next cycle, or escalate to operator per autonomy dial).
