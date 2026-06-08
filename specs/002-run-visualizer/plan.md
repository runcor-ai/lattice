# Implementation Plan: Lattice Run Visualizer

**Branch**: `002-run-visualizer` | **Date**: 2026-06-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-run-visualizer/spec.md`

## Summary

Build a bridge-served playback simulator that renders a lattice run as animated motion, in three switchable visual lenses (Orchestration Board / Cycle Engine / Living System) over one shared frame-derivation core. It reads the existing trace store only — no runtime changes. Technical approach: extend the bridge-api read path (full trace envelope + cycle-range windowing) and reuse the existing SSE stream; build a Vue 3 full-screen view at `/lattice/:id/visualize` that derives `CycleFrame`s incrementally from trace rows, drives a single playback clock, and renders the active lens as SVG. Performance for thousands of cycles comes from windowed history loading + per-cycle frame summaries + frame checkpoints, never loading all rows at once.

## Technical Context

**Language/Version**: TypeScript on Node 22+ (bridge-api); Vue 3.5 + `<script setup>` (bridge-ui).

**Primary Dependencies**: Existing only — `fastify` + `zod` + `better-sqlite3` (bridge-api); Vue 3.5, Pinia 2.3, Vue Router 4, Vite 5.4 (bridge-ui). **No new dependencies.** SVG via native DOM; Canvas fallback (native) only if the particle lens needs it.

**Storage**: Read-only over the lattice's existing `data/<lattice-id>.sqlite` `trace` table (`id, cycle, at_ms, kind, phase, body`). No new tables, no writes.

**Testing**: `vitest` (both apps). Bridge-api: endpoint tests for the extended trace read + range query. Bridge-ui: unit tests for the frame-derivation reducer (the high-value, deterministic core) and the playback clock; component smoke tests for the three lenses.

**Target Platform**: Desktop browser (the existing bridge UI). Mobile explicitly out of scope.

**Project Type**: Web application — existing `apps/bridge-api` (backend) + `apps/bridge-ui` (frontend) in the pnpm/turbo monorepo.

**Performance Goals**: First interactive frame <3s for a 5,000-cycle run; scrub-to-cycle <200ms for runs ≤1,000 cycles; live frame advance <2s after cycle completion; smooth playback (no dropped cycles) across 0.25×–10×.

**Constraints**: No runtime changes; no new write path; read-only. Reuse `tokens.css` and the existing trace SSE store. Bounded memory (windowed ring, not whole-run in RAM).

**Scale/Scope**: One feature view + one Pinia store/module (frame model + playback) + three lens components + a timeline/controls component; two bridge-api read-path edits. Runs up to ~thousands of cycles.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The constitution governs the **lattice entity**; this feature is an operator-facing **read-only Bridge view** and touches none of the entity's cognition. Relevant gates:

- **Principle X (Trace Is Mandatory)** — ✅ Directly served. The visualizer is a new consumer of the existing trace; it makes the cognitive record *more* legible. No change to what is traced.
- **Principle XI (Modular and Swappable) / Tech Stack** — ✅ Vue 3 + Vite + Pinia for the Bridge UI, `fastify` + `zod` for the API, `vitest` for tests, `better-sqlite3` for reads — all the pinned stack. No new dependencies. The spec's "React" wording is overridden by this pinned stack (recorded in spec Assumptions).
- **Principles I–IX, XII–XIV (entity behaviour, cycle phases, substrate, R++, memory, no-shared-memory)** — ✅ Not touched. This feature adds no model call, no memory write, no cycle logic, no cross-lattice access. It reads one lattice's own trace.
- **No-runtime-change rule (feature-level)** — ✅ Enforced as FR-011. Data the runtime under-emits is surfaced as follow-ups (FR-014: F-V1/F-V2/F-V3), not patched into the runtime.

**Result: PASS.** No violations; Complexity Tracking table not required.

*(Note: the bridge-api read-path edits — returning the full trace envelope and adding `before_cycle` windowing — are Bridge API changes, not lattice-runtime changes. They add no write path and alter no cognition. Permitted.)*

## Project Structure

### Documentation (this feature)

```text
specs/002-run-visualizer/
├── spec.md              # Signed off
├── plan.md              # This file
├── research.md          # Phase 0 — decisions (lens rendering, frame derivation, perf)
├── data-model.md        # Phase 1 — CycleFrame / PhaseSlice / ComponentState / PlaybackState
├── quickstart.md        # Phase 1 — how to run & manually verify against lat-q00qkoc8
├── contracts/
│   ├── trace-read.md    # Extended GET /trace (full envelope + before_cycle)
│   └── frame-model.md   # The TS shape the frontend consumes (the lens contract)
├── checklists/
│   └── requirements.md  # Spec quality checklist (passing)
└── tasks.md             # Phase 2 — created by /speckit-tasks (NOT here)
```

### Source Code (repository root)

```text
apps/bridge-api/src/
├── server.ts            # EDIT: trace read returns full envelope; add before_cycle
└── ...                  # (bridge-shared TraceQuerySchema gains before_cycle)

packages/bridge-shared/src/
└── index.ts             # EDIT: TraceQuerySchema += before_cycle; export TraceRow type

apps/bridge-ui/src/
├── router.ts            # EDIT: add { path:'/lattice/:id/visualize', component: VisualizeView }
├── api.ts               # EDIT: Api.traceRange(id, {after,before,limit}) returning full rows
├── views/
│   └── VisualizeView.vue        # NEW: full-screen host — lens switch + timeline + controls
├── visualizer/                  # NEW module (the shared core + lenses)
│   ├── frameModel.ts            # NEW: trace rows → CycleFrame (pure, incremental, tested)
│   ├── frameModel.test.ts       # NEW: derivation unit tests (incl. stuck-loop fixture)
│   ├── playback.ts              # NEW: playback clock (play/pause/step/speed/follow-live)
│   ├── playback.test.ts         # NEW: clock unit tests
│   ├── useRunFrames.ts          # NEW: composable — windowed load + SSE live + checkpoints
│   ├── components/
│   │   ├── Timeline.vue         # NEW: scrubber + cycle/phase markers + controls
│   │   ├── ComponentTooltip.vue # NEW: hover → underlying trace row(s)
│   │   └── lenses/
│   │       ├── OrchestrationBoard.vue  # NEW: lens A
│   │       ├── CycleEngine.vue          # NEW: lens B (radial)
│   │       └── LivingSystem.vue         # NEW: lens C (particle field)
│   └── lensProps.ts             # NEW: shared prop contract every lens receives
└── stores/trace.ts      # REUSE (live SSE ring); fix the pre-existing TS2322/2345 typing
```

**Structure Decision**: Web-application layout, extending the two existing bridge apps in place. All visualizer-specific code is isolated under `apps/bridge-ui/src/visualizer/` so the three lenses share exactly one frame model and one playback clock (satisfies FR-009/FR-010 by construction — a lens is a pure renderer of `CycleFrame` + `PlaybackState`). The only backend surface is the two read-path edits in `server.ts` + `bridge-shared`.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.
