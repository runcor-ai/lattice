# Implementation Plan: Lattice Core

**Branch**: `001-lattice-core` | **Date**: 2026-05-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-lattice-core/spec.md`

## Summary

Build the Runcor Lattice — one autonomous cognitive entity that runs
continuously over long horizons, driving an LLM through the eight-phase cycle
(`observe → ground → recall → decide → act → judge → write → pulse`), governed
by an enforced substrate of eleven laws, supported by four distinct memory
systems, persisted as a single SQLite file per lattice, and operable via a
Vue 3 Bridge that lets a single local operator instantiate, observe, and
adjust running lattices.

The codebase is a TypeScript/Node 22 monorepo (pnpm workspaces + optional
turborepo). The lattice runtime is a library composed of ~17 cognitive
packages (substrate, memory, identity, goals, drives, temporal, jobs, two
deciders, watchdog, skills, trace, capabilities, snapshot, collaboration,
runtime, engine) plus the vendored `rpp-parser`. The runtime is driven by two
separate OS processes per lattice — `apps/lattice` (the fast clock) and
`apps/slowclock` (the slow clock) — sharing one SQLite file under a lock
file. The Bridge is two apps: `bridge-api` (Fastify) and `bridge-ui` (Vue 3
+ Vite + Pinia). Every model call is built and validated as R++ via the
parser; every cycle, correction, and decision is written to a JSONL trace
plus an in-SQLite indexed store. Snapshot durability and model backend are
both swappable behind small interfaces.

Build order follows the 15 vertical slices in intent spec §23 — each slice
leaves the system runnable and is "done" only when its tests pass. Slice 1
is "one cycle end-to-end" with stubs everywhere; subsequent slices fill in
real implementations.

## Technical Context

**Language/Version**: TypeScript 5.x on Node 22 LTS. ESM modules across the
monorepo. Strict TypeScript mode (`strict: true`, `noUncheckedIndexedAccess:
true`).

**Primary Dependencies**:
- pnpm workspaces (monorepo) + turborepo (task orchestration)
- `better-sqlite3` ^11 (entity store; synchronous, fast, prebuilt binaries)
- `fastify` ^5 (Bridge HTTP API, schema-validated)
- `zod` ^3 (runtime validation at every untrusted boundary)
- `@modelcontextprotocol/sdk` ^1 (MCP perception/action + self-exposure +
  registry queries)
- `@anthropic-ai/sdk` ^0.x (direct-API model backend default)
- `vitest` ^2 (test runner, TypeScript-native)
- `pino` ^9 (operational logging — distinct from the cognitive trace)
- Vue 3 ^3.5, `vite` ^5, `pinia` ^2 (Bridge UI)
- The `rpp-parser` (vendored from `runcor-ai/rpp-parser`; pure TS, zero deps;
  attributed in `packages/rpp-parser/ATTRIBUTION.md`)

**Storage**: SQLite via `better-sqlite3`. One file per lattice IS the entity
(constitution Principle II). All persistent state — identity, plan, episodic
memory, semantic memory, skills, cycle counter, dial positions, deferred
items, the trace's indexed store — lives in the single file. WAL mode for
crash safety. Snapshot durability is provided by a swappable module
(`packages/snapshot`) with default destination = local folder; a cloud-
bucket adapter ships as a v1 follow-up behind the same interface.

**Testing**: `vitest` with three layers:
- Unit tests live next to their source (`*.test.ts` colocated).
- Integration tests in `tests/integration/` exercise multi-package flows
  (loop turns, resume parity, two-clock interaction, substrate
  enforcement).
- E2E tests in `tests/e2e/` drive the full stack via the Bridge HTTP API
  and a headless Vue runner.

Each build-order step is done when its tests pass (constitution Testing
Discipline section). The resume-parity test is the single most important
test in the suite (per intent spec §24 + constitution Principle II).

**Target Platform**: Cross-platform Node 22 (Windows 11, macOS 13+,
Ubuntu 22.04+). Bridge UI runs in any modern browser served locally by the
Bridge HTTP server on `127.0.0.1:<port>`. No remote deployment in v1.

**Project Type**: TypeScript monorepo with packages + apps. The lattice
runtime is a composed library (~17 packages). The Bridge is two apps
(API + UI). Two CLI apps drive a lattice (`lattice`, `slowclock`).

**Performance Goals** (from spec Success Criteria):
- SC-001: ≥1,000 cycles unattended.
- SC-002: Resume within 5 seconds with logical-state equality.
- SC-003: Slow-clock cadence within ±10% of target (baseline ~100 cycles).
- SC-005: Single-lattice instantiation visible on roster in <10s.
- SC-006: Company of N lattices cycling within 5 minutes.
- SC-007: Deferred item live within 1 cycle of unblock detection.
- SC-008: Dial adjustment in effect within 2 cycles.

**Constraints**:
- Self-contained per intent §17: no external database service required to
  run a lattice; everything is in the SQLite file.
- MIT licensed (FR-057). `LICENSE` file at repo root.
- Single-tenant local-only Bridge (FR-055): binds to 127.0.0.1.
- Per-lattice-lifetime budget enforcement (FR-056).
- All eight cycle phases execute in pinned order (FR-001).
- Logical state equality on resume (FR-007, clarified 2026-05-24).
- Every model call wrapped by substrate + validated as R++ (FR-018, FR-024).
- No shared memory between lattices (FR-044/045; constitution XIV).
- Two clocks as separate processes sharing one SQLite under a lock file
  (constitution VII).

**Scale/Scope**:
- 14 constitution principles (4 NON-NEGOTIABLE).
- 57 functional requirements; 13 user stories at three priority levels;
  12 success criteria; 11 enumerated edge cases.
- 15 vertical slices per intent spec §23.
- ~17 packages + 4 apps + 2 test suites.
- Single-machine deployment is the primary target. Multi-lattice on one
  machine is supported (each owns its own SQLite file) but not the primary
  v1 ergonomics focus.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Plan Compliance | Notes |
|---|---|---|
| **I. Entity is the container** | ✅ | The fast-clock loop in `packages/runtime` contains no internal exit condition. `apps/lattice` exits only on operator stop or unrecoverable substrate fault. |
| **II. Database IS the entity** (NON-NEGOTIABLE) | ✅ | One `better-sqlite3` file per lattice. No package keeps side-databases. Snapshot module is the only thing that copies the file outward. |
| **III. Lattice steers itself by judgement** | ✅ | The runtime composes goals/drives/temporal/identity inputs into the `ground` and `recall` phases; `decide` is pure LLM judgement. No baked-in scheduler. |
| **IV. Memory is drift control** | ✅ | `packages/memory` exposes four genuinely separate stores (identity/plan/episodic/semantic) with distinct survival rules; episodic uses the exact decay formula. Recall = index-plus-selector by default. |
| **V. Two tools for two problems** (NON-NEGOTIABLE) | ✅ | See "Logic Classification" below. Discernment gate is code-first; the LLM fallback only fires where code is inconclusive. |
| **VI. Eight cycle phases in order** (PINNED) | ✅ | `packages/runtime/src/cycle.ts` exports a single `runCycle()` whose phase order is enforced by a type-level state machine (you can't call `decide` before `recall`). Tests assert order in trace entries. |
| **VII. Two clocks, cycle-count cadence** (PINNED) | ✅ | `apps/lattice` runs the fast clock; `apps/slowclock` is a separate process. They share one SQLite file. A `packages/runtime/src/lockfile.ts` primitive prevents two `lattice` processes on the same file. |
| **VIII. Substrate is enforced physics** (NON-NEGOTIABLE) | ✅ | `packages/substrate` exports `wrapCall(prompt) → guardedPrompt` and `discern(output) → outcome`. The lattice runtime calls model backends ONLY via the substrate-wrapped path. No `read` API. Skills cannot import the substrate package internals. |
| **IX. R++ for every model call** (NON-NEGOTIABLE) | ✅ | The model backend interface accepts a `RppPrompt` type built and validated by `packages/rpp-parser`. A `string` will not type-check. |
| **X. Trace is mandatory** | ✅ | `packages/trace` provides a `Trace` handle injected into every phase. JSONL writer + in-SQLite indexed store (one table). The Bridge reads the indexed store. |
| **XI. Modular and swappable** | ✅ | Interfaces declared in `contracts/`: `Decider`, `ModelBackend`, `SnapshotDestination`, `Capability`, `Perception`. Each has a default impl in its package. |
| **XII. Admission rule for memory** (PINNED) | ✅ | `packages/memory/src/admission.ts` is a gate function every write passes through. Tests assert re-perceivable facts are rejected. |
| **XIII. Job completion is a layer with deferral** | ✅ | `packages/jobs` models the checklist, completion checks, deferral with reason + unblock condition, partial completion. Sign-off path branches on the autonomy dial. |
| **XIV. No shared memory between lattices** (NON-NEGOTIABLE) | ✅ | Lattice instances are file-scoped; no global module state. Cross-lattice communication is via MCP only (`packages/collaboration`). |
| **Technology Stack** | ✅ | All listed dependencies match the constitution's pinned set. No substitutions in v1. |
| **Development Workflow** | ✅ | This very plan is the Spec Kit output. Tests land alongside code per Testing Discipline. |

### Logic Classification (constitution Principle V)

Per Principle V, every component must be classified as deterministic code OR
LLM judgement. The plan does this up front:

**Deterministic code (the subconscious + flat checks):**
- The discernment gate's per-law code checks (Reality, Translation,
  Constraint, Feedback, Memory, Compounding, Cost-Value, Simplicity → all
  code-first).
- The subconscious sweep in `write` phase.
- Completion-check deterministic hooks for job items.
- The admission rule (`packages/memory/src/admission.ts`).
- The episodic decay formula and threshold-based forget/promote.
- The lockfile primitive and snapshot transaction boundaries.
- R++ structural validation.
- The slow clock's cycle-count tick (not a wall-clock timer).
- Tool-discovery substrate-constraint matching (rule-based filter).

**LLM judgement (work layer + sleep + targeted gate fallback):**
- The `decide` phase (single-model or dialectic).
- The slow-clock memory consolidation pass ("the dream").
- The slow-clock drift review (and the watchdog's gap-detection it feeds).
- The discernment gate's LLM fallback when code is inconclusive.
- The completion-check judgement pass for irreducible items.
- Identity's reflective update.
- Goal proposal.
- Skill synthesis (specific + generic extractions).
- Recall's "which N memories are relevant" cheap selector pass.

Anything new added later must pick a side and justify it. Mixing is the
forbidden case per Principle V.

### Constitution Check verdict

✅ **PASS** — no violations identified at plan time. Complexity Tracking
table is empty.

A re-check is scheduled after Phase 1 design (data-model.md, contracts/);
the result is recorded at the bottom of this plan.

## Project Structure

### Documentation (this feature)

```text
specs/001-lattice-core/
├── plan.md              # This file
├── spec.md              # Functional spec (already written)
├── research.md          # Phase 0 output (written by this command)
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (interface contracts)
│   ├── decider.md
│   ├── model-backend.md
│   ├── snapshot-destination.md
│   ├── capability.md
│   ├── perception.md
│   ├── bridge-http-api.md
│   └── mcp-self-exposure.md
├── checklists/
│   └── requirements.md  # From /speckit-specify
└── tasks.md             # /speckit-tasks output (next)
```

### Source Code (repository root)

```text
runcor-lattice/
├── LICENSE                       # MIT
├── README.md
├── package.json                  # Workspace root
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
│
├── packages/
│   ├── rpp-parser/               # Vendored from runcor-ai/rpp-parser (MIT, attribution)
│   ├── substrate/                # 11 laws + discernment gate (Principle VIII)
│   ├── memory/                   # Four memory systems + decay formula + admission rule
│   ├── identity/                 # Identity memory + reflective update (uses decider)
│   ├── goals/                    # Discovered intention stack
│   ├── drives/                   # Motivational pulse (resource pressure, curiosity, reactivity, coherence)
│   ├── temporal/                 # Cycles-based deadlines and commitments
│   ├── decider/                  # Decider interface + single-model decider (default)
│   ├── dialectic/                # Multi-model decider (Player / Coach / Judge)
│   ├── watchdog/                 # Slow-clock-only outside observer (needs-vs-tools gap)
│   ├── skills/                   # Skill library, SKILL.md format, mint + recall
│   ├── trace/                    # JSONL transcript + in-SQLite indexed store
│   ├── engine/                   # Routing, retries, MCP plumbing, cost tracking,
│   │                             # swappable model backends (direct API + host-CLI)
│   ├── capabilities/             # MCP/API connectors, sense/action wiring, tool discovery,
│   │                             # MCP Registry client
│   ├── jobs/                     # Checklist, completion checks, deferral, partial completion
│   ├── collaboration/            # MCP self-exposure, peer registry, conversation/delegation,
│   │                             # read-only shared-source-of-truth client
│   ├── snapshot/                 # Swappable snapshot module (local folder default,
│   │                             # cloud-bucket adapter behind same interface)
│   ├── runtime/                  # The lattice runtime: composes the above, runs the fast clock,
│   │                             # owns cycle.ts (the eight-phase state machine),
│   │                             # owns lockfile.ts, owns graceful-shutdown registry
│   ├── slowclock/                # The slow-clock worker logic (consolidation + drift review)
│   └── bridge-shared/            # Types shared between bridge-api and bridge-ui (Pinia stores,
│                                 # zod schemas, instantiation form types, dial types)
│
├── apps/
│   ├── lattice/                  # CLI: `lattice start <config.json>`
│   │                             # Runs the fast clock for one lattice. Long-lived process.
│   ├── slowclock/                # CLI: `slowclock attach <sqlite-path>`
│   │                             # Runs the slow clock for one lattice. Separate process.
│   ├── bridge-api/               # Fastify server. Owns instantiation, roster, inspect, adjust.
│   │                             # Spawns `lattice` and `slowclock` child processes.
│   └── bridge-ui/                # Vue 3 + Vite + Pinia. Single-page app. Served by bridge-api.
│
├── prebuilt/                     # Slice-15 deliverable: prebuilt role lattices
│   ├── ceo/                      # Each role = seed-prompt.rpp + starting-knowledge.json +
│   ├── cfo/                      #   defaults.json (dial defaults + tool manifest)
│   ├── marketing/
│   └── sales/
│
├── tests/
│   ├── integration/              # Cross-package: loop turns, resume parity, two clocks,
│   │                             # substrate enforcement, memory decay, jobs + deferral,
│   │                             # skill mint + recall, collaboration
│   └── e2e/                      # Full stack: Bridge instantiates → cycles → operator adjusts
│
├── .specify/                     # Spec Kit scaffold (already in place)
├── .claude/                      # Operator skill (Anthropic skill format)
└── runcor-lattice-intent-spec.md # Source of truth
```

**Structure Decision**: Monorepo with `packages/` (libraries) + `apps/`
(executables) + `prebuilt/` (data) + `tests/` (integration & e2e),
selected for the following reasons:

1. **Principle XI (modular/swappable)** is satisfied at the package
   boundary: each major piece is a workspace package with its own
   interface, default impl, and tests. Swapping the decider, model
   backend, or snapshot destination touches one package, not the runtime.
2. **Principle II (single SQLite file)** is satisfied: every package
   takes a `Db` handle in its constructor; no package opens its own
   database connection at module-load time. The runtime opens the file
   once and passes the handle in.
3. **Principle VII (two processes)** is satisfied: `apps/lattice` and
   `apps/slowclock` are siblings sharing the same `packages/*`
   dependencies but running as separate Node processes, coordinated via
   the SQLite file + lockfile.
4. **Bridge ↔ runtime isolation**: the Bridge spawns `lattice` and
   `slowclock` as child processes; it doesn't import the runtime in-
   process. This keeps Principle XI honest at the runtime↔Bridge
   boundary too — a different Bridge could drive the same runtime by
   spawning the same CLI.
5. **`bridge-shared`** lets the Vue UI and the Fastify API agree on
   payload shapes via shared zod schemas without the UI bundling Node-
   only code.

## Complexity Tracking

> Constitution Check passed with no unjustified violations. Table empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| *(none)*  |            |                                      |

## Phase Outputs (this command)

Phase 0 — Research: see [`research.md`](./research.md). Reuse patterns and
attribution table for the runcor reference repos.

Phase 1 — Design & Contracts:
- [`data-model.md`](./data-model.md) — SQLite schema, JSONL trace shape,
  SKILL.md frontmatter, dial registry.
- [`contracts/`](./contracts) — small interfaces for decider, model backend,
  snapshot destination, capability, perception, Bridge HTTP API, and MCP
  self-exposure.
- [`quickstart.md`](./quickstart.md) — "how an operator instantiates a
  lattice in 60 seconds".

## Post-Design Constitution Re-Check

Re-evaluated after Phase 1 artifacts were written:

| Concern | Status |
|---|---|
| The contracts expose `RppPrompt` (not `string`) on every model-bearing interface | ✅ |
| The contracts give `Decider`, `ModelBackend`, `SnapshotDestination`, `Capability`, `Perception` each a single small interface with a default impl | ✅ |
| The data model puts every persistent surface (memory, plan, identity, skills, dials, trace index) inside one SQLite file per lattice | ✅ |
| The data model omits any cross-lattice table or shared schema | ✅ |
| The data model identifies the deterministic vs LLM logic at the table level (which rows are written by code, which by reasoning) | ✅ |
| The Bridge HTTP API surface contains only the four pinned operations (instantiate, roster, inspect, adjust) | ✅ |

✅ **PASS** post-design. Ready for `/speckit-tasks`.

## Next

Run `/speckit-tasks` to generate the dependency-ordered task breakdown
mapped to the intent spec §23 build-order slices.
