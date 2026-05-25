# Contract: Capability

A capability is a named tool the lattice may invoke (intent §15). Capabilities
reach the world via MCP or API. Each capability is marked as a **sense**
(read in `observe`), an **action** (invoked in `act`), or **both**.

The contract is richer than `{name, description, handler}` — it
distinguishes role, side-effects, and concurrency safety up front.

```ts
// packages/capabilities/src/types.ts

import { z } from 'zod';

export interface Capability<I, O> {
  readonly name: string;
  readonly description: string;     // surfaced to the model in decide
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema?: z.ZodType<O>;

  /** Tool taxonomy — required by the Tool contract pattern */
  readonly role: { sense: boolean; action: boolean };  // at least one true
  readonly readOnly: boolean;       // sense-only capabilities MUST be readOnly: true
  readonly destructive: boolean;    // true if irreversible side effect
  readonly concurrencySafe: boolean;

  /** May change at runtime; substrate may flip this */
  isEnabled(): boolean;

  /** Permission hook — called by the substrate before action invocation */
  canInvoke(ctx: PermissionContext): PermissionResult;

  /** Sense channel: cheap, idempotent, read-only. Called in observe. */
  read?(ctx: ObserveContext): Promise<O>;

  /** Action channel: invoked at most once per cycle in act. */
  invoke?(input: I, ctx: ActContext): Promise<O>;

  /** Called when the cycle is aborted mid-invoke. */
  onAbort?(): void;
}

export interface PermissionContext {
  cycle: number;
  autonomy: 'low' | 'medium' | 'high';
  budgetRemaining: number;
}

export type PermissionResult =
  | { allow: true }
  | { allow: false; reason: string; escalate: boolean };

export interface ObserveContext {
  cycle: number;
  lastReadAtMs: number | null;     // for "what is new" queries
  abortSignal: AbortSignal;
}

export interface ActContext extends ObserveContext {
  trace: Trace;                    // act records to trace itself
}
```

## Invariants

- A capability with `role.sense = true` MUST implement `read`.
- A capability with `role.action = true` MUST implement `invoke`.
- A capability with `role.sense = true` AND `role.action = true` MUST
  implement both, and the channels MUST not write shared state in ways
  that collide on the same cycle (spec FR-042).
- `read()` MUST be cheap and idempotent. The `observe` phase calls every
  enabled sense every cycle.
- `invoke()` is called by the `act` phase at most once per cycle (spec
  FR-004).
- A sense-only capability (`role.action = false`) MUST have `readOnly:
  true` AND `destructive: false`.
- The substrate calls `canInvoke()` before every action; a deny result is
  treated as a `block` outcome.
- The capability MUST NOT call the substrate or the decider directly.

## Tool discovery

Tools added at instantiation come from the manifest. Tools added later
come from the MCP Registry via:

```ts
export interface ToolDiscovery {
  /**
   * Query the official MCP Registry for candidates matching a description.
   * Each candidate is run through the substrate's `assessCapability()`
   * filter before being returned.
   */
  search(query: string, ctx: DiscoveryContext): Promise<CapabilityCandidate[]>;

  /**
   * Adopt a candidate into the manifest (subject to autonomy + substrate).
   */
  adopt(candidate: CapabilityCandidate, ctx: DiscoveryContext): Promise<AdoptResult>;
}

export interface CapabilityCandidate {
  candidateId: string;
  name: string;
  description: string;
  mcpServerUri: string;
  proposedRole: { sense: boolean; action: boolean };
  substrateAssessment: 'pass' | 'reject';
  rejectReason?: string;
}
```

Discovery is governed (spec FR-043) — substrate vetoes before manifest
update.

## Sense failure behaviour (spec FR-005)

If `read()` throws or times out, the observe phase MUST:

1. Log the failure to operational logs (pino).
2. Write a `trace` entry: `{ kind: 'observe', cycle, sense: name, result: 'failed', reason: ... }`.
3. Mark the sense's last-known cached state as stale in the cycle's reality slice.
4. Continue the cycle. A single failing sense MUST NOT pause the loop.
