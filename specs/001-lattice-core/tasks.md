---

description: "Dependency-ordered task breakdown for the Runcor Lattice — 15 vertical slices per intent spec §23"
---

# Tasks: Lattice Core

**Input**: Design documents from `specs/001-lattice-core/`

**Prerequisites**: plan.md, spec.md (13 user stories), research.md, data-model.md, contracts/, quickstart.md

**Tests**: MANDATORY per constitution Testing Discipline. Each slice is "done" only when its tests pass. Tests land alongside code, not after.

**Organization**: Tasks are grouped by the **15 vertical slices** from intent spec §23 (each a Phase). Each slice leaves the system runnable. Inside a slice, tests come before implementation (TDD per constitution).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which spec.md user story this task advances (US1..US13)
- File paths reference plan.md monorepo structure

## Path Conventions

Monorepo root is `C:\runcor-lattice\`. Packages live under `packages/`, apps under `apps/`, tests under `tests/`. All TypeScript is ESM strict.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Initialize the monorepo so packages can be added.

- [ ] T001 Write `LICENSE` at repo root with MIT text (year 2026, holder Runcor Lattice contributors). Spec FR-057.
- [ ] T002 Write `README.md` at repo root: 60-second pitch, install/run snippet, link to `specs/001-lattice-core/quickstart.md`.
- [ ] T003 Initialize the pnpm workspace at repo root: `pnpm-workspace.yaml` listing `packages/*` and `apps/*`; `package.json` with engines `node>=22`, scripts for `build`, `test`, `typecheck`, `lint`, `dev`, `bridge:start`.
- [ ] T004 [P] Add `turbo.json` with pipeline for `build`, `test`, `typecheck`, `lint`; configure `dependsOn: ["^build"]` where needed.
- [ ] T005 [P] Add `tsconfig.base.json` at repo root: strict mode, `noUncheckedIndexedAccess: true`, ESM, Node 22 target, `composite: true`, declaration emit.
- [ ] T006 [P] Add `.prettierrc.json` (2-space indent, 100-char width, semicolons, single quotes) and `.prettierignore` (node_modules, dist).
- [ ] T007 [P] Add `eslint.config.js` (flat config) with `@typescript-eslint`, import sort, plus rules forbidding `console.log` outside `apps/*` (use pino).
- [ ] T008 [P] Add `vitest.config.ts` at repo root: shared config (timeouts, reporters, coverage thresholds).
- [ ] T009 [P] Add `.editorconfig` (lf line endings; cross-platform).
- [ ] T010 [P] Update `.gitignore` to include `dist/`, `*.tsbuildinfo`, `.turbo/`, `coverage/`, `*.sqlite*`, `snapshots/`, `data/`, `*.log`, `.vitest-cache/` (already done in repo, verify).
- [ ] T011 Run `pnpm install` and verify a fresh workspace builds with `pnpm typecheck`.

**Checkpoint**: `pnpm typecheck` passes with no packages yet. Repo is a working pnpm monorepo.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Bootstrap every package and app skeleton, vendor the R++ parser, prepare test harness. No user-story work yet.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Package skeletons (parallel)

Each task creates `packages/<name>/` with `package.json` (name `@runcor/<name>`, version `0.0.0`, type `module`, `exports`), `tsconfig.json` (extends base), `src/index.ts` (`export {}` placeholder), `src/index.test.ts` (one passing smoke test `expect(true).toBe(true)`).

- [ ] T012 [P] Create `packages/substrate/` skeleton.
- [ ] T013 [P] Create `packages/memory/` skeleton.
- [ ] T014 [P] Create `packages/identity/` skeleton.
- [ ] T015 [P] Create `packages/goals/` skeleton.
- [ ] T016 [P] Create `packages/drives/` skeleton.
- [ ] T017 [P] Create `packages/temporal/` skeleton.
- [ ] T018 [P] Create `packages/decider/` skeleton.
- [ ] T019 [P] Create `packages/dialectic/` skeleton.
- [ ] T020 [P] Create `packages/watchdog/` skeleton.
- [ ] T021 [P] Create `packages/skills/` skeleton.
- [ ] T022 [P] Create `packages/trace/` skeleton.
- [ ] T023 [P] Create `packages/engine/` skeleton.
- [ ] T024 [P] Create `packages/capabilities/` skeleton.
- [ ] T025 [P] Create `packages/jobs/` skeleton.
- [ ] T026 [P] Create `packages/collaboration/` skeleton.
- [ ] T027 [P] Create `packages/snapshot/` skeleton.
- [ ] T028 [P] Create `packages/runtime/` skeleton.
- [ ] T029 [P] Create `packages/slowclock/` skeleton.
- [ ] T030 [P] Create `packages/bridge-shared/` skeleton.

### Vendor the R++ parser

- [ ] T031 Copy source from `runcor-ai/rpp-parser` (clone, copy `src/`, copy `LICENSE`) into `packages/rpp-parser/`. Add `ATTRIBUTION.md` recording upstream URL + commit SHA + date.
- [ ] T032 Add `packages/rpp-parser/package.json` (name `@runcor/rpp-parser`, MIT, version `0.0.0`, exports the public surface — pure TS, zero runtime deps).
- [ ] T033 Port `runcor-ai/rpp-parser` tests into `packages/rpp-parser/src/**/*.test.ts`. Confirm all upstream tests pass with `pnpm --filter @runcor/rpp-parser test`.
- [ ] T034 Add `packages/rpp-parser/src/index.ts` exports: `RppPrompt`, `RppParseResult`, `parse()`, `compose()`, `RppError`.

### App skeletons

- [ ] T035 Create `apps/lattice/` with `package.json` (bin `lattice`), `src/cli.ts` that prints `lattice 0.0.0` on `--version`. Use `commander` or built-in `parseArgs`.
- [ ] T036 Create `apps/slowclock/` with `package.json` (bin `slowclock`), `src/cli.ts` that prints `slowclock 0.0.0` on `--version`.
- [ ] T037 Create `apps/bridge-api/` with `package.json`, `src/server.ts` (empty fastify instance that listens on 127.0.0.1:7100 and serves `GET /health` returning `{ok: true}`).
- [ ] T038 Create `apps/bridge-ui/` with `package.json` (Vite + Vue 3 + Pinia), `src/main.ts`, `src/App.vue` (single "Bridge — not yet implemented" page), `vite.config.ts`.

### Test scaffolds

- [ ] T039 [P] Create `tests/integration/` with one placeholder test (`smoke.test.ts`) that asserts the workspace builds.
- [ ] T040 [P] Create `tests/e2e/` with one placeholder test.
- [ ] T041 [P] Add `tests/helpers/` with `tempDb()`, `tempSnapshotDir()`, and `dbEquals(a, b)` stubs (real impls land in slice 3).

### Foundational verification

- [ ] T042 `pnpm typecheck` clean across all packages and apps.
- [ ] T043 `pnpm test` runs all skeleton tests successfully.
- [ ] T044 `pnpm lint` clean.

**Checkpoint**: Every package and app exists with a green smoke test. R++ parser is vendored and tests pass. Ready to begin slice 1.

---

## Phase 3: Slice 1 — One cycle end-to-end (Priority: P1) 🎯 MVP

**Goal**: Prove the lattice can complete one pass through the eight phases producing a trace entry and a memory write. (Intent §23 step 1; spec US2 first iteration.)

**Independent Test**: `pnpm --filter @runcor/runtime test -- one-cycle` runs the runtime against a minimal in-memory backend; trace contains 8 phase entries in pinned order; one episodic memory row exists with a recorded "why".

### Tests for Slice 1 (write first; assert they FAIL)

- [ ] T045 [P] [US2] Write `packages/runtime/src/cycle.test.ts`: assert `runCycle()` emits 8 trace entries in the exact pinned order `observe → ground → recall → decide → act → judge → write → pulse`.
- [ ] T046 [P] [US2] Write `packages/runtime/src/cycle-counter.test.ts`: assert cycle counter increments by exactly 1 per call to `runCycle()`.
- [ ] T047 [P] [US2] Write `tests/integration/slice-1-one-cycle.test.ts`: run a stub-backed lattice for 1 cycle; assert trace has 8 entries; assert `memory_episodic` has 1 row whose `why` is non-empty.
- [ ] T048 [P] [US2] Write `packages/trace/src/trace.test.ts`: assert `Trace.write()` appends to JSONL and commits to in-memory indexed store atomically.
- [ ] T048a [P] [US2] **(analyze C2)** Write `tests/integration/empty-phase-still-traced.test.ts`: run one cycle where `act` chose no action; assert the cycle STILL produces 8 trace entries — covers FR-002 + US2 acceptance scenario 3.

### Implementation for Slice 1

- [ ] T049 [P] [US2] Implement `packages/trace/src/types.ts` (TraceEntry shape per data-model.md §8) + `packages/trace/src/trace.ts` with `Trace` class: JSONL append + (slice-1) in-memory indexed store; SQLite-backed index lands in slice 3.
- [ ] T050 [P] [US2] Implement `packages/trace/src/ring-buffer.ts`; used by Bridge live stream in slice 14.
- [ ] T051 [US2] Implement `packages/engine/src/types.ts` per `contracts/model-backend.md`: `ModelBackend`, `ModelCallRequest`, `ModelCallResult`, `ModelBackendError`.
- [ ] T052 [US2] Implement `packages/engine/src/direct-api-backend.ts` against `@anthropic-ai/sdk`. Slice 1 supports a single hardcoded model; budget/retry/cost land in later slices.
- [ ] T053 [US2] Implement `packages/engine/src/stub-backend.ts`: returns a canned R++ output for any input. Used by tests so slice 1 doesn't need a network.
- [ ] T054 [US2] Implement `packages/capabilities/src/types.ts` per `contracts/capability.md`.
- [ ] T055 [US2] Implement `packages/capabilities/src/echo-sense.ts`: a trivial sense that returns the current timestamp.
- [ ] T056 [US2] Implement `packages/capabilities/src/noop-action.ts`: a trivial action with no side effect.
- [ ] T057 [US2] Implement `packages/runtime/src/types.ts`: `CycleContext`, `PhaseRunner<P>`, the eight phase tags as a string-literal union.
- [ ] T058 [US2] Implement `packages/runtime/src/phases/observe.ts` (stub): reads from senses (echo only), returns a `PerceptionSnapshot`.
- [ ] T059 [US2] Implement `packages/runtime/src/phases/ground.ts` (stub): wraps the cycle's prompt with a placeholder substrate.
- [ ] T060 [US2] Implement `packages/runtime/src/phases/recall.ts` (stub): returns the most-recent episodic memory (none in cycle 1).
- [ ] T061 [US2] Implement `packages/runtime/src/phases/decide.ts` (stub): calls `engine.call()` once with the wrapped prompt; returns a parsed R++ result.
- [ ] T062 [US2] Implement `packages/runtime/src/phases/act.ts` (stub): invokes the noop action.
- [ ] T063 [US2] Implement `packages/runtime/src/phases/judge.ts` (stub): always returns `pass`.
- [ ] T064 [US2] Implement `packages/runtime/src/phases/write.ts` (stub): writes one `memory_episodic` row recording the cycle's outcome and "why".
- [ ] T065 [US2] Implement `packages/runtime/src/phases/pulse.ts` (stub): increments cycle counter, returns `{continue: true}` always (no exit).
- [ ] T066 [US2] Implement `packages/runtime/src/cycle.ts`: orchestrates the eight phases in pinned order via a type-level state machine (each phase's output type is the next phase's input type — order is enforced at the type level).
- [ ] T067 [US2] Implement `packages/runtime/src/lattice.ts`: opens an in-memory SQLite database (slice 1), wires the cycle, exposes `runCycle()` and `runNCycles(n)`.
- [ ] T068 [US2] Implement `apps/lattice/src/cli.ts` `start` command: takes `--config <path>`, runs 1 cycle (slice 1), prints trace summary to stdout, exits 0.
- [ ] T069 [US2] Implement `apps/lattice/src/config.ts` (zod schema): minimal config for slice 1 (model backend choice, manifest entries).

### Slice 1 checkpoint

- [ ] T070 [US2] Run `pnpm --filter @runcor/runtime test`. All slice-1 tests pass.
- [ ] T071 [US2] Run `pnpm --filter @runcor/lattice exec lattice start --config tests/fixtures/slice1.json` from repo root. Process exits 0 with 8 trace entries on stdout.
- [ ] T072 [US2] Tag the slice in version control: `slice-1-done`. (User can tag manually if no git.)

**Checkpoint**: A lattice turns one cycle end-to-end. The eight phases run in order. A trace entry exists per phase. A memory row is written. The MVP "lattice that lives once" is real.

---

## Phase 4: Slice 2 — The continuous loop (Priority: P1)

**Goal**: Cycles repeat indefinitely; a minimal drive pulse keeps the loop turning; no internal exit. (Intent §23 step 2; spec US2 completes; SC-001 begins to be testable.)

**Independent Test**: `pnpm --filter @runcor/runtime test -- continuous` runs 100 cycles back-to-back; counter goes 1..100 monotonically; no exit fires from inside the loop.

### Tests for Slice 2

- [ ] T073 [P] [US2] Write `packages/runtime/src/continuous.test.ts`: spawn the lattice for 100 cycles, assert counter 1..100, assert trace has 800 phase entries.
- [ ] T074 [P] [US2] Write `tests/integration/slice-2-no-exit.test.ts`: run for 200 cycles, then SIGINT to force exit; assert no `pulse` ever returned `{continue: false}` (loop has no internal exit per FR-003).
- [ ] T075 [P] [US2] Write `packages/drives/src/pulse.test.ts`: assert the pulse function produces a non-zero value with default drives, and that the value moves with input changes (resource pressure → up).

### Implementation for Slice 2

- [ ] T076 [P] [US2] Implement `packages/drives/src/types.ts`: `Drive` enum (resource_pressure, curiosity, reactivity, coherence), `DriveState`.
- [ ] T077 [P] [US2] Implement `packages/drives/src/pulse.ts`: minimal pulse function combining the four drives into a continuation force. (Real numeric calibration in slice 11.)
- [ ] T078 [US2] Wire drives into `packages/runtime/src/phases/pulse.ts`: read drive state, update `drive_state` (in-memory for slice 2), pass `{continue: true}` (always; the pulse force shapes future behaviour, not exit).
- [ ] T079 [US2] Add `runLoop(opts: {maxCycles?: number; abortSignal?: AbortSignal})` to `packages/runtime/src/lattice.ts`. Stops only on abort or test-only `maxCycles`. Production callers never set `maxCycles`.
- [ ] T080 [US2] Update `apps/lattice/src/cli.ts` `start` to call `runLoop()` (no max), install SIGINT/SIGTERM handlers that abort the loop cleanly. Test-only `--max-cycles N` flag for CI.
- [ ] T081 [US2] Add `tests/fixtures/slice2.json` (100-cycle config for the integration test).

### Slice 2 checkpoint

- [ ] T082 [US2] All slice-2 tests pass.
- [ ] T083 [US2] Manual run: `lattice start --config tests/fixtures/slice2.json --max-cycles 100` completes in <60 s with 100 cycles in the trace.

**Checkpoint**: The lattice runs continuously. No internal exit. The "entity that lives" abstraction is real (in memory; durability is slice 3).

---

## Phase 5: Slice 3 — Persistence and resume (Priority: P1)

**Goal**: SQLite as the entity; swappable snapshot module; graceful shutdown; **resume parity** (spec US3, SC-002 — the single most important test in the suite).

**Independent Test**: `tests/integration/slice-3-resume.test.ts` runs N cycles, snapshots state, kills, restarts, asserts logical-state equality and cycle counter at N+1.

### Tests for Slice 3 (write first; assert they FAIL)

- [ ] T084 [P] [US3] Write `packages/runtime/src/sqlite-open.test.ts`: open a temp SQLite file with WAL mode, assert WAL is on, assert lockfile is claimed, assert second open fails.
- [ ] T085 [P] [US3] Write `packages/runtime/src/migrations.test.ts`: apply all migrations to a fresh DB, assert `schema_migration` rows match expected versions.
- [ ] T086 [P] [US3] Write `packages/snapshot/src/local-folder.test.ts`: put a file, list it, get it back to a different path, byte-equal.
- [ ] T087 [P] [US3] Write `tests/integration/slice-3-resume.test.ts`: the canonical resume parity test. Runs 50 cycles, snapshot, kill, restart, assert `dbEquals(before, after)` query-equal (per the 2026-05-24 clarification), assert next cycle is 51.
- [ ] T088 [P] [US3] Write `tests/integration/slice-3-conflict.test.ts`: two `lattice start` processes against the same SQLite file; the second exits with a clear lockfile error.
- [ ] T089 [P] [US3] Write `tests/integration/slice-3-crash-mid-cycle.test.ts`: kill the lattice mid-act (between phases) with SIGKILL; restart; assert cycle counter advances to next-cycle boundary (partial work discarded); assert trace records the interruption.
- [ ] T090 [P] [US3] Write `tests/integration/slice-3-restore-from-snapshot.test.ts`: delete the local SQLite file, but a snapshot exists at the destination; lattice startup restores from snapshot first, then resumes.
- [ ] T090a [P] [US3] **(analyze C3)** Write `tests/integration/slice-3-snapshot-unreachable.test.ts`: configure a snapshot destination that always fails; assert the cycle CONTINUES, the failure is recorded in `snapshot_log`, and pino logs the error. Covers spec Edge Case "snapshot destination unreachable".
- [ ] T090b [P] [US3] **(analyze C12)** Write `tests/integration/slice-3-cold-start.test.ts`: first-ever start, no local SQLite, no snapshot; assert cycle counter = 0, schema migrations applied, the next cycle is 1, identity seed honoured. Covers spec Edge Case "cold start with no prior state".
- [ ] T090c [P] [US3] **(analyze C6)** Write `packages/trace/src/rotation.test.ts` + implement `packages/trace/src/rotation.ts`: rotate the raw JSONL when its size exceeds a configurable threshold (default 100MB); oldest segment is archived to the snapshot destination, the indexed store stays bounded by retention policy. Covers spec Assumption "trace retention".

### Implementation for Slice 3

- [ ] T091 [P] [US3] Implement `packages/runtime/src/db.ts`: opens `better-sqlite3` with WAL mode, `synchronous = NORMAL`, `wal_autocheckpoint = 1000`; exports `Db` type used by all packages.
- [ ] T092 [P] [US3] Implement `packages/runtime/src/lockfile.ts`: `claim(path)` / `release(path)`. Used per-SQLite-file.
- [ ] T093 [P] [US3] Implement `packages/runtime/src/migrations/` with one migration per table per `data-model.md`: `001_entity.sql`, `002_memory_identity.sql`, `003_identity_current.sql`, `004_plan_job_item.sql`, `005_memory_episodic.sql`, `006_memory_semantic.sql`, `007_memory_index.sql`, `008_skill.sql`, `009_trace.sql`, `010_dial.sql`, `011_capability.sql`, `012_goal_drive_commitment.sql`, `013_peer_known.sql`, `014_snapshot_log.sql`, `015_schema_migration.sql`. Run in order on first open.
- [ ] T094 [P] [US3] Implement `packages/runtime/src/migrate.ts`: applies pending migrations, records `schema_migration` rows.
- [ ] T095 [US3] Replace `packages/trace/src/trace.ts` slice-1 in-memory index with the SQLite-backed `trace` table per data-model §8. JSONL writer unchanged.
- [ ] T096 [US3] Update `packages/runtime/src/lattice.ts` to open a real `Db` (file path from config) instead of in-memory, claim the lockfile, run migrations, then enter the loop.
- [ ] T097 [P] [US3] Implement `packages/snapshot/src/types.ts` per `contracts/snapshot-destination.md`.
- [ ] T098 [P] [US3] Implement `packages/snapshot/src/local-folder.ts`: `LocalFolderDestination`. Atomic put via tmp+rename. Lists by reading directory. Gets via copy.
- [ ] T099 [US3] Implement `packages/snapshot/src/snapshotter.ts`: wraps a `SnapshotDestination`. `snapshot()` runs `PRAGMA wal_checkpoint(TRUNCATE)`, then calls `destination.put()`. Writes a row to `snapshot_log`. Non-blocking from the cycle's POV (run in microtask; failure → operational log + log row, never blocks the cycle).
- [ ] T100 [US3] Implement `packages/snapshot/src/restorer.ts`: `restoreIfNeeded(localPath, destination)`. If local missing and destination has a snapshot, copies it back; returns the key restored.
- [ ] T101 [US3] Wire `Snapshotter` into the runtime: snapshot every 25 cycles (slice 3 default; tunable later). On graceful shutdown, take a final snapshot.
- [ ] T102 [US3] Implement `packages/runtime/src/graceful-shutdown.ts`: SIGINT/SIGTERM handler with a cleanup registry — abort loop at next phase boundary, flush trace, commit pending writes, take final snapshot, release lockfile, exit 0.
- [ ] T103 [US3] Implement `tests/helpers/dbEquals.ts` for real: queries every persistent table and asserts row-set equality, ignoring SQLite-internal pages and the post-restart trace marker. Replaces the slice-1 stub.
- [ ] T104 [US3] Update `apps/lattice/src/cli.ts` `start` to take a real `--sqlite <path>` flag, claim lockfile, restore if needed, run migrations, snapshotter installed.

### Slice 3 checkpoint

- [ ] T105 [US3] All slice-3 tests pass — especially the canonical resume parity test (T087).
- [ ] T106 [US3] Manual run: `lattice start --sqlite ./test.sqlite --max-cycles 50` → SIGTERM → `lattice start --sqlite ./test.sqlite --max-cycles 50` resumes at cycle 51.

**Checkpoint**: The database IS the entity. Resume parity proven. Constitution Principle II validated.

---

## Phase 6: Slice 4 — The four memory systems (Priority: backstop for US7, US8, US9, US11)

**Goal**: Real `packages/memory` with four distinct systems, the decay formula on episodic, the admission rule as a gate, index-plus-cheap-selector recall. (Intent §23 step 4.)

**Independent Test**: `pnpm --filter @runcor/memory test` proves all four systems behave per spec FR-011..017, including the exact decay formula and the admission rule rejecting re-perceivable facts.

### Tests for Slice 4

- [ ] T107 [P] [US8] Write `packages/memory/src/admission.test.ts`: re-perceivable facts (file contents, tracker state) are REJECTED; decisions/reasons/who-doing-what are ACCEPTED.
- [ ] T108 [P] [US9] Write `packages/memory/src/identity.test.ts`: identity rows are immune to decay; even with `R=0.01, t=∞`, they are never forgotten.
- [ ] T109 [P] [US9] Write `packages/memory/src/episodic.test.ts`: decay formula exact-match `M = R × ln(f + 1) × e^(-t / (τ × D))` for a known input set; forget at `M<0.05`; promote at `M>0.6`.
- [ ] T110 [P] [US9] Write `packages/memory/src/semantic.test.ts`: writes carry `why`; promotion writes `source_kind = 'promoted'`; subconscious correction path lands rows in `memory_semantic_correction`.
- [ ] T111 [P] [US9] Write `packages/memory/src/recall.test.ts`: with 50 memories and a query, the selector pass returns ≤ `memoryRecallBreadth` rows, each with the freshness caveat for stale entries.
- [ ] T112 [P] [US9] Write `packages/memory/src/age.test.ts`: ages are rendered in human terms (`"47 days ago"`) per FR-017.
- [ ] T112a [P] [US9] **(analyze C1)** Write `tests/integration/every-memory-has-why.test.ts`: write one row to each of the four memory systems (identity / plan_item / episodic / semantic); assert `why` (or its equivalent for plan_item) is non-empty in every case. Covers spec FR-015.

### Implementation for Slice 4

- [ ] T113 [P] [US9] Implement `packages/memory/src/types.ts`: `MemoryEntry`, `IdentityMemory`, `EpisodicMemory`, `SemanticMemory`, `MemorySystem`.
- [ ] T114 [P] [US9] Implement `packages/memory/src/admission.ts`: the gate function. Re-perceivability heuristic by content tag (`tag: 'file-content'`, `tag: 'tracker-state'`, etc. → reject); also exposes `assertAdmissible()` that throws.
- [ ] T115 [US9] Implement `packages/memory/src/identity-store.ts`: read/write `memory_identity` + maintain `identity_current` composition; immune to decay (decay function explicitly skips this table).
- [ ] T116 [US9] Implement `packages/memory/src/episodic-store.ts`: write rows with `R, f, t`; expose `durabilityOf(row)` that computes the exact decay formula; expose `forgetSweep(opts)` / `promoteSweep(opts)`.
- [ ] T117 [US9] Implement `packages/memory/src/semantic-store.ts`: read/write `memory_semantic`; `promote(episodicId)` writes a semantic row with `source_kind = 'promoted'`; expose `correct(semanticId, was, nowIs, rule)` for the subconscious sweep.
- [ ] T118 [US9] Implement `packages/memory/src/plan-store.ts`: thin wrapper over `plan_job` / `plan_item` for the jobs slice; reuses `data-model.md` schema.
- [ ] T119 [US9] Implement `packages/memory/src/index-store.ts`: maintains `memory_index`. Every memory write transaction also writes its description here.
- [ ] T120 [US9] Implement `packages/memory/src/recall.ts`: index-plus-cheap-selector pattern. Uses a cheap `Decider` call to pick the top-N from the index given a query. Honours `memoryRecallBreadth` dial.
- [ ] T121 [US9] Implement `packages/memory/src/age.ts`: `humanAge(writtenAtMs, nowMs)` returning `"3 hours ago"`, `"47 days ago"`, etc. Adds the freshness caveat string for stale.
- [ ] T122 [US9] Wire real memory into `packages/runtime/src/phases/recall.ts` (replaces slice-1 stub).
- [ ] T123 [US9] Wire real memory into `packages/runtime/src/phases/write.ts` — the cycle's outcome lands in `memory_episodic`; admission rule gates the write. (Subconscious sweep is slice 6.)

### Slice 4 checkpoint

- [ ] T124 [US9] All slice-4 tests pass.
- [ ] T125 [US9] Resume parity (T087) still passes — confirms memory tables snapshot cleanly.

**Checkpoint**: Four distinct memory systems, with their own survival rules, are real and tested.

---

## Phase 7: Slice 5 — Substrate (Priority: P1)

**Goal**: Eleven laws compiled at prompt-top; discernment gate with four outcomes; per-cycle `judge` enforcement; substrate uneditable from inside the lattice. (Intent §23 step 5; spec US4.)

### Tests for Slice 5

- [ ] T126 [P] [US4] Write `packages/substrate/src/laws.test.ts`: assert all 11 laws are in pinned order in the compiled prompt; assert no rewording (byte-equal to the canonical text).
- [ ] T127 [P] [US4] Write `packages/substrate/src/wrap.test.ts`: assert `wrapCall(prompt)` returns a prompt with laws at the TOP (line-1 position).
- [ ] T128 [P] [US4] Write `packages/substrate/src/discern.test.ts`: known-bad Reality violation → `block`; known-bad Constraint violation → `block`; Simplicity violation → `pass` with advisory log; Uncertainty violation → `pass` with warning; clean output → `pass`.
- [ ] T129 [P] [US4] Write `packages/substrate/src/escalate.test.ts`: at autonomy=low, a `modify` outcome escalates (returns `escalate` with reason); at autonomy=high, the same flag self-corrects (returns `modify` with rewrite).
- [ ] T130 [P] [US4] Write `packages/substrate/src/no-bypass.test.ts`: assert no exported function reads or writes substrate state; assert TypeScript types prevent the lattice from importing internal substrate state.

### Implementation for Slice 5

- [ ] T131 [P] [US4] Implement `packages/substrate/src/laws.ts`: the eleven laws as a `const readonly` tuple of typed objects (id, name, statement). Frozen at module load.
- [ ] T132 [P] [US4] Implement `packages/substrate/src/compile.ts`: composes the laws block as R++ at the top of the prompt; reuses the identity prior block from `identity_current`.
- [ ] T133 [US4] Implement `packages/substrate/src/wrap.ts`: `wrapCall(prompt, ctx) → RppPrompt`. Inserts laws block + identity prior + reality slice ctx at the top.
- [ ] T134 [US4] Implement `packages/substrate/src/discern.ts`: per-law code-first checks (one function per law); on inconclusive code, calls the LLM fallback via `Decider`. Returns one of four outcomes.
- [ ] T135 [US4] Implement `packages/substrate/src/outcomes.ts`: the four-outcome model with structured reasons; `pass | modify | block | escalate`. Reality and Constraint always block; Simplicity advisory.
- [ ] T136 [US4] Implement `packages/substrate/src/autonomy.ts`: maps `(outcome, autonomyLevel) → action`: at `high`, modify/block triggers internal retry; at `medium`, blocks escalate; at `low`, all non-pass escalate.
- [ ] T137 [US4] Replace `packages/runtime/src/phases/ground.ts` stub with real `substrate.wrap()` invocation.
- [ ] T138 [US4] Replace `packages/runtime/src/phases/judge.ts` stub with real `substrate.discern()` on the decide output; on escalate, pause cycle and emit a trace `kind: 'substrate'` entry (operator resolves via Bridge in slice 14).
- [ ] T139 [US4] Add `packages/substrate/src/assess-capability.ts`: substrate-policy check for tool-discovery candidates (intent §15). Used in slice 10.
- [ ] T140 [US4] Structural enforcement: `packages/substrate/src/index.ts` exports ONLY `wrap`, `discern`, `assessCapability`, `autonomyResolve`. No `readState`, no `setLaws`. TypeScript test in T130 enforces this.

### Slice 5 checkpoint

- [ ] T141 [US4] All slice-5 tests pass.
- [ ] T142 [US4] Resume parity (T087) still passes; substrate has no persistent state of its own.

**Checkpoint**: Substrate is enforced physics. Eleven laws at top. Discernment blocks known-bad outputs. Lattice cannot edit its own substrate.

---

## Phase 8: Slice 6 — The subconscious layer (Priority: US8)

**Goal**: Deterministic every-cycle sweep that fixes flat contradictions, flags them, and writes to the trace. (Intent §23 step 6; spec US8.)

### Tests for Slice 6

- [ ] T143 [P] [US8] Write `packages/memory/src/subconscious-sweep.test.ts`: plant a flat inconsistency (semantic rule contradicted by a stored fact); run one cycle's sweep; assert fix happened, correction record in `memory_semantic_correction`, trace entry `kind: 'subconscious'`.
- [ ] T144 [P] [US8] Write `packages/memory/src/sweep-judgement-skip.test.ts`: plant an issue requiring judgement (two reasonable interpretations); assert sweep does NOT act; assert no correction record written.
- [ ] T145 [P] [US8] Write `tests/integration/slice-6-misbehaving-sweep.test.ts`: simulate a sweep rule that fires on consecutive cycles for the same record; assert the pattern is visible in the trace (the safeguard against a buggy subconscious).

### Implementation for Slice 6

- [ ] T146 [US8] Implement `packages/memory/src/sweep-rules.ts`: registry of flat-correction rules. Each rule is `{name, detect: (db) → CandidateCorrection[], canAct: (c) → boolean, apply: (db, c) → AppliedCorrection}`. Initial rules: `stale_semantic`, `contradicted_by_rule`, `orphan_index_row`.
- [ ] T147 [US8] Implement `packages/memory/src/subconscious.ts`: runs all registered rules in a transaction; for each candidate where `canAct` returns true, applies and records via `semantic-store.correct()`; for non-actionable candidates, emits a trace entry but does not act.
- [ ] T148 [US8] Wire the sweep into `packages/runtime/src/phases/write.ts` AFTER the cycle's normal write; same transaction.
- [ ] T149 [US8] Make the most-recent correction visible to the next cycle's recall by setting a `lastSubconsciousNote` field on the cycle's `recall` input (so `decide` knows a correction occurred).

### Slice 6 checkpoint

- [ ] T150 [US8] All slice-6 tests pass.

**Checkpoint**: The subconscious quietly corrects flat problems. The lattice has the first half of its self-maintenance model.

---

## Phase 9: Slice 7 — The two clocks (Priority: US9)

**Goal**: Slow-clock worker as a separate process, lockfile, consolidation + drift review writing corrections into memory, fast loop never interrupted. (Intent §23 step 7; spec US9; FR-025..029.)

### Tests for Slice 7

- [ ] T151 [P] [US9] Write `packages/slowclock/src/cadence.test.ts`: with `reviewCadence.baseline = 10` and a recorded activity load, assert wake decisions fire at the expected cycle counts within ±10%.
- [ ] T152 [P] [US9] Write `packages/slowclock/src/lock.test.ts`: two slow-clock processes against the same SQLite; the second exits cleanly without doing work.
- [ ] T153 [P] [US9] Write `tests/integration/slice-7-two-processes.test.ts`: spawn `apps/lattice` and `apps/slowclock` against the same file; both run; loop continues while slow clock wakes; consolidation reduces episodic-memory count.
- [ ] T154 [P] [US9] Write `tests/integration/slice-7-drift-correction.test.ts`: plant a known drift signal (purpose vs recent behavior gap); slow clock writes a correction memory; fast loop picks it up on the next cycle (no interrupt mechanism used).
- [ ] T155 [P] [US9] Write `tests/integration/slice-7-machine-sleep.test.ts`: simulate long delay between slow-clock ticks; assert only ONE most-recent wake fires (not N missed wakes).

### Implementation for Slice 7

- [ ] T156 [P] [US9] Implement `packages/slowclock/src/lock.ts`: `<sqlite-path>.slowclock.lock` — separate from the fast-clock lock (research.md §3.4).
- [ ] T157 [P] [US9] Implement `packages/slowclock/src/cadence.ts`: load-aware computation of `nextWakeAtCycle`; baseline + load-multiplier; reads from `dial.reviewCadence`.
- [ ] T158 [US9] Implement `packages/slowclock/src/consolidate.ts`: the "dream". Runs `episodicStore.forgetSweep()` + `promoteSweep()`; prunes `memory_index` to `<= sizeCap`. Idempotent.
- [ ] T159 [US9] Implement `packages/slowclock/src/drift-review.ts`: LLM pass over recent trace + identity + plan; returns `DriftFinding[]`. Findings are written into `memory_semantic` as `source_kind = 'derived'` corrections. No direct interrupt of the fast loop.
- [ ] T160 [US9] Implement `packages/slowclock/src/worker.ts`: the loop. Reads `entity.cycle`; if `cycle >= nextWakeAtCycle`, claims lock, runs consolidate + drift-review, releases lock, computes next wake, sleeps.
- [ ] T161 [US9] Implement `apps/slowclock/src/cli.ts`: `slowclock attach --sqlite <path>`. Wires `worker` against the SQLite file; runs until SIGTERM.
- [ ] T162 [US9] Add the watchdog hook: `packages/watchdog/src/find-gaps.ts` (stub for now; full impl slice 11) — feeds findings into drift-review's input set.

### Slice 7 checkpoint

- [ ] T163 [US9] All slice-7 tests pass; both processes coexist; resume parity (T087) still holds across two-process restart.

**Checkpoint**: Two clocks, sharing one SQLite under their own locks. The "fast clock dreams" pattern is real.

---

## Phase 10: Slice 8 — The decider (Priority: backstop for US7, US11)

**Goal**: Both deciders (single-model + dialectic) built and wired behind one interface; Bridge dial selects; **every model call** is parser-validated R++. (Intent §23 step 8; FR-024; Constitution IX & XI.)

### Tests for Slice 8

- [ ] T164 [P] [US7] Write `packages/decider/src/single-model.test.ts`: a single call returns a parser-validated `RppParseResult`; parse failures retry up to 2 times; trace records retries.
- [ ] T165 [P] [US7] Write `packages/dialectic/src/dialectic.test.ts`: a depth-1 dialectic call invokes Player → Coach → Judge; each internal output is itself substrate-discerned; Judge selects per recorded criteria.
- [ ] T166 [P] [US7] Write `packages/decider/src/selection.test.ts`: with `dialecticDepth = 0`, the decider used is `single-model`; with `dialecticDepth = 1`, it's `dialectic`.
- [ ] T167 [P] [US7] Write `packages/runtime/src/rpp-everywhere.test.ts`: walk every package's source for `engine.call(`, assert every call site uses an `RppPrompt` (not a raw string).

### Implementation for Slice 8

- [ ] T168 [P] [US7] Implement `packages/decider/src/types.ts` per `contracts/decider.md`.
- [ ] T169 [US7] Implement `packages/decider/src/single-model.ts`: one `engine.call()`, parser validation, up-to-2 retries on parse failure, trace records steps.
- [ ] T170 [US7] Implement `packages/decider/src/select.ts`: factory that returns the configured decider based on `dialecticDepth`.
- [ ] T171 [P] [US7] Implement `packages/dialectic/src/player.ts`: drafts an option set as an R++ block.
- [ ] T172 [P] [US7] Implement `packages/dialectic/src/coach.ts`: challenges the Player's draft; produces an R++ critique.
- [ ] T173 [P] [US7] Implement `packages/dialectic/src/judge.ts`: selects from Player's options informed by Coach's critique; produces the final R++ result.
- [ ] T174 [US7] Implement `packages/dialectic/src/decider.ts`: composes Player/Coach/Judge per `dialecticDepth`; each internal output is substrate-discerned. Throws `DeciderError` on definitive failure.
- [ ] T175 [US7] Replace `packages/runtime/src/phases/decide.ts` stub with the real `Decider.decide()` call using the selected decider.
- [ ] T176 [US7] Migrate every model-using call site to use `Decider` and `RppPrompt`: `packages/identity/`, `packages/goals/`, `packages/skills/`, `packages/memory/src/recall.ts`, `packages/substrate/src/discern.ts` (LLM fallback), `packages/slowclock/src/drift-review.ts`. (Slice 11/13 fills these in; the migration is mechanical here.)

### Slice 8 checkpoint

- [ ] T177 [US7] All slice-8 tests pass; T167 (R++-everywhere walk) is the structural enforcement.

**Checkpoint**: Two deciders, swappable. R++ is the universal prompt currency. The decider's role is fully formed.

---

## Phase 11: Slice 9 — Jobs and self-checks (Priority: US7)

**Goal**: The full job-completion model from spec §3.1 + §9.5: checklist, completion checks (deterministic hooks + judgement pass), iteration, deferral with reason + unblock condition, partial completion, autonomy-gated sign-off. (Intent §23 step 9; spec FR-033..040.)

### Tests for Slice 9

- [ ] T178 [P] [US7] Write `packages/jobs/src/checklist.test.ts`: open a job with 3 items; transitions open→passed only when check actually passes; assertion to pass without check is REJECTED + traced.
- [ ] T179 [P] [US7] Write `packages/jobs/src/iteration.test.ts`: a failing check increments `iteration_count`; the item stays `open`; the next decide can pick it again.
- [ ] T180 [P] [US7] Write `packages/jobs/src/deferral.test.ts`: deferral with "this was hard" → REJECTED; deferral with a valid external reason + unblock condition → ACCEPTED; trace records both.
- [ ] T181 [P] [US7] Write `packages/jobs/src/partial-close.test.ts`: job with 3 passed + 1 deferred → close as `closed_partial`; deferred items persist in plan memory.
- [ ] T182 [P] [US7] Write `packages/jobs/src/unblock-flow.test.ts`: deferred item's unblock condition becomes met during observe; next decide includes it in the choice set; no mid-cycle interruption.
- [ ] T183 [P] [US7] Write `packages/jobs/src/sign-off.test.ts`: at autonomy=high, the lattice closes itself; at autonomy=low, close awaits an operator confirmation event.
- [ ] T183a [P] [US7] **(analyze C4)** Write `packages/jobs/src/iteration-cap.test.ts`: an item fails its completion check N times (configurable cap, default 5); on the N+1th attempt, the lattice ESCALATES per autonomy dial — operator decides continue / accept-defer / close-partial. Covers spec Edge Case "job check fails repeatedly".

### Implementation for Slice 9

- [ ] T184 [P] [US7] Implement `packages/jobs/src/types.ts`: `Job`, `Item`, `CompletionCheck`, `DeferralReason`, `UnblockCondition`.
- [ ] T185 [US7] Implement `packages/jobs/src/checklist.ts`: open/list/close jobs; add/get items; state transitions; reject pass-by-assertion (T178's gate).
- [ ] T186 [US7] Implement `packages/jobs/src/completion-check.ts`: runs deterministic hooks first; if all pass, returns `passed`; if any fail, returns `failed` with details; for items with a judgement pass spec, calls the decider with the spec embedded.
- [ ] T187 [US7] Implement `packages/jobs/src/deferral.ts`: `defer(itemId, reason, unblockCondition, unblockTest)`. Validates reason is externally grounded (regex + LLM judgement fallback for non-obvious cases); rejects "this was hard"; writes to trace.
- [ ] T188 [US7] Implement `packages/jobs/src/unblock-watcher.ts`: helper called by `observe` (from slice 10's full Perception); evaluates `unblock_test` against the current perception snapshot. Returns item IDs whose condition met.
- [ ] T189 [US7] Implement `packages/jobs/src/sign-off.ts`: closure path branches on `autonomy`; at low, emits an escalation entry waiting on operator action.
- [ ] T190 [US7] Wire jobs into `packages/runtime/src/phases/decide.ts`: decide's prompt now includes the lattice's open jobs (multiple — per the 2026-05-24 clarification) as candidate work; decide chooses which item to advance.
- [ ] T191 [US7] Wire deferred-item perception into `packages/runtime/src/phases/observe.ts` (calls `unblock-watcher` from T188).

### Slice 9 checkpoint

- [ ] T192 [US7] All slice-9 tests pass.
- [ ] T193 [US7] Manual run: hand the lattice a small 3-item job via direct fixture; observe iteration and eventual close.

**Checkpoint**: A lattice can take on a job, work it to completion with proper checks, defer with valid reasons, close as partial, resume deferred items. The "professional" model is real.

---

## Phase 12: Slice 10 — Full capabilities surface (Priority: US10)

**Goal**: Rich tool contract, perception/action split, MCP and API connections, tool discovery via the official MCP Registry. (Intent §23 step 10; spec FR-041..043; US10.)

### Tests for Slice 10

- [ ] T194 [P] [US10] Write `packages/capabilities/src/contract.test.ts`: a capability with `role.sense + role.action = 0` is REJECTED; sense-only capability with `destructive: true` is REJECTED.
- [ ] T195 [P] [US10] Write `packages/capabilities/src/perception.test.ts`: parallel sense reads via `Promise.allSettled`; per-sense timeout (5s default) caps observe duration; failed sense → `result: 'failed'`, stale sense → `result: 'stale'`.
- [ ] T196 [P] [US10] Write `packages/capabilities/src/at-most-one-action.test.ts`: a cycle with two enabled actions invokes only ONE per cycle (spec FR-004).
- [ ] T197 [P] [US10] Write `packages/capabilities/src/mcp-client.test.ts`: against a local MCP test server (using `@modelcontextprotocol/sdk` server in the test), assert tool call round-trips correctly.
- [ ] T198 [P] [US10] Write `packages/capabilities/src/discovery-substrate-veto.test.ts`: a tool discovery candidate conflicting with substrate constraints is REJECTED; `substrateAssessment = 'reject'`; manifest unchanged.

### Implementation for Slice 10

- [ ] T199 [P] [US10] Implement `packages/capabilities/src/contract.ts`: the rich `Capability` type per `contracts/capability.md`. Validation on registration.
- [ ] T200 [P] [US10] Implement `packages/capabilities/src/perception.ts` per `contracts/perception.md`: parallel reads, per-sense timeout, stale handling; calls `unblock-watcher` from slice 9.
- [ ] T201 [US10] Implement `packages/capabilities/src/mcp-client.ts`: `@modelcontextprotocol/sdk` client wrapper; one `McpCapability<I, O>` factory that wraps an MCP server's tool as a `Capability`.
- [ ] T202 [US10] Implement `packages/capabilities/src/api-capability.ts`: factory for an HTTP/REST `Capability` (for non-MCP connections).
- [ ] T203 [US10] Implement `packages/capabilities/src/manifest.ts`: load tool manifest from config; validate entries; instantiate `Capability` per entry; record in `capability` table.
- [ ] T204 [US10] Implement `packages/capabilities/src/registry-client.ts`: HTTP client for the MCP Registry. Pulls candidates by query.
- [ ] T205 [US10] Implement `packages/capabilities/src/discovery.ts`: `ToolDiscovery` per contract. Queries registry; passes each candidate through `substrate.assessCapability()` (slice 5's T139); adopts only those that pass.
- [ ] T206 [US10] Implement `packages/capabilities/src/tool-search.ts`: deferred tool loading for scaling the manifest.
- [ ] T207 [US10] Replace `packages/runtime/src/phases/observe.ts` stub with real `Perception` integration.
- [ ] T208 [US10] Replace `packages/runtime/src/phases/act.ts` stub with real per-cycle single-action invocation via `Capability.invoke()`, gated by `substrate.canInvoke()`.

### Slice 10 checkpoint

- [ ] T209 [US10] All slice-10 tests pass.

**Checkpoint**: The lattice has a real connection to the world. Sense + action separated. Discovery is governed.

---

## Phase 13: Slice 11 — Remaining cognitive cores (Priority: US11)

**Goal**: Full implementations of goals, drives (calibration), temporal, skills (mint + recall + apply), watchdog. (Intent §23 step 11; spec US11.)

### Tests for Slice 11

- [ ] T210 [P] [US11] Write `packages/goals/src/proposal.test.ts`: goal proposal via decider; new goals appear in `goal` table with `state = 'proposed'`; satisfaction transitions correctly.
- [ ] T211 [P] [US11] Write `packages/drives/src/calibration.test.ts`: with a known activity-pressure scenario, drive values move within expected bands.
- [ ] T212 [P] [US11] Write `packages/temporal/src/cycles-deadlines.test.ts`: a commitment with `deadline_cycle = current + 50` is in `green`; at `current + 5`, in `orange`; missed → `red`.
- [ ] T213 [P] [US11] Write `packages/skills/src/mint.test.ts`: after a partial-close job with 2 passed + 1 deferred items, 4 skills are minted (specific+generic for each passed item); 0 from the deferred item.
- [ ] T214 [P] [US11] Write `packages/skills/src/recall.test.ts`: stored skill descriptions surface in recall when shape-matching the current work; chosen skill's R++ body loads into decide prompt.
- [ ] T215 [P] [US11] Write `packages/watchdog/src/gap-finder.test.ts`: with a stated need + a tool that could meet it + no use → emits a `gap` finding.

### Implementation for Slice 11

- [ ] T216 [P] [US11] Implement `packages/goals/src/store.ts` + `packages/goals/src/proposal.ts` (decider-driven; R++ body).
- [ ] T217 [P] [US11] Implement `packages/drives/src/calibration.ts`: numeric defaults for the four drives validated against a reference workload (recorded in `packages/drives/src/defaults.ts`).
- [ ] T218 [P] [US11] Implement `packages/temporal/src/commitments.ts`: deadline tracking in cycles; pressure-band computation.
- [ ] T219 [P] [US11] Implement `packages/temporal/src/pressure.ts`: bands `green | yellow | orange | red`; feeds into `decide`'s priority weighting.
- [ ] T220 [P] [US11] Implement `packages/skills/src/types.ts` + `packages/skills/src/skill-md.ts`: SKILL.md frontmatter parser + composer per data-model §7.
- [ ] T221 [US11] Implement `packages/skills/src/mint.ts`: at job-close, walks passed items, invokes decider to extract specific and generic skills; writes to `skill` table with `active = 0` (proposed).
- [ ] T222 [US11] Implement `packages/skills/src/activation.ts`: gate per autonomy dial (high → auto-active; low → operator confirms via Bridge in slice 14).
- [ ] T223 [US11] Implement `packages/skills/src/recall.ts`: surfaces active skill descriptions in recall via the same index-plus-selector pattern as memory; cheap pass.
- [ ] T224 [US11] Implement `packages/skills/src/apply.ts`: when a skill is chosen in decide, loads its R++ body and inserts it into the decide prompt.
- [ ] T225 [US11] Implement `packages/watchdog/src/find-gaps.ts`: reads stated needs (from goals + plan) vs available tools (from manifest) vs recent actions (from trace); emits findings.
- [ ] T226 [US11] Wire watchdog findings into `packages/slowclock/src/drift-review.ts` input set (replaces T162 stub).

### Slice 11 checkpoint

- [ ] T227 [US11] All slice-11 tests pass.
- [ ] T228 [US11] Resume parity (T087) still passes — confirms goals/skills/temporal tables snapshot cleanly.

**Checkpoint**: The lattice now thinks, learns, and notices its own blind spots. Cognitive core is complete.

---

## Phase 14: Slice 12 — Model backends (Priority: backstop for US6 swap)

**Goal**: Add a host-CLI backend alongside direct API, behind one interface. (Intent §23 step 12.)

### Tests for Slice 12

- [ ] T229 [P] [US6] Write `packages/engine/src/host-cli.test.ts`: against a mocked host CLI process, assert request/response round-trip; assert `UsageLimitError` is raised on usage-limit response.
- [ ] T230 [P] [US6] Write `tests/integration/slice-12-backend-swap.test.ts`: switch a running lattice's backend via dial; assert next cycle uses the new backend; assert identity/memory untouched.
- [ ] T230a [P] [US6] **(analyze C5)** Write `tests/integration/slice-12-usage-limit-end-to-end.test.ts`: mid-cycle usage-limit error from the host-CLI backend → relevant job item DEFERS with unblock condition `"usage window resets at <ts>"` → operator alert emitted → next cycle still runs for non-model work (perception, trace-write). Covers spec Edge Case "model backend hits usage limit mid-cycle".

### Implementation for Slice 12

- [ ] T231 [P] [US6] Implement `packages/engine/src/host-cli-backend.ts`: spawns the host CLI per call (long-lived child option to be revisited); translates `RppPrompt`; detects usage-limit; signals via `UsageLimitError`.
- [ ] T232 [US6] Implement `packages/engine/src/usage-limit-handler.ts`: on `UsageLimitError`, marks current `act` as failed; if a job item is in progress, defers it via `jobs.deferral.defer()` with unblock condition `"model backend usage window resets at <ts>"`; emits operator alert event.
- [ ] T233 [US6] Add backend swap support to `apps/lattice/src/cli.ts`: respond to a backend-swap signal (from Bridge) by replacing the engine's backend without restarting the loop.

### Slice 12 checkpoint

- [ ] T234 [US6] All slice-12 tests pass.

**Checkpoint**: Both backends real. Operator can run on subscription or API. Usage-limit behaviour is graceful.

---

## Phase 15: Slice 13 — Collaboration layer (Priority: US12)

**Goal**: MCP self-exposure; discovery registry; conversation as a job; delegation; read-only shared source of truth; no shared memory. (Intent §23 step 13; spec US12; FR-044..048.)

### Tests for Slice 13

- [ ] T235 [P] [US12] Write `packages/collaboration/src/mcp-self-exposure.test.ts`: a peer can call `essence`, `converse`, `delegate`; cannot read memory or the trace; cannot list skills unless opted-in.
- [ ] T236 [P] [US12] Write `packages/collaboration/src/registry-roundtrip.test.ts`: lattice A registers; lattice B reads the registry on slow-cycle; A appears in B's `peer_known`.
- [ ] T237 [P] [US12] Write `tests/integration/slice-13-conversation-as-job.test.ts`: A opens conversation with B; B responds; A advances on next cycle. Kill B; A's conversation job defers with unblock condition `"peer responds"`; restart B; A resumes.
- [ ] T238 [P] [US12] Write `tests/integration/slice-13-delegation.test.ts`: A delegates an item to B; B works it; A folds the report into its own plan memory; A never wrote to B's SQLite or vice versa.
- [ ] T239 [P] [US12] Write `tests/integration/slice-13-standing.test.ts`: sales lattice discovers CEO on registry; sales lattice's identity prevents engagement; trace records the recognised peer + standing-based non-engagement.
- [ ] T240 [P] [US12] Write `tests/integration/slice-13-no-cross-read.test.ts`: any attempt by lattice A to open lattice B's SQLite is rejected (better-sqlite3 with exclusive lock; secondary defense: per-lattice config dir).

### Implementation for Slice 13

- [ ] T241 [P] [US12] Implement `packages/collaboration/src/types.ts` per `contracts/mcp-self-exposure.md`.
- [ ] T242 [US12] Implement `packages/collaboration/src/mcp-server.ts`: an MCP server (from `@modelcontextprotocol/sdk`) exposing `essence`, `converse`, `delegate`, optional `skills_list`/`skills_get`. Routes incoming calls into the lattice's job-handling paths.
- [ ] T243 [US12] Implement `packages/collaboration/src/registry.ts` per `contracts/mcp-self-exposure.md`. HTTP client to the registry; `register()`, `list()`, `heartbeat()`.
- [ ] T244 [US12] Implement `packages/collaboration/src/conversation.ts`: open conversation = open a job whose items advance via successive `converse` round-trips; defer on peer silence past configurable interval.
- [ ] T245 [US12] Implement `packages/collaboration/src/delegation.ts`: receiving a `delegate` call routes into decide; on accept, opens a job; reports back via the requester's `converse` channel.
- [ ] T246 [US12] Implement `packages/collaboration/src/shared-source-of-truth.ts`: a read-only HTTP client wired as an extra sense capability per lattice.
- [ ] T247 [US12] Build a reference registry: `apps/registry/` with a tiny Fastify server implementing the registry's HTTP API. Used by tests and by an operator who needs a self-hosted registry.
- [ ] T248 [US12] Wire collaboration MCP server into `apps/lattice/src/cli.ts`: starts the MCP server on a per-lattice port; persists the port in `entity`; registers with the registry on startup; heartbeat from the slow clock.

### Slice 13 checkpoint

- [ ] T249 [US12] All slice-13 tests pass; resume parity holds across two collaborating lattices.

**Checkpoint**: Lattices can find and work with each other under Law 11 Standing. The "company of lattices" foundation is real.

---

## Phase 16: Slice 14 — The Bridge (Priority: US1, US5, US6)

**Goal**: Bridge HTTP API + Vue UI for instantiate, roster, inspect, adjust on single lattices. (Intent §23 step 14; spec FR-051..056; US1, US5, US6.)

### Tests for Slice 14

- [ ] T250 [P] [US1] Write `apps/bridge-api/src/instantiate.test.ts`: valid form → 201 + lattice cycling; invalid form → 4xx with field errors; manifest-with-disallowed-MCP → created with omitted entries + warnings.
- [ ] T251 [P] [US5] Write `apps/bridge-api/src/roster.test.ts`: GET /api/lattices returns all known lattices with current cycle counter + status.
- [ ] T252 [P] [US5] Write `apps/bridge-api/src/inspect.test.ts`: GET /api/lattices/:id returns full snapshot per `contracts/bridge-http-api.md`.
- [ ] T253 [P] [US5] Write `apps/bridge-api/src/trace-stream.test.ts`: SSE stream emits new trace entries within 2s of cycle write; `Last-Event-Id` catch-up works.
- [ ] T254 [P] [US6] Write `apps/bridge-api/src/dials.test.ts`: PATCH dials → effect on the next cycle; trace records the change.
- [ ] T255 [P] [US6] Write `apps/bridge-api/src/lifecycle.test.ts`: pause/resume/stop/replan/swap-backend each take effect within 2 cycles.
- [ ] T256 [P] [US1] Write `tests/e2e/slice-14-instantiate-flow.test.ts`: browser-headless run of the Bridge UI form → lattice on the roster within 10s (SC-005).
- [ ] T257 [P] [US6] Write `apps/bridge-api/src/binding.test.ts`: API binds to 127.0.0.1; binding to 0.0.0.0 requires explicit override AND emits a warning per minute.
- [ ] T258 [P] [US6] Write `apps/bridge-api/src/budget-enforcement.test.ts`: when a lattice's cumulative spend reaches its budget, model phases refuse further calls; non-model work continues; raising the budget resumes work without restart.

### Implementation for Slice 14 — `bridge-api`

- [ ] T259 [P] [US1] Implement `packages/bridge-shared/src/schemas.ts`: zod schemas for every request/response in `contracts/bridge-http-api.md`. Shared by API and UI.
- [ ] T260 [US1] Implement `apps/bridge-api/src/server.ts`: Fastify with the loopback binding; register routes from below.
- [ ] T261 [US1] Implement `apps/bridge-api/src/routes/instantiate.ts`: POST /api/lattices. Creates the SQLite directory + lockfile; spawns `apps/lattice` and `apps/slowclock` as child processes; tracks PIDs.
- [ ] T262 [P] [US1] Implement `apps/bridge-api/src/routes/companies.ts`: POST /api/companies for bundles (slice 15 fills the prebuilt registry; slice 14 ships the route with bundle_id resolution against `prebuilt/`).
- [ ] T263 [US5] Implement `apps/bridge-api/src/routes/roster.ts`: GET /api/lattices. Reads from each known SQLite via a read-only connection per lattice.
- [ ] T264 [US5] Implement `apps/bridge-api/src/routes/inspect.ts`: GET /api/lattices/:id. Composes the inspect payload.
- [ ] T265 [US5] Implement `apps/bridge-api/src/routes/trace.ts`: GET /api/lattices/:id/trace (paginated) + GET /api/lattices/:id/trace/stream (SSE).
- [ ] T266 [US6] Implement `apps/bridge-api/src/routes/dials.ts`: PATCH /api/lattices/:id/dials.
- [ ] T267 [US6] Implement `apps/bridge-api/src/routes/actions.ts`: POST /api/lattices/:id/actions/(pause|resume|stop|replan|swap-backend).
- [ ] T268 [US6] Implement `apps/bridge-api/src/routes/jobs.ts`: POST /api/lattices/:id/jobs.
- [ ] T269 [US6] Implement `apps/bridge-api/src/routes/escalations.ts`: POST /api/lattices/:id/escalations/:id/decide for low-autonomy human-in-the-loop.
- [ ] T270 [US1] Implement `apps/bridge-api/src/child-process-supervisor.ts`: spawns + tracks `apps/lattice` and `apps/slowclock` per lattice; restarts crashed children once before alerting.
- [ ] T271 [US1] Implement `apps/bridge-api/src/secret-store.ts`: local-only credential store for model backend API keys (file under OS keyring or `~/.runcor-lattice/secrets/` with 0600 perms); never logs raw keys.

### Implementation for Slice 14 — `bridge-ui` (Vue 3)

- [ ] T272 [P] [US1] Use the **frontend-design skill** to develop the UI's visual language: spacing scale, type ramp, palette (calm, information-dense), component primitives.
- [ ] T273 [P] [US5] Implement `apps/bridge-ui/src/stores/lattices.ts` (Pinia): roster, current-selection, dial cache.
- [ ] T274 [P] [US5] Implement `apps/bridge-ui/src/stores/trace.ts`: SSE subscription per selected lattice; ring-buffered local copy.
- [ ] T275 [P] [US1] Implement `apps/bridge-ui/src/views/RosterView.vue`: the dashboard. One row per lattice; status indicator; cycle counter; budget bar; plan summary.
- [ ] T276 [P] [US1] Implement `apps/bridge-ui/src/views/InstantiateView.vue`: the instantiation form. Pre-loaded identity-seed template; manifest editor; backend chooser; snapshot destination chooser; dial defaults.
- [ ] T277 [P] [US5] Implement `apps/bridge-ui/src/views/InspectView.vue`: live trace stream pane + memory summary + dial panel + decisions log + drift history.
- [ ] T278 [P] [US6] Implement `apps/bridge-ui/src/components/DialPanel.vue`: reusable dial editor with per-dial validators wired to `bridge-shared` schemas.
- [ ] T279 [P] [US6] Implement `apps/bridge-ui/src/components/LifecycleControls.vue`: pause/resume/stop/replan/swap-backend buttons.
- [ ] T280 [P] [US5] Implement `apps/bridge-ui/src/components/TraceStream.vue`: virtualised list, filter by kind/phase, jump-to-cycle, freeze on hover.
- [ ] T281 [P] [US6] Implement `apps/bridge-ui/src/components/EscalationsPanel.vue`: for low-autonomy, lists pending escalations and lets operator approve/reject.
- [ ] T282 [US6] Implement `apps/bridge-ui/src/router.ts` + `App.vue` + main layout.
- [ ] T283 [US1] Connect the UI's bundle build into `apps/bridge-api`: API serves the built static UI under `/`.
- [ ] T284 [US1] Add `pnpm bridge:start` script wiring api + ui dev together; in prod, `pnpm bridge:build && pnpm bridge:start`.

### Slice 14 checkpoint

- [ ] T285 [US1] All slice-14 tests pass.
- [ ] T286 [US1] Run the quickstart.md end to end: install → bridge:start → instantiate → see it cycling → adjust dials → hand a job → stop → restart → resume parity verified.

**Checkpoint**: A human can drive the lattice. The operator product exists.

---

## Phase 17: Slice 15 — Company bundling and the prebuilt library (Priority: US13)

**Goal**: Bridge instantiates bundles of pre-built role lattices; library of starter roles (CEO, CFO, marketing, sales). (Intent §23 step 15; spec US13.)

### Tests for Slice 15

- [ ] T287 [P] [US13] Write `tests/e2e/slice-15-company-instantiation.test.ts`: pick 3 prebuilt roles → click instantiate → assign budgets → all 3 lattices cycling within 5 minutes (SC-006).
- [ ] T288 [P] [US13] Write `prebuilt/_meta/manifest.test.ts`: every prebuilt role has the three required files (seed prompt, starting knowledge, defaults) and they validate against the bundle schema.
- [ ] T289 [P] [US13] Write `tests/integration/slice-15-shared-source-of-truth.test.ts`: bundle pointed at a shared source of truth — all members can READ; none can WRITE (admission rule + capability constraint).

### Implementation for Slice 15

- [ ] T290 [P] [US13] Implement `packages/bridge-shared/src/bundle.ts`: bundle schema (zod) and loader. Bundles live under `prebuilt/<role>/` with `seed-prompt.rpp`, `starting-knowledge.json`, `defaults.json`.
- [ ] T291 [P] [US13] Implement `apps/bridge-api/src/routes/companies.ts` (replaces slice-14 stub): instantiate each member via the same instantiate path as single lattices; pre-populate identity, memory, dials, manifest from the bundle; optional shared-source-of-truth wired as a sense for all members.
- [ ] T292 [P] [US13] Author `prebuilt/ceo/`: seed prompt for "I am the CEO of this company"; starting knowledge (industry primer); dial defaults (autonomy=medium, dialecticDepth=1).
- [ ] T293 [P] [US13] Author `prebuilt/cfo/`: seed prompt for "I am the CFO"; starting knowledge (accounting primer); dial defaults (autonomy=low, riskTolerance=0.3).
- [ ] T294 [P] [US13] Author `prebuilt/marketing/`: seed prompt + starting knowledge + defaults.
- [ ] T295 [P] [US13] Author `prebuilt/sales/`: seed prompt + starting knowledge + defaults.
- [ ] T296 [P] [US13] Author `prebuilt/_meta/README.md`: how to add a new role (write three files; no runtime change needed per spec FR-053).
- [ ] T297 [US13] Add Bridge UI `CompanyView.vue` + `NewCompanyView.vue`: list bundled lattices on a shared roster page; the new-company form to pick roles, assign budgets, optionally adjust seed prompts.
- [ ] T298 [US13] Wire optional seed-prompt override + budget override into the company POST.

### Slice 15 checkpoint

- [ ] T299 [US13] All slice-15 tests pass.
- [ ] T300 [US13] Manual: stand up a 3-role company; verify all members register with each other via the registry; verify standing prevents the sales lattice from initiating to the CEO (spec US12).

**Checkpoint**: Autonomous companies of lattices stand up in minutes. The end-goal artefact exists.

---

## Phase 18: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, security hardening, performance, the quickstart validation, end-to-end suite.

- [ ] T301 [P] Run `pnpm typecheck` clean across the entire monorepo.
- [ ] T302 [P] Run `pnpm lint --fix`; resolve remaining warnings.
- [ ] T303 [P] Coverage report from `pnpm test --coverage`; ensure each package meets ≥ 80% statements coverage.
- [ ] T304 [P] Run the **/security-review** skill against the diff; resolve high-severity findings; document accepted lows.
- [ ] T305 [P] Run the **/verify** skill against the quickstart's golden path: install fresh, start Bridge, instantiate a lattice, hand it a small job, stop, restart, verify resume parity. (Validates quickstart.md is accurate.)
- [ ] T306 [P] Performance sweep: assert SC-001 (1,000 cycles unattended), SC-002 (resume <5s), SC-003 (slow-clock cadence ±10%), SC-008 (dial-adjustment in 2 cycles) all measurably hold.
- [ ] T307 [P] Update `README.md` with: features, install, quickstart link, MIT license note, attribution to runcor-ai/*.
- [ ] T308 [P] Author `docs/operations.md`: how to back up the SQLite file manually; how to migrate from one snapshot destination to another; how to inspect a hung lattice; the lockfile recovery procedure.
- [ ] T309 [P] Author `docs/extending.md`: how to add a new `Capability`, a new `ModelBackend`, a new `SnapshotDestination`, a new prebuilt role bundle.
- [ ] T310 [P] Author `docs/security-model.md`: single-tenant local-only justification; loopback binding; OS-user auth boundary; risk acceptance for the 0.0.0.0 override.
- [ ] T311 [P] Author `docs/r-plus-plus.md`: a developer's guide to R++ (or a link to runcor-ai/rpp); explains why every model call must be R++.
- [ ] T312 [P] Cross-link the specs/001-lattice-core/ tree from CLAUDE.md (already done in slice 14; verify still accurate).
- [ ] T313 Final acceptance: walk through every spec.md User Story acceptance scenario manually; tick off in this tasks.md.
- [ ] T314 Final acceptance: walk through every spec.md Edge Case manually; confirm behaviour matches.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)** → no deps; runs immediately.
- **Phase 2 (Foundational)** → blocks every slice; all packages must exist as skeletons + R++ parser vendored before slice 1 starts.
- **Phase 3 (Slice 1)** → blocks all later slices: it owns the cycle + trace + engine skeleton everything else builds on.
- **Phase 4 (Slice 2)** → depends on slice 1 (the cycle exists).
- **Phase 5 (Slice 3)** → depends on slices 1–2 (persistence wraps the existing loop).
- **Phase 6 (Slice 4)** → depends on slice 3 (memory needs real SQLite).
- **Phase 7 (Slice 5)** → depends on slice 4 (substrate reads identity memory).
- **Phase 8 (Slice 6)** → depends on slices 4–5 (subconscious operates on semantic memory under substrate awareness).
- **Phase 9 (Slice 7)** → depends on slices 3, 4, 5 (the slow clock acts on memory + substrate; relies on shared SQLite + lockfile).
- **Phase 10 (Slice 8)** → depends on slices 5, 7 (deciders use substrate; the dialectic depth dial implies the slow clock for cadence-loaded calibration). Can start in parallel with slice 7 if staffed.
- **Phase 11 (Slice 9)** → depends on slices 4, 5, 8 (jobs use memory, substrate-discerned completion checks, the decider).
- **Phase 12 (Slice 10)** → depends on slices 5, 8 (capabilities are substrate-gated and use the decider for discovery decisions). Can run partly in parallel with slice 9.
- **Phase 13 (Slice 11)** → depends on slices 7, 8, 9, 10 (cognitive cores integrate with all of the above; skills mint from jobs; watchdog feeds slow clock).
- **Phase 14 (Slice 12)** → depends on slice 1 (engine exists); can start any time after slice 1 but is most useful after slice 11.
- **Phase 15 (Slice 13)** → depends on slices 9, 10, 11 (collaboration reuses jobs, capabilities, identity).
- **Phase 16 (Slice 14, Bridge)** → depends on slices 1–9 (Bridge needs a working lattice to instantiate); strictly speaking can start as early as slice 3, but full feature set assumes slice 9 (jobs) is in.
- **Phase 17 (Slice 15)** → depends on slices 13, 14 (companies are Bridge UX on top of collaboration + bundles).
- **Phase 18 (Polish)** → depends on every prior slice.

### User story dependencies

- **US1 (P1) Instantiate** → addressed by slice 14; foundational pieces (slice 1–9) must be in.
- **US2 (P1) Cycle** → slice 1 (partial) + slice 2 (complete).
- **US3 (P1) Resume** → slice 3.
- **US4 (P1) Substrate** → slice 5.
- **US5 (P2) Inspect** → slice 14.
- **US6 (P2) Adjust** → slice 14 (with backend swap from slice 12).
- **US7 (P2) Job to completion** → slice 9 (with decider quality from slice 8).
- **US8 (P2) Subconscious** → slice 6.
- **US9 (P2) Slow clock** → slice 7 (with drift review polished in slice 11).
- **US10 (P2) Tools** → slice 10.
- **US11 (P3) Skills** → slice 11.
- **US12 (P3) Collaboration** → slice 13.
- **US13 (P3) Companies** → slice 15.

### Within each slice

- Tests MUST be written and FAIL before implementation (TDD per constitution).
- Models / contracts before services.
- Services before phase wiring.
- Phase wiring before integration tests.
- Each slice completes only when ALL its tests pass; only then does the next slice begin.

### Parallel opportunities

- All Phase 1 tasks marked `[P]` run in parallel (T004..T010).
- All Phase 2 package-skeleton tasks run in parallel (T012..T030).
- Within each slice, test tasks are `[P]` (different files, no deps); model/store creations are `[P]` per package.
- Slices that depend on the same prior slice can run in parallel if staffed (e.g. slice 7 and slice 8; slice 10 and 11; slice 14 and 13).

---

## Parallel Example: Slice 1

```bash
# Launch all slice-1 tests in parallel:
T045 [P] Cycle phase-order test
T046 [P] Cycle counter test
T047 [P] One-cycle integration test
T048 [P] Trace writer test

# Launch all slice-1 model creations in parallel:
T049 [P] Trace types + writer
T050 [P] Trace ring buffer
T054 Capability types
T055 Echo sense
T056 No-op action

# Then sequentially: T057 → T058..T065 (phases) → T066 (cycle.ts) → T067..T069 (lattice + cli)
```

---

## Implementation Strategy

### MVP first (Slices 1–3)

The minimum lovable artefact is **a lattice that lives, persistently, and resumes**:

1. Phase 1 (Setup) — repo bones.
2. Phase 2 (Foundational) — package skeletons + R++ parser.
3. Phase 3 (Slice 1) — one cycle end-to-end.
4. Phase 4 (Slice 2) — continuous loop.
5. Phase 5 (Slice 3) — persistence + resume parity.

**STOP and VALIDATE**: the resume parity test (T087) is THE gate. If it passes, the entity model is real. If it fails, no later slice matters.

### Incremental delivery

After slices 1–3 hold:

- Add slice 4 (real memory) → the lattice has working spine.
- Add slice 5 (substrate) → outputs are now governed.
- Add slice 6 (subconscious) → self-maintenance starts.
- Add slice 7 (two clocks) → memory consolidates; drift caught.
- Add slice 8 (decider) → quality of every model-using slice improves.
- Add slice 9 (jobs) → operator/operator-via-bridge gets value.
- Add slice 10 (capabilities) → the lattice connects to the world.
- Add slice 11 (cognitive cores) → goals/drives/temporal/skills/watchdog complete.
- Add slice 12 (host-CLI backend) → backend flexibility.
- Add slice 13 (collaboration) → multi-lattice possible.
- Add slice 14 (Bridge) → a human can actually drive it.
- Add slice 15 (companies) → autonomous companies real.

### Parallel team strategy

After slice 5, two streams can run side by side:

- **Stream A** (cognitive depth): slices 6 → 7 → 8 → 11 → 13.
- **Stream B** (work + UI): slices 9 → 10 → 14 → 15.

Each stream syncs at the slice boundaries that have cross-dependencies (notably slice 13 depends on both 9 and 11).

---

## Notes

- [P] tasks = different files, no incomplete-dep collisions.
- [USn] label maps task to spec.md user story for traceability.
- Each slice is independently runnable and validated.
- Tests fail BEFORE implementation; this is TDD by constitution mandate.
- Commit (or tag, if no git) after each slice checkpoint.
- Pause and run resume-parity (T087) at the end of every slice 3+ — if it ever breaks, fix immediately. Resume parity is the spine.
- Avoid: same-file conflicts inside a slice (mark [P] only when truly independent), cross-slice dependencies that break sequential ordering, skipping a slice's tests on the basis of "the code looks right".
