# Phase 0 Research — Lattice Core

This research consolidates what is already known from the intent spec and the
runcor reference repositories. It does not re-derive pinned decisions; it
records the provenance of patterns reused and the rationale for the few open
choices the plan resolves.

## 1. Engineering patterns adopted

Standard robustness primitives from long-running-loop and agent-runtime
literature: abort controllers for clean cancellation, lockfile coordination
for two processes sharing one SQLite file, ring-buffer for bounded in-memory
trace, graceful shutdown via SIGINT/SIGTERM handlers that flush + commit +
release before exit, threshold-plus-buffer with circuit-breaker for the
consolidation pass, index-plus-cheap-selector recall for the four memory
systems, side-query pattern for cheap off-loop model calls (recall selector,
skill-fit check), token budgeting per call, Zod-to-JSON-Schema conversion
for presenting tool input shapes to the model.

The lattice's package layout reflects the COGNITIVE LAYERS (substrate,
memory, jobs, capabilities, …) — not the patterns above. The patterns are
plumbing, used where they fit.

## 2. Logic ported from the runcor reference repos

The runcor org repos (`runcor-ai/*`) already implement parts of the
cognitive stack. Per intent spec §0, the lattice is a **fresh consolidated
monorepo**, not a clone — but reused logic with attribution is preferred
over redesign.

| Reference repo | Lattice target | Reuse strategy |
|---|---|---|
| `runcor-ai/rpp-parser` | `packages/rpp-parser` | **Vendored whole.** Pure TypeScript, zero deps. Copy the source under attribution; do not redesign. |
| `runcor-ai/rpp` (R++ language) | `packages/rpp-parser` (companion grammar / examples) | Source for language reference, examples used in tests. |
| `runcor-ai/runcor-substrate` | `packages/substrate` | Reuse the eleven-law compile-to-prompt-top logic and discernment-gate code-first checks. Adapt to TypeScript-strict + Zod for the prompt schema. |
| `runcor-ai/runcor-identity` | `packages/identity` | Reuse the self-theory artifact format (identity memory) and the reflective-update pass — adapted to use `Decider` interface, not the dialectic directly. |
| `runcor-ai/runcor-memory` | `packages/memory` | Reuse the cube/decay/plan machinery; reorganise into the **four-system shape** (identity / plan / episodic / semantic) per constitution Principle IV. Apply the admission rule (Principle XII) as a gate before any write. |
| `runcor-ai/runcor-goals` | `packages/goals` | Discovered-intention-stack logic; goal proposal via the decider. |
| `runcor-ai/runcor-drives` | `packages/drives` | Motivational-pulse functions; the four drives (resource pressure, curiosity, reactivity, coherence). |
| `runcor-ai/runcor-temporal` | `packages/temporal` | Deadlines and commitments in **cycles** (not wall-clock); pressure bands. |
| `runcor-ai/runcor-dialectic` | `packages/dialectic` | Multi-model decider: Player drafts → Coach challenges → Judge selects. Built and wired (constitution Principle XI). |
| `runcor-ai/runcor-watchdog` | `packages/watchdog` | Slow-clock-only outside observer; reads stated needs vs available tools vs what the entity did; emits findings into the correction path. |
| `runcor-ai/runcor-skills` | `packages/skills` | Skill library, specific-plus-generic extraction, SKILL.md format with R++ body. |
| `runcor-ai/runcor` (engine) | `packages/engine` | Routing, retries, MCP plumbing baseline. The swappable model backend interface is original to the lattice. |

**External, NOT bundled:**
- `runcor-ai/runcor-integration` (external DB-as-tools service)
- `runcor-ai/runcor-data` (external unstructured-data fabric)

Per intent §15, these are external services the lattice connects to as
ordinary capabilities; they do not live in this monorepo.

## 3. Open choices resolved

The constitution and the spec pin most of the technical decisions. The few
remaining choices are recorded here with rationale.

### 3.1 Why `better-sqlite3` over `node:sqlite` (Node 22's built-in)

