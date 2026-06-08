---
description: "Task list for Lattice Run Visualizer implementation"
---

# Tasks: Lattice Run Visualizer

**Input**: Design documents from `specs/002-run-visualizer/`

**Tests**: INCLUDED. The constitution mandates testing discipline and the plan names the frame-derivation reducer + playback clock + trace read as the test targets. Tests land alongside code.

**Organization**: Grouped by user story (US1–US5 from spec.md) for independent delivery. US1 is the MVP.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency)
- Paths are repo-relative; this is a web app (`apps/bridge-api`, `apps/bridge-ui`, `packages/bridge-shared`).

---

## Phase 1: Setup

- [x] T001 Create the visualizer module scaffold: `apps/bridge-ui/src/visualizer/` with `components/`, `components/lenses/` subdirs.
- [x] T002 [P] Add the route `{ path: '/lattice/:id/visualize', component: () => import('./views/VisualizeView.vue'), props: true }` to `apps/bridge-ui/src/router.ts`; add a "Visualize" link from `InspectView.vue`.
- [x] T003 [P] Define the lens prop contract `apps/bridge-ui/src/visualizer/lensProps.ts` (`LensProps` per `contracts/frame-model.md`).

---

## Phase 2: Foundational (blocks all stories)

**⚠️ No user story can be completed until this phase is done — it is the shared core.**

- [x] T004 [P] Extend `TraceQuerySchema` in `packages/bridge-shared/src/index.ts` with `before_cycle` (int ≥ 0, optional); export a `TraceRow` type (`id, cycle, at_ms, kind, phase, body`).
- [x] T005 Edit `apps/bridge-api/src/server.ts` `GET /trace`: return the full envelope row (not just `body`), parse `body` to object, and apply `before_cycle` (`cycle < ?`). (depends on T004)
- [x] T006 [P] Endpoint test in `apps/bridge-api/src/server.test.ts`: trace read returns full envelope; `after_cycle`+`before_cycle` window bounds rows. (depends on T005)
- [x] T007 [P] Add `Api.traceRange(id, {after_cycle?, before_cycle?, limit?})` to `apps/bridge-ui/src/api.ts` returning `TraceRow[]`.
- [x] T008 Implement the frame model `apps/bridge-ui/src/visualizer/frameModel.ts`: types (`CycleFrame`, `PhaseSlice`, `ComponentStates`, `ItemState`, `Transition`) + pure reducer `applyRow(state,row)` + `projectFrame(state,cycle)` per `data-model.md`. (depends on T004)
- [x] T009 [P] `apps/bridge-ui/src/visualizer/frameModel.test.ts`: fold a recorded stuck-loop fixture; assert no item transitions, no delegations, repeated dominant action; assert substrate-block sets `dispatch.blockedBy`; assert item-pass row yields `item-passed`+`gate-pass` transitions. (depends on T008)
- [x] T010 [P] Implement the playback clock `apps/bridge-ui/src/visualizer/playback.ts`: `PlaybackState` + advance on rAF scaled by `speed` (0.25–10), `play/pause/stepPhase/stepCycle/setSpeed/seek`, `followLive` rule. (no dep)
- [x] T011 [P] `apps/bridge-ui/src/visualizer/playback.test.ts`: speed scales phase duration; step advances exactly one phase/cycle; followLive engages only at latest cycle. (depends on T010)
- [x] T012 Implement `apps/bridge-ui/src/visualizer/useRunFrames.ts` (`RunModel`): windowed `loadWindow` via `Api.traceRange`, checkpoints every K=50 cycles, `frameAt` (reconstruct from nearest checkpoint), `ingestLiveRow`, delegate-capability-name set + medium-clock cadence from lattice inspect. (depends on T007, T008)
- [x] T013 Implement the host `apps/bridge-ui/src/views/VisualizeView.vue`: mounts `useRunFrames` + `playback`, renders the active lens via a slot, hosts `<Timeline>` + `<ComponentTooltip>`, empty/idle/error states (FR-013). (depends on T010, T012)

**Checkpoint**: core derivation + playback + host shell exist; lenses + controls plug in next.

---

## Phase 3: User Story 1 — Replay & understand (P1) 🎯 MVP

**Goal**: open a recorded run, press play, watch the Board lens animate, form a correct hypothesis without docs.

**Independent Test**: load the stuck-loop run, press play → repetition + inert items + absent delegate obvious in ≤15s.

- [x] T014 [US1] Implement `apps/bridge-ui/src/visualizer/components/lenses/OrchestrationBoard.vue`: senses→decide→dispatch→gates/items→memory dataflow; packet per cycle; substrate wall (red on block); delegate lane; items column; phase highlight from `playback.phaseIndex`; colours from `tokens.css`. (depends on T003, T013)
- [x] T015 [US1] Minimal `apps/bridge-ui/src/visualizer/components/Timeline.vue`: always-visible cycle + phase markers + play/pause button (scrub/speed added in US3). (depends on T013)
- [x] T016 [US1] Wire Board as the default lens in `VisualizeView.vue`; verify the stuck-loop legibility bar (transitions empty, delegate cold) renders unmistakably. (depends on T014, T015)

