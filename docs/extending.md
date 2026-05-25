# Extending the lattice

Four extension points. Each requires writing roughly one file.

## 1. Adding a new Capability

A capability is a named tool the lattice may invoke. Add one by
implementing the `Capability` interface in `@runcor/capabilities`.

```ts
import type { Capability, PermissionContext, ObserveContext, ActContext } from '@runcor/capabilities';

export function makeGithubSense(token: string): Capability<never, { issues: number }> {
  return {
    name: 'github',
    description: 'Read this repo\'s open issue count.',
    role: { sense: true, action: false },
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
    isEnabled: () => true,
    canInvoke: (_ctx: PermissionContext) => ({ allow: true }),
    async read(ctx: ObserveContext) {
      const res = await fetch('https://api.github.com/repos/owner/repo/issues?state=open', {
        headers: { authorization: `token ${token}` },
        signal: ctx.abortSignal,
      });
      const issues = (await res.json()) as unknown[];
      return { issues: issues.length };
    },
  };
}
```

Register it in the manifest via `FactoryRegistry`:

```ts
const registry = new FactoryRegistry()
  .register('github', (entry) => makeGithubSense(entry.config?.token as string));
loadManifest({ entries: [{ name: 'github', kind: 'github', config: { token: '...' } }] }, registry);
```

Rules the runtime enforces (`validateCapability`):

- `role.sense + role.action >= 1` — must do something.
- Sense-only capabilities MUST be `readOnly: true` and
  `destructive: false`.
- A capability with `role.sense = true` MUST implement `read()`.
- A capability with `role.action = true` MUST implement `invoke()`.

Permission: the substrate calls `canInvoke()` before every action.
Return `{ allow: false, reason, escalate }` to block; the autonomy
dial determines whether the block escalates to the operator.

## 2. Adding a new ModelBackend

A backend implements `ModelBackend` in `@runcor/engine`.

```ts
import type {
  CostEstimate,
  ModelBackend,
  ModelCallRequest,
  ModelCallResult,
} from '@runcor/engine';
import { ModelBackendError } from '@runcor/engine';

export class MyBackend implements ModelBackend {
  readonly name = 'my-backend';

  async call(req: ModelCallRequest): Promise<ModelCallResult> {
    if (req.abortSignal?.aborted) throw new ModelBackendError('aborted', 'aborted');
    // ...your impl...
    return {
      text: '...',
      usage: { input: 0, output: 0 },
      modelUsed: 'my-model',
      finishReason: 'stop',
    };
  }

  estimateCost(_req: ModelCallRequest): CostEstimate {
    return { unit: 'usd', amount: 0.01, confidence: 'low' };
  }
}
```

Backends MUST:

- Take an `RppPrompt` (branded string from the substrate); do NOT
  parse or wrap the prompt yourself — the substrate's `wrap()` is
  the only legitimate producer.
- Honour `req.abortSignal`.
- Throw `ModelBackendError(kind='usage_limit', ...)` when the
  provider reports a usage / rate / plan limit — the runtime's
  handler defers active jobs gracefully.
- NOT read or write the SQLite file.

Plug into a lattice:

```ts
const lattice = new Lattice({
  // ...
  engine: new MyBackend(),
});
```

Or mid-flight: `lattice.setEngine(new MyBackend())`.

## 3. Adding a new SnapshotDestination

Implement `SnapshotDestination` from `@runcor/snapshot`.

```ts
import type { SnapshotDestination, SnapshotPutResult, SnapshotKey } from '@runcor/snapshot';

export class S3Destination implements SnapshotDestination {
  readonly name = 'aws-s3';

  constructor(private readonly bucket: string, private readonly prefix: string) {}

  async put(srcPath: string, key: string): Promise<SnapshotPutResult> {
    // ...your S3 upload...
    return { bytes: 0, destinationUri: `s3://${this.bucket}/${this.prefix}/${key}` };
  }

  async get(key: string, destPath: string) {
    /* ...download or return null... */
    return null;
  }

  async list(): Promise<SnapshotKey[]> {
    /* list objects */
    return [];
  }

  async delete(_key: string): Promise<void> {
    /* delete */
  }

  describe(): string {
    return `aws-s3://${this.bucket}/${this.prefix}`;
  }
}
```

Wire into the lattice via the snapshot module's `Snapshotter`. The
runtime polls the destination only on the snapshot cadence and on
graceful shutdown.

## 4. Adding a new prebuilt role

Drop **three files** into `prebuilt/<role>/`:

```text
prebuilt/customer-success/
├── seed-prompt.rpp          # R++ identity block
├── starting-knowledge.json  # identity[] + semantic[] memory rows
└── defaults.json            # dial defaults + tool_manifest
```

That's it. The Bridge's `BundleLoader` picks the new role up the
next time it loads. No code change.

See `prebuilt/_meta/README.md` and any existing role
(`prebuilt/ceo/`, `prebuilt/cfo/`) for the format.

## 5. Adding a new sweep rule (subconscious)

The subconscious sweep ships with three rules
(`orphan_index_row`, `stale_semantic_marker`, `ambiguous_semantic`).
Add more by implementing `SweepRule` from `@runcor/memory`:

```ts
import type { SweepRule, SweepCandidate } from '@runcor/memory';

export const myRule: SweepRule = {
  name: 'duplicate_skill_descriptions',
  detect(db) {
    // ...query for the flat condition...
    return [/* candidates */];
  },
  canAct(_c: SweepCandidate) {
    return true; // false if disambiguation requires judgement
  },
  apply(db, c, ctx) {
    /* fix it */
  },
};
```

Pass into `runSubconsciousSweep(db, ctx, [...DEFAULT_RULES, myRule])`
when wiring the runtime — or replace the runtime's default
sweep-rule list at composition time.

**Rule:** if the fix needs judgement, set `canAct = false`. The
sweep will detect + trace but not act, and the work layer (decide)
will see it next cycle. This is constitution Principle V — code for
flat, LLM for judgement, never mixed.

## 6. Replacing the decider

The default is `SingleModelDecider`. The dialectic decider ships
with the build. For a custom decider:

```ts
import type { Decider, DecideRequest, DecideResult } from '@runcor/decider';

export class MyDecider implements Decider {
  readonly name = 'my-decider';
  async decide(req: DecideRequest): Promise<DecideResult> {
    // ...your impl, must return parser-validated R++...
  }
}
```

Pass at instantiation:

```ts
new Lattice({ /* ... */, decider: new MyDecider() });
```

The decider's input is `RppPrompt` (the substrate-wrapped prompt).
The output's `ParseResult` MUST come from `@runcor/rpp-parser.parse()`
— use `isValidR(parseResult)` to confirm. The runtime's decide
phase trusts the decider; if you return invalid R++, the cycle
fails at decide.

## What NOT to add

Per the constitution:

- A separate per-package SQLite file. The single file is the entity.
- A scheduler in the runtime. Direction is judgement.
- A way for the lattice to read or disable its own substrate.
- An LLM call that bypasses R++ structure or `wrap()`.
- A second decider class that calls `engine.call()` with a raw
  string prompt — the engine signature is `RppPrompt`-typed
  precisely to make this a compile error.

All of those would violate a NON-NEGOTIABLE principle.