| Decision | Use `better-sqlite3` ^11. |
|---|---|
| **Rationale** | Synchronous API (no callback/promise overhead per write), prebuilt binaries on the three target OSes, and a battle-tested track record. The lattice writes to SQLite on every cycle; sync calls avoid microtask churn in the hot loop. |
| **Alternatives considered** | (a) Node 22's built-in `node:sqlite` — promising but newer, fewer recipes for WAL/checkpoint tuning, and async-only. (b) `drizzle-orm` over `better-sqlite3` — adds an abstraction the lattice doesn't need; queries are hand-tuned per package. |

### 3.2 WAL mode + checkpoint policy

| Decision | WAL mode on. `wal_autocheckpoint = 1000` (default). Manual `PRAGMA wal_checkpoint(TRUNCATE)` at cycle boundaries that complete a snapshot. |
|---|---|
| **Rationale** | WAL is the only way to get crash-safe writes without blocking readers (the Bridge's `inspect` stream is a concurrent reader). Manual checkpoint at snapshot boundaries keeps the snapshot self-contained. |
| **Alternatives considered** | DELETE journal mode (simpler but blocks readers); MEMORY journal mode (fast but loses crash safety — fails Principle II). |

### 3.3 Logical state equality testing

| Decision | A test helper `dbEquals(a, b)` queries every persistent table and asserts row-set equality, ignoring SQLite-internal pages and the post-restart trace marker. |
|---|---|
| **Rationale** | Per the spec's 2026-05-24 clarification: file-bytes may differ after restart (WAL checkpoint, vacuum). The test asserts what *matters* — that the lattice's memory, plan, identity, skills, cycle counter, dials, and deferred items are the same. |
| **Alternatives considered** | File-hash equality (fragile, would force pessimistic SQLite settings); per-table count-only equality (would miss in-row data drift). |

### 3.4 Two-process coordination

| Decision | One **per-lattice lock file** at `<sqlite-path>.lock` claimed by `apps/lattice` on start. The slow clock uses a **separate dedicated lock** at `<sqlite-path>.slowclock.lock` (so the slow clock can run without the fast clock and vice versa, but only one slow pass at a time). |
|---|---|
| **Rationale** | The fast clock owns the lattice; the slow clock is a forked, idempotent worker. Different concurrency invariants → different locks. |
| **Alternatives considered** | A single lock for both (would prevent the slow clock from running when the fast clock is paused — wrong); SQLite advisory locks (better-sqlite3 doesn't expose them ergonomically; file locks are simpler and portable). |

### 3.5 Trace indexed store inside or outside SQLite

| Decision | **Inside** the same SQLite file as the entity (one table: `trace`). |
|---|---|
| **Rationale** | The spec's 2026-05-24 assumption: keeps the entity self-contained (constitution Principle II). The JSONL file is the authoritative *durable* trace; the in-SQLite index is for fast Bridge queries. JSONL rotates by size; the indexed copy stays bounded by retention policy. |
| **Alternatives considered** | A side database (sqlite-vec or DuckDB) — adds a file the snapshot module must also copy; breaks single-file ergonomics. JSONL-only (no index) — Bridge inspect would have to scan files; too slow for live stream. |

### 3.6 R++ vendored library — vendor or workspace-link?

| Decision | **Vendor** the source from `runcor-ai/rpp-parser` into `packages/rpp-parser/` and add an `ATTRIBUTION.md`. Keep upstream URL + commit pinned for re-syncs. |
|---|---|
| **Rationale** | The constitution mandates "brought in whole; do not redesign". Vendoring keeps the dependency self-contained (no npm publish coordination) and lets the lattice ship without waiting on upstream releases. |
| **Alternatives considered** | npm install — only works if the upstream publishes (status unknown). Git submodule — adds a worktree complication for contributors. |

### 3.7 MCP Registry client — official package or custom?

| Decision | Use the official `@modelcontextprotocol/sdk` for transport (servers + client). For the **registry directory** (the directory of MCP servers, per intent §15), implement a small client in `packages/capabilities/src/registry.ts` against the registry's documented HTTP API. |
|---|---|
| **Rationale** | The SDK handles JSON-RPC transport. The registry directory is just an HTTP service; a thin custom client keeps tool discovery substrate-governed (we can intercept candidates before they touch the manifest). |
| **Alternatives considered** | Hand-rolling MCP transport (fragile and unnecessary); third-party registry crawlers (add dependencies for almost no logic). |

### 3.8 The Bridge process model

| Decision | The Bridge `bridge-api` spawns each lattice as **two child processes**: one `apps/lattice` (fast clock) and one `apps/slowclock` (slow clock), both pointing at the same SQLite file. The Bridge tracks PIDs and restarts crashed children once before alerting the operator. |
|---|---|
| **Rationale** | Process isolation enforces Principle XIV at the OS level (a lattice cannot accidentally touch another's memory). |
| **Alternatives considered** | In-process worker threads — would share Node module state across lattices; fails the isolation goal. A single process per lattice with both clocks as in-process timers — violates Principle VII. |

### 3.9 What ships in slice 1 as a stub

Per the constitution's "build order is sequencing, not optionality", every
package exists from slice 1. But most are **stubs** until later slices fill
them in. Slice 1's responsibility is "one cycle end-to-end producing a trace
entry and a memory write" — stubs are aggressive:

| Package | Slice 1 state |
|---|---|
| `rpp-parser` | **Real** — vendored. Tests pass on import. |
| `substrate` | **Stub** with the eleven laws compiled as text and a pass-through discernment gate (always returns `pass`). Real gate lands in slice 5. |
| `memory` | **Stub** — episodic-only, no decay, no admission rule. Real four-system + decay land in slice 4. |
| `trace` | **Real** — JSONL writer + in-SQLite index. Slice 1 needs trace to demonstrate the cycle. |
| `engine` | **Stub** — direct-API backend only, no retry, no cost tracking. |
| `capabilities` | **Stub** — one hardcoded "echo" sense + one "no-op" action. |
| `jobs` | **Stub** — empty checklist support. Real in slice 9. |
| `decider` | **Stub** — single-model decider only, returns the first valid R++ output. Real (both deciders) in slice 8. |
| `dialectic` | Empty — built in slice 8. |
| `watchdog`, `skills`, `collaboration`, `dialectic`, `goals`, `drives`, `temporal`, `identity` | Stubs returning sensible defaults; real impls per the §23 build order. |
| `snapshot` | **Stub** — no-op default. Real local-folder impl in slice 3. |
| `runtime` | **Real (skeleton)** — the eight-phase state machine and the cycle loop. This is what slice 1 actually proves. |
| `bridge-shared`, `bridge-api`, `bridge-ui` | Empty packages — built in slices 14–15. |

This staging keeps slice 1 small (one runnable lattice cycling, no Bridge,
no real model calls beyond a trivial smoke) while leaving every package's
boundary in place from day one.

## 4. Open questions deferred to implementation

None blocking. Items worth re-confirming during specific slices:

- **Drive dynamics defaults.** The constitution doesn't pin numeric defaults
  for the four drives. Slice 11 will calibrate them against a reference
  workload and record them in `packages/drives/src/defaults.ts`.
- **Skill MCP self-exposure.** Whether the lattice exposes skills over MCP
  by default or opt-in. Slice 13 decides; for slice 11 (skill minting),
  default is opt-in.
- **Identity reflective-update cadence.** Constitution says identity
  "lives" in memory but does not pin how often the reflective update runs.
  Likely tied to slow-clock wakes; slice 11 will confirm.

These are implementation calibrations, not architectural choices, and do
not block the plan.

## 5. Reuse summary — runcor-ai sources

| Concern | Source | Lattice location |
|---|---|---|
| Eleven laws | `runcor-ai/runcor-substrate` | `packages/substrate` |
| Self-theory identity | `runcor-ai/runcor-identity` | `packages/identity` |
| Decay formula + recall | `runcor-ai/runcor-memory` | `packages/memory` |
| Discovered-intention stack | `runcor-ai/runcor-goals` | `packages/goals` |
| Motivational drives | `runcor-ai/runcor-drives` | `packages/drives` |
| Cycle-based temporal | `runcor-ai/runcor-temporal` | `packages/temporal` |
| Dialectic decider | `runcor-ai/runcor-dialectic` | `packages/dialectic` |
| Watchdog | `runcor-ai/runcor-watchdog` | `packages/watchdog` |
| Skill library + extraction | `runcor-ai/runcor-skills` | `packages/skills` |
| R++ language + parser | `runcor-ai/rpp` + `runcor-ai/rpp-parser` | `packages/rpp-parser` |
