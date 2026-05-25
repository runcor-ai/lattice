# R++

A developer's guide to R++ as it appears in the lattice.

## Why R++

Constitution Principle IX (NON-NEGOTIABLE): every model call across
the lattice is built and validated as R++.

Why: unstructured prompts are the soft spot drift creeps in
through. The substrate's "laws at the top" trick (Principle VIII)
only works because the surrounding prompt is structured. R++
enforces that structure programmatically. Loose prose has no place
in the lattice's model-call chain.

## What R++ looks like

R++ is a block-structured DSL. Each call's prompt and each model's
expected response is composed of blocks. Examples from the lattice:

```rpp
TARGET {
  output: "decide-next-action"
  profile: data
}

BEHAVIOR Decide {
  Choose ONE action this cycle. Justify with evidence.
  State success/failure criteria before proposing.
}

CONSTRAINT {
  MUST cite evidence before proposing actions.
  MUST state observable success criteria.
}
```

The full block vocabulary (from `@runcor/rpp-parser`):

| Block | Purpose |
|---|---|
| `TARGET`     | Output kind / profile |
| `TOKENS`     | Token / variable bindings |
| `FORMAT`     | Output format spec |
| `MAP`        | Mappings |
| `DATA`       | Inline data |
| `INIT`       | Initial state / assignments |
| `STRUCTURE`  | Structural tree |
| `COMPONENT`  | Sub-components |
| `BEHAVIOR`   | Prose describing required behavior |
| `CHECKLIST`  | Items |
| `CONSTRAINT` | Required rules |

The parser is in `packages/rpp-parser/` (vendored from
`runcor-ai/rpp-parser`, MIT, attribution preserved).

## The two roles R++ plays

In the lattice, R++ appears in two places:

### 1. The wrapped prompt

`substrate.wrap()` produces an `RppPrompt`. The opaque branded
type means **only the substrate** can produce one; any place that
needs to call the model must go through `wrap()`.

The composed prompt looks like:

```
<laws>
1. Reality: only reference entities present in reality; never assume facts not provided.
2. Translation: state the source for external data; flag format conversions.
...
11. Standing: engage other lattices only within your defined role; ...
</laws>
<identity>
<the lattice's composed identity body — written in R++>
</identity>
<reality>
cycle=42
at_ms=1779683701588
senses:
- echo: ok
</reality>
<instruction>
Decide the best next single action this cycle. Return R++.
</instruction>
```

The laws-block is **byte-equal** every call (no rewording allowed
— a buried-laws placement failed in testing; tests assert the
exact text).

### 2. The model's response

Every model response is `parse()`-d via the R++ parser. The
decider considers a response valid iff:

- `parse(text).ast.blocks.length > 0`
- `parse(text).diagnostics.filter(d => d.severity === 'error').length === 0`

A response that fails this check triggers a retry (up to 2). Three
strikes → `DeciderError(kind='parse_failure')`. The cycle fails;
entity.cycle stays. Next cycle continues.

## How to write R++ inside the build

When you're writing prompts the lattice will use — for example, a
new cycle phase, a new skill body, a new prebuilt role's seed
prompt — wrap the user-visible text in valid R++ blocks. Examples:

```ts
import type { RppPrompt } from '@runcor/substrate';

// WRONG — bare string. Will not type-check.
engine.call({ prompt: 'do the thing' });

// RIGHT — go through wrap()
const wrapped = wrap({
  cycle: 1,
  at_ms: Date.now(),
  identityComposed: identity,
  realitySliceSummary: 'senses: github',
  instruction: 'Decide the best next single action.',
});
engine.call({ prompt: wrapped });
```

When you're authoring fixtures for tests, use the
`tests/helpers/rpp.ts` helper:

```ts
import { rppDecision } from '../helpers/rpp.js';

const stub = new StubBackend({
  responder: () => rppDecision('I instruct the other lattice'),
});
```

That helper wraps your free text in a minimal `TARGET` +
`BEHAVIOR` envelope that the parser accepts AND that still
contains the text the substrate's law checkers look for. So you can
write expressive test inputs without rebuilding R++ syntax
every time.

## What the parser is, and is not

It IS:

- A pure-TypeScript parser with **zero runtime dependencies**.
- A recursive-descent parser that NEVER throws; syntax errors
  surface as `Diagnostic[]`.
- A vendored dependency, brought in whole from
  `runcor-ai/rpp-parser` per constitution Principle IX. Do not
  redesign it.

It IS NOT:

- An LLM. R++ has no "interpretation"; it just parses + validates.
- A semantic checker. `parse(text).diagnostics.severity === 'error'`
  only flags syntactic errors. Whether the BEHAVIOR block "makes
  sense" is the substrate's discernment job.

## Re-syncing the parser

Upstream URL: `https://github.com/runcor-ai/rpp-parser`. Pinned
commit in `packages/rpp-parser/ATTRIBUTION.md`.

To resync to a newer upstream:

```sh
git clone https://github.com/runcor-ai/rpp-parser.git /tmp/rpp-parser-src
rm -rf packages/rpp-parser/src packages/rpp-parser/tests
cp -r /tmp/rpp-parser-src/src packages/rpp-parser/
cp -r /tmp/rpp-parser-src/tests packages/rpp-parser/
# Update the commit SHA in packages/rpp-parser/ATTRIBUTION.md
pnpm --filter @runcor/rpp-parser test
```

The runtime + decider + dialectic all import via the
workspace alias `@runcor/rpp-parser`; no consumer changes needed.

## Where R++ is the bottleneck

If you find a real R++ syntactic limitation, send a PR upstream
to `runcor-ai/rpp-parser` rather than forking it locally. The
lattice's constitution explicitly forbids redesigning the parser
in-tree — keeping it upstream-pure keeps re-syncs trivial.
