<!--
SYNC IMPACT REPORT
==================
Version change: (initial) → 1.0.0
Ratification: 2026-05-24

Modified principles:
- (none; initial constitution)

Added sections:
- Core Principles I–XIV (encoded from intent spec §2 + §20 pinned list)
- Technology Stack (encoded from intent spec §17, §22, §25)
- Development Workflow (Spec-Driven Development per §22; testing per §24)
- Governance (amendment, versioning, compliance review)

Removed sections:
- (none)

Templates requiring updates:
- .specify/templates/plan-template.md — ✅ no change needed; its "Constitution
  Check" section is filled per-feature by /speckit-plan from this constitution
- .specify/templates/spec-template.md — ✅ no change needed; structure
  compatible with the lattice's feature decomposition
- .specify/templates/tasks-template.md — ✅ no change needed; the §23 build
  order maps cleanly onto user-story-prioritized task phases
- .claude/skills/*/SKILL.md — ✅ no change needed; skill instructions reference
  this file by path

Follow-up TODOs:
- None deferred. Bridge licensing — flagged in intent §22 step 4 as a
  /speckit-clarify target — will be resolved during the clarify pass against
  the functional spec, not in the constitution.
-->

# Runcor Lattice Constitution

A lattice is **one autonomous cognitive entity**: a single running entity with a
persistent mind that operates on its own, continuously, over long time horizons.
The rules below are what the build must not violate. Decisions marked
**(NON-NEGOTIABLE)** or **(PINNED)** override any conflicting guidance in any
other artifact.

## Core Principles

### I. Entity Is the Container, Not the Engagement (NON-NEGOTIABLE)

The lattice MUST run continuously. Discrete jobs (write a charter, produce a
plan, hold a conversation) are nested INSIDE the entity's ongoing life — they
have a finish line; the entity does not. "Done" applies to jobs, never to the
entity. The fast-clock loop MUST NOT contain an `engagement complete → exit`
condition. The entity stops only when a human deliberately stops it.

**Rationale**: A lattice models a human professional, not a script. Building
job-completion into the loop's exit path destroys the entity's continuous life.

### II. The Running Program Is Disposable; the Database IS the Entity (NON-NEGOTIABLE)

The entity's continuity MUST be database continuity, not process continuity. The
lattice runtime MUST resume on the very next cycle after restart, with state
indistinguishable from the moment before stop. SQLite is the entity store; the
single SQLite file *is* the entity (memory, identity, plan, skills, all of it).
A swappable snapshot module MUST give that file durability across machine wipes
and redeployments, without coupling the lattice to any one storage backend.
Interruptions MUST NOT matter.

**Rationale**: Real machines reboot. "Runs forever" means the entity is
continuous even though the program is not. Without resume parity, the entity
is an illusion that dies at every restart.

### III. The Lattice Steers Itself by Judgement

The lattice MUST infer what to do next, every cycle, by judgement — based on
what kind of entity it is and what is currently in front of it. A human handing
it a job, or a plan list, are INPUTS the entity weighs, not instructions it
obeys. The runtime MUST NOT contain a baked-in task scheduler. Direction
emerges from identity + goals + drives + temporal pressure + perceived reality.

**Rationale**: A scripted agent is not an entity. Scripting the lattice's next
move collapses it into the framework the rest of this constitution rejects.

### IV. Memory Is Drift Control

Memory MUST be organised as four genuinely separate systems with distinct
survival rules:

1. **Identity** — what the entity is. PERMANENT. Immune to the decay formula.
2. **Plan** — where the entity is going. Rewritable but never evaporates.
3. **Episodic** — what happened, in order. Decays per the formula below.
4. **Semantic** — settled facts and rules. Persists, must be correctable when
   a fact goes stale (the subconscious sweep handles this — see Principle V).

These MUST NOT be collapsed into a single decaying store.

The episodic decay formula MUST be reproduced exactly, never reinvented:

```
M = R × ln(f + 1) × e^(-t / (τ × D))
```

Default thresholds: `M < 0.05` → forget; `M > 0.6` → promote (with
compression). `τ`, `D`, and the thresholds are operator dials.

**Rationale**: Drift is prevented by always having the right context in front
of the entity, not by a checker that catches wandering. The four-system
shape and the decay formula are the mechanism. Recall is index-plus-cheap-
selector by default; a vector engine MAY be added later behind the same
interface.

### V. Two Tools for Two Kinds of Problem (NON-NEGOTIABLE)

Flat, mechanical problems MUST be solved by deterministic code (the
subconscious — every cycle, cheap, narrow). Genuine judgement MUST be done by
an LLM reasoning pass (the work layer and the slow-clock sleep pass). Using an
LLM for a flat problem, or code for a judgement problem, is forbidden.

The subconscious, when it acts, MUST do three things together: fix the
problem, flag it so the same cycle's judgement knows a correction occurred,
and write the change to the trace. It MUST NEVER touch anything requiring a
judgement call — that is the work layer's job.

**Rationale**: This is the RUN 4 lesson. Deterministic correction was
rock-solid; LLM-routed correction of the same flat problem was wildly
unstable. The asymmetry is the design.

### VI. The Eight Cycle Phases, In Order (PINNED)

One cycle is one pass through these eight phases, in this exact order:

```
observe → ground → recall → decide → act → judge → write → pulse
```

- `observe`: automatic perception of what is new since last cycle (not
  optional, not a capability the lattice chooses).
- `ground`: substrate wraps the call — eleven laws at the TOP, identity
  prior (drawn from identity memory), reality slice, cycle instruction.
- `recall`: pull the few relevant memories and active skills, not everything.
- `decide`: reason about the best next move.
- `act`: execute at most ONE capability per cycle.
- `judge`: per-cycle substrate discernment on what was just produced.
- `write`: record the cycle to memory with the appropriate survival rule;
  apply the subconscious sweep.
- `pulse`: update drives; hand off to the next cycle. NO "engagement
  complete" exit.

Phase order and the at-most-one-action-per-cycle rule MUST NOT change.

### VII. Two Clocks; Slow-Clock Cadence Is Counted in Cycles (PINNED)

The lattice MUST run as two separate programs sharing one SQLite file under a
lock:

- **Fast clock** — the main loop, running the eight phases continuously.
- **Slow clock** — a separate background worker that wakes every N cycles,
  consolidates memory ("the dream") and runs the LLM drift review, then
  sleeps.

The slow clock MUST fire on cycle count, not wall-clock time. Cadence MUST be
load-aware (heavier recent activity shortens the interval; quieter activity
lengthens it), with a baseline of roughly every 100 cycles. The operator can
override via the `reviewCadence` dial. Both programs MUST get the
resume-on-restart behaviour of Principle II.

When the slow clock finds drift, it MUST write a correction into memory; it
MUST NOT reach into the running loop. The fast loop picks it up on the next
cycle, the same way it reads everything else.

### VIII. The Substrate Is Enforced Physics (NON-NEGOTIABLE)

The substrate MUST wrap every model call. The entity MUST NOT be able to see,
read, configure, or bypass its own substrate — it is physics, not advice.

**Eleven declarative laws** MUST sit compiled at the TOP of every prompt (a
buried-laws placement failed in testing; top placement fixed it). They are
failure modes, not principles, and MUST NOT be reworded or re-derived:

1. **Reality** — only reference entities present in reality; never assume
   facts not provided.
2. **Translation** — state the source for external data; flag format
   conversions.
3. **Judgment** — state evidence before proposing actions; no unsupported
   pattern matching.
4. **Constraint** — follow the agent spec exactly; no deviations.
5. **Feedback** — state observable success/failure criteria for every
   proposed action.
6. **Memory** — reference relevant memories; state explicitly if none exist.
7. **Compounding** — prefer the current strategy; justify any direction
   change.
8. **Cost-Value** — state action cost; recommend lower-cost alternatives at
   80%+ outcome.
9. **Simplicity** — choose the fewest dependencies; justify added complexity.
10. **Uncertainty** — state confidence levels; flag data gaps; never assume.
11. **Standing** — engage other lattices only within your defined role;
    discovering a peer is not licence to direct, interrupt, or pull on it; act
    within your place in the structure.

The discernment gate evaluates outputs against the laws (code-first, LLM only
where code is inconclusive). Four outcomes: **pass**, **modify**, **block**,
**escalate**. Reality and Constraint violations are critical and always
block; Uncertainty is a warning; Simplicity is advisory and never blocks.

Discernment and the autonomy dial are ONE system: discernment detects;
autonomy decides what happens to the flag (self-correct at high autonomy,
escalate at low). Neither replaces the other.

### IX. R++ for Every Model Call (NON-NEGOTIABLE)

EVERY model call the lattice makes MUST be built and validated as R++ via the
`rpp-parser`. No exceptions, no silent prose anywhere. This includes:

- the `decide` phase,
- the `ground` wrap,
- skill synthesis,
- identity's reflective update,
- goal proposal,
- the slow-clock sleep pass,
- the slow-clock drift review,
- and any future component that calls a model.

The `rpp-parser` is pure TypeScript with zero runtime dependencies; it MUST
be brought in whole from `runcor-ai/rpp-parser` and MUST NOT be redesigned.

**Rationale**: Unstructured prompts are the soft spot drift creeps in
through. The laws-at-the-top fix only works because the surrounding prompt is
structured. R++ enforces that structure programmatically.

### X. Trace Is Mandatory

Every cycle, every subconscious correction, every decision MUST be recorded
to an auditable JSONL transcript plus an indexed store the Bridge can read.
The trace is the operator's primary debugging surface and the only thing that
makes the entity's behaviour verifiable rather than asserted.

The trace MUST be distinct from operational logs: logs are diagnostics; the
trace is the cognitive record.

### XI. Modular and Swappable

Each major part MUST sit behind a small interface with a default
implementation, selected at instantiation. At minimum the following MUST be
swappable without surgery elsewhere:

- The **decider** — single-model and multi-model dialectic, both BUILT and
  WIRED; the Bridge dial selects per lattice.
- The **model backend** — direct API and host-CLI, both BUILT and WIRED;
  the engine routes; the lattice itself is unaware which backend is active.
- The **snapshot destination** — local folder, cloud bucket, or other —
  swappable without touching the lattice.
- Perception and action connectors — each connection can be wired as a
  sense, a tool, or both.

"Selectable at instantiation" means a Bridge dial chooses; it does NOT mean
"build later." Both deciders and both model backends are required core.

### XII. The Admission Rule for Memory (PINNED)

A thing becomes a memory ONLY if it cannot be reconstructed from the live
world. Anything the lattice can perceive again next cycle — a file's
contents, a tracker's state, code structure — MUST NEVER be stored as memory;
it MUST be re-perceived, fresh, every time. Memory is reserved for what would
genuinely be lost otherwise: decisions, the reasons behind them, guidance
received, who is doing what and why.

This rule MUST be applied as a gate in front of all four memory systems.
Every stored memory MUST keep its "why", not just its "what". Relative dates
in incoming data MUST be converted to absolute dates on write.

### XIII. Job Completion Is a Layer with Deferral

A job is NOT done because an artifact was produced. A job is done only when
its own completion checks pass.

Each job MUST be broken into a checklist. Each item MUST carry a completion
check structured as a layer: deterministic hooks where possible (by default
and as many as the job allows) plus a judgement pass for the irreducible
remainder. An item MUST NOT be marked passed except by its check actually
passing.

Failed checks MUST iterate: the lattice keeps the item open, fixes what
failed, and re-runs the check.

**Deferral** is the escape hatch. A deferred item MUST record:

- a **valid reason**, grounded in something real and external (genuine
  blocker, missing dependency, contradiction in source material) — NEVER
  "this was hard" or "I judged it unnecessary";
- an **unblock condition** — what must become true for the item to be
  revisitable.

Perception (`observe`) MUST notice when an unblock condition is met; the item
then becomes live work again.

Jobs MAY close as partially complete: passed items count; deferred items
persist in the plan memory and are carried forward. Sign-off — both job
completion and deferral certification — follows the autonomy dial (Principle
XI's modularity and Principle VIII's discernment/autonomy coupling).

Every completion, deferral, and unblock MUST be written to the trace.

### XIV. No Shared Memory Between Lattices (NON-NEGOTIABLE)

Every lattice owns its own single SQLite file, completely. Lattices MUST NEVER
reach into each other's memory and MUST NEVER co-hold anything. Collaboration
is something that passes BETWEEN lattices, never something they jointly hold.

The three permitted forms of collaboration:

1. **Conversation** — a lattice exposes itself over MCP; a back-and-forth
   sits on the calling lattice's plan as a job, its loop keeps turning, and
   if the peer goes quiet the conversation job DEFERS (per Principle XIII)
   rather than blocking. Memory of the conversation lives in each lattice's
   own store, in its own words. There is no central transcript.
2. **Delegation** — one lattice owns a plan and hands pieces out as jobs to
   other lattices. The plan always has exactly one owner.
3. **A read-only shared source of truth** — an external service all members
   READ but never write. It is reference material, not shared memory.

Peer discovery uses a registry (the lattice is told its address at
instantiation; lattices self-register their one-sentence essence on startup;
peers are read on the slow cycle). The registry tells a lattice who EXISTS;
whether it MAY engage is governed by its identity and Law 11 (Standing) —
NOT by gatekeeping the directory.

## Technology Stack

The following choices are pinned by intent spec §17, §22, and §25. Substitutions
are permitted only with a clearly stated reason (better fit, maintenance
concern, licensing issue) and MUST be recorded.

- **Language / Runtime**: TypeScript on Node (22+).
- **Monorepo**: pnpm workspaces, optionally with `turborepo` for task
  orchestration across packages.
- **Entity store**: `better-sqlite3` (synchronous, prebuilt binaries, fast).
- **Bridge HTTP API**: `fastify` with schema-based validation.
- **Bridge UI**: Vue 3 + `vite` + `pinia`.
- **Runtime validation**: `zod` at every untrusted boundary (config, MCP
  messages, external input).
- **MCP**: `@modelcontextprotocol/sdk`. Tool discovery via the official MCP
  Registry; baseline servers via `modelcontextprotocol/servers`.
- **Model provider access**: official provider SDKs (Anthropic, OpenAI, …)
  behind the engine's swappable backend interface. The host-CLI backend
  drives a coding-agent CLI on the operator's machine directly.
- **Testing**: `vitest`.
- **Operational logging**: `pino` — distinct from the cognitive trace
  (Principle X).
- **R++ parser**: brought in whole from `runcor-ai/rpp-parser`; pure
  TypeScript, zero runtime dependencies; MUST NOT be redesigned.
- **Optional semantic search** (deferred until needed): `sqlite-vec` keeps
  vectors INSIDE the SQLite file, preserving the self-contained property.
  No third-party "agent memory" framework MAY be adopted — it would
  conflict with the four-system memory design.

"Self-contained" applies to the cognitive parts (loop, substrate, memory
logic). It does NOT mean hand-writing infrastructure that well-maintained
libraries already provide.

## Development Workflow

### Spec-Driven Development (Spec Kit)

Every feature MUST progress through the Spec Kit workflow, in order:

1. `/speckit-constitution` — establish or amend the rules.
2. `/speckit-specify` — write the functional spec (behaviour, not
   implementation).
3. `/speckit-clarify` — resolve underspecified items before planning.
4. `/speckit-plan` — produce the technical plan.
5. `/speckit-tasks` — generate the dependency-ordered task breakdown.
6. `/speckit-analyze` — cross-artifact consistency check BEFORE implementing.
7. `/speckit-implement` — execute the tasks.

The intent spec §23 build order (15 vertical slices) MUST be the sequencing
discipline for /speckit-tasks output. Each slice MUST leave the system
runnable.

### Testing Discipline

Each build-order step is DONE only when its tests pass. Tests MUST land
alongside the code that exercises them, not after. The suite MUST cover, at
minimum (intent spec §24):

- the loop turns through all eight phases in order;
- **resume parity**: a lattice stopped mid-run restores its exact state and
  continues on the next cycle (the spine of the entity model);
- the substrate enforces — known-bad outputs are rejected, not merely
  logged; the entity cannot read or disable its substrate;
- memory behaviour — decay thresholds, identity permanence, admission rule;
- job completion and deferral semantics, including skill minting from
  partially-completed jobs;
- the slow clock wakes on cadence, runs consolidation and drift review, and
  writes corrections into memory without interrupting the loop.

### Engineering Latitude

Everything not specified above is engineering judgement: file and package
layout, class and interface design, library choices for plumbing not listed
in Technology Stack, how the snapshot module is implemented, how perception
connections are registered, how the trace store is indexed, test structure.
Build it well; do not ask permission for ordinary engineering decisions.

## Governance

This constitution supersedes any conflicting guidance in any other artifact
in this repository, including the intent spec, the older build spec, and
the runcor reference repos. Where this constitution and any other document
disagree, this constitution wins.

**Amendment procedure**: amendments are made via `/speckit-constitution`.
Every amendment MUST update the Sync Impact Report at the top of this file,
bump the version per the rules below, and propagate to the templates listed
in the report.

**Versioning policy** (semantic):

- **MAJOR**: backward-incompatible removal or redefinition of a principle
  or governance rule.
- **MINOR**: a new principle or section is added, or material guidance is
  expanded.
- **PATCH**: clarifications, wording fixes, non-semantic refinements.

**Compliance review**: `/speckit-plan` MUST gate against this constitution
in its "Constitution Check" section before any Phase 0 research, and
re-check after Phase 1 design. `/speckit-analyze` MUST cross-check the
generated tasks against these principles before implementation begins. Any
violation MUST appear in the plan's "Complexity Tracking" table with a
written justification, or the plan MUST be revised to remove the violation.

The autonomy dial governs runtime sign-off for jobs and deferrals;
constitutional compliance is operator-supervised at the design layer (this
workflow), not deferred to runtime discretion.

**Version**: 1.0.0 | **Ratified**: 2026-05-24 | **Last Amended**: 2026-05-24
