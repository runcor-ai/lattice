# Contract: Perception

The observe phase combines two perception sources every cycle:

1. **Sense channels** of enabled capabilities (capability.md `role.sense`).
2. **Internal deferred-item unblock checks** — for each item in `plan_item`
   with `state = 'deferred'`, run its `unblock_test` against current sense
   readings.

The Perception module wires these together.

```ts
// packages/capabilities/src/perception.ts

import { Capability, ObserveContext } from './types';

export interface PerceptionSnapshot {
  cycle: number;
  at_ms: number;
  senses: Record<string, SenseReading>;
  unblocked_items: string[];      // plan_item ids whose unblock condition met
}

export interface SenseReading {
  capability: string;
  result: 'ok' | 'failed' | 'stale';
  data: unknown;                  // capability-typed
  failed_reason?: string;
  last_fresh_at_ms: number;       // when we last had a fresh read
}

export interface Perception {
  observe(ctx: ObserveContext, senses: Capability<any, any>[]): Promise<PerceptionSnapshot>;
}
```

## Behaviour

1. Call `read()` on every enabled sense in parallel with `Promise.allSettled`.
2. For each settled sense:
   - Fulfilled → `result: 'ok'`, freshness updated.
   - Rejected → `result: 'failed'`; if a prior cached reading exists, mark
     `result: 'stale'` instead.
3. After senses are collected, evaluate every deferred plan item's
   `unblock_test` against the snapshot. Items whose test now succeeds are
   added to `unblocked_items`.
4. Return the snapshot. The runtime hands it to `ground` and `recall`.

## Invariants

- Perception MUST complete every cycle. No sense failure pauses the loop
  (spec FR-005).
- Perception MUST NOT make model calls. Unblock-condition tests are
  deterministic predicates (the test was written when the item was
  deferred); they are NOT LLM judgement.
- Perception MUST NOT advance a deferred item's state — that is the
  decide/jobs concern. It only reports the unblock.
- Sense reads MUST run in parallel; one slow sense MUST NOT serialise
  others. A per-sense timeout (default 5s, configurable) caps total
  observe duration.