**Checkpoint**: a recorded run plays back legibly in the Board lens — MVP.

---

## Phase 4: User Story 2 — Live playback (P1)

**Goal**: cycles appear automatically during an active run.

**Independent Test**: start a lattice, open Visualize → frames advance within ~2s, no refresh.

- [x] T017 [US2] Subscribe `useRunFrames` to the existing trace SSE (reuse `stores/trace.ts` EventSource); fold each live row via `ingestLiveRow`, grow `latestCycle`. (depends on T012)
- [x] T018 [US2] Follow-live in `VisualizeView`/`playback`: advance playhead on new cycle only when `followLive`; scrubbed-back view stays put but timeline grows (FR-012); idle/paused run shows "gone quiet" (FR-013). (depends on T013, T017)

**Checkpoint**: live + historical coexist correctly.

---

## Phase 5: User Story 3 — Scrub & speed (P2)

**Goal**: drag timeline to any cycle; play/pause/step/speed 0.25×–10×.

**Independent Test**: scrub to cycle 30 (<200ms); 0.25× resolves a phase over ~1s; step advances exactly one phase/cycle.

- [x] T019 [US3] Extend `Timeline.vue`: draggable scrubber (cycle X axis) → `playback.seek`; loads the window around target via `RunModel.loadWindow`. (depends on T012, T015)
- [x] T020 [P] [US3] Add speed control (0.25×–10×) + step-by-phase / step-by-cycle buttons to `Timeline.vue`, bound to `playback`. (depends on T010, T015)

**Checkpoint**: full transport controls.

---

## Phase 6: User Story 4 — Three switchable lenses (P2)

**Goal**: toggle Board / Engine / System, preserving position + playback state.

**Independent Test**: at cycle 23, switch lenses → all render cycle 23, play/pause+speed preserved.

- [x] T021 [P] [US4] Implement `components/lenses/CycleEngine.vue` (radial 8-phase ring, central decision, arc to dispatched component, satellites). (depends on T003, T013)
- [x] T022 [P] [US4] Implement `components/lenses/LivingSystem.vue` (particle field; SVG with a capped particle budget; Canvas fallback hook if budget exceeded). (depends on T003, T013)
- [x] T023 [US4] Lens switcher in `VisualizeView.vue`: bind `playback.lens`; swap component only (SC-007). (depends on T021, T022)
- [x] T024 [P] [US4] Smoke tests: each lens renders a hand-built `CycleFrame` without error and shows the four distinct statuses. (depends on T021, T022)

**Checkpoint**: three lenses, one core, position preserved.

---

## Phase 7: User Story 5 — Hover → trace row (P3)

**Goal**: hover any component → its underlying trace row(s) this frame.

**Independent Test**: hover Decide → decide row; hover a substrate firing → law/outcome/reason row; inactive component says "no activity this cycle".

- [x] T025 [US5] Implement `components/ComponentTooltip.vue`: given `hover.rowId`, resolve from the frame's `rowIds` → show the `TraceRow`. (depends on T013)
- [x] T026 [US5] Emit `onHover(rowId)` from hoverable elements in all three lenses; "no activity this cycle" for `absent` components. (depends on T014, T021, T022, T025)

**Checkpoint**: animation ↔ ground truth bridged.

---

## Phase 8: Polish & cross-cutting

- [x] T027 [P] Fix the pre-existing `stores/trace.ts` TS2322/2345 typing (envelope spread) so the build is clean.
- [x] T028 [P] Perf pass: verify windowed fetches (Network tab), 5,000-cycle first frame <3s, scrub <200ms; cap particle count (SC-004/005).
- [ ] T029 Run `quickstart.md` acceptance walk-through end to end.
- [x] T030 `pnpm -w turbo run build && turbo run test && turbo run lint` all green; commit.

---

## Dependencies & order

- Setup (P1) → Foundational (P2) blocks everything.
- US1 (MVP) after Foundational. US2 after Foundational (uses T012/T017). US3 after US1's Timeline (T015). US4 after host+lensProps. US5 after lenses exist.
- Within a story: tests alongside; reducer/clock before host wiring; host before lenses; lenses before hover.

## Parallel opportunities

- T004/T007/T010 are independent (schema / client / clock).
- T009/T011 (tests) parallel once their targets exist.
- T021/T022 (Engine/System lenses) parallel — different files.
- T027/T028 parallel in polish.

## MVP path

T001–T013 (Setup+Foundational) → T014–T016 (US1) → **STOP & validate legibility** → layer US2→US3→US4→US5 → polish.
