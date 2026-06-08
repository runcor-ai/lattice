# Feature Specification: Lattice Run Visualizer

**Feature Branch**: `002-run-visualizer`

**Created**: 2026-06-06

**Status**: Draft (awaiting sign-off)

**Input**: Build a bridge-served playback simulator for lattice runs that renders each cycle's phases as animated motion, so an operator reasons about orchestration behaviour visually instead of reading SQL trace rows. Three switchable visual models over one shared playback core; live playback, scrub, variable speed; reads the existing trace SQLite with no runtime changes.

---

## Context: what is being visualized

A lattice run is a sequence of **cycles**. Each cycle runs eight **phases** in fixed order — `observe → ground → recall → decide → act → judge → write → pulse` — and emits structured trace rows. The visualizer renders the lattice's **components** and shows them in motion as the run plays:

| Component | What it is | Active in phase(s) |
|---|---|---|
| Senses | Read-only inputs (fs-read, echo, …) | observe |
| Decide | The model call that chooses one action | decide |
| Dispatch / action | The single capability invoked this cycle (incl. `delegate`) | act |
| Gates | Completion checks on plan items (file_exists, content_contains, command, …) | write (sweep), act (close) |
| Items | Plan items and their state (open / passed / deferred / blocked) | write, act |
| Substrate laws | Persistence, no-progress, the eleven judge-phase laws | judge, act |
| Memory tiers | identity / episodic / semantic, plus plan | recall, write |
| Clocks | fast (every cycle), medium (every N), slow (worker) | write |
| Delegate / executor | Subtask handed to a coding agent | act |
| Cycle loop | The heartbeat itself | all |

The orchestration story of a cycle is: *what was sensed → what was decided → what was dispatched → was it blocked by a substrate law → did any item move or gate clear → was anything delegated.* The visualizer makes that story **motion**.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Replay a finished run and understand it without docs (Priority: P1)

An operator opens the visualizer on a completed lattice run and presses play. The visual model animates cycle by cycle. Within seconds the operator forms a correct hypothesis about what the lattice did — including spotting a pathology like the 2026-06-06 run's 56-cycle `workspace` loop (no gate transitions, no delegations) — without reading any documentation.

**Why this priority**: This is the entire point. If a recorded run cannot be made legible as motion, nothing else matters. It is the minimum viable product.

**Independent Test**: Load `lat-q00qkoc8` (the recorded stuck-loop run), press play, and confirm a viewer unfamiliar with the run concludes "it kept doing the same action, items never moved, it never delegated" — purely from watching.

**Acceptance Scenarios**:

1. **Given** a completed run's trace, **When** the operator opens the visualizer and presses play, **Then** the model animates each cycle's phases in order with the current cycle and phase always visible.
2. **Given** a run with a stuck loop (same dominant action, no item-state changes), **When** it plays, **Then** the repetition, the inert items, and the absent delegate are each visually obvious within the first ~10 seconds of playback.
3. **Given** a run where an item transitions open→passed, **When** that cycle plays, **Then** the transition is unmistakable (distinct from a gate failing or an action being blocked).

---

### User Story 2 — Watch a run as it happens (live) (Priority: P1)

An operator opens the visualizer on a lattice that is currently running. New frames advance automatically as cycles complete. The operator watches orchestration behaviour unfold in real time.

**Why this priority**: Live observation is half the value — catching drift while it happens, not autopsying it later.

**Independent Test**: Start a lattice, open the visualizer, and confirm the model advances on its own as the lattice completes cycles, with no manual refresh.

**Acceptance Scenarios**:

1. **Given** an active lattice, **When** a new cycle completes, **Then** the visualizer advances to (or, if the operator is "following live", lands on) the new frame within a couple of seconds.
2. **Given** the operator has scrubbed back into history while a run is live, **When** new cycles arrive, **Then** their position is reachable on the timeline but the view does not jump away from where the operator is looking unless "follow live" is on.
3. **Given** a lattice that pauses (no open jobs), **When** it idles, **Then** the visualizer shows the run has gone quiet rather than appearing frozen/broken.

---

### User Story 3 — Scrub and control playback speed (Priority: P2)

The operator drags a timeline at the bottom (cycles on the X axis) to jump the model to any cycle's state, and controls playback: play, pause, step one phase, step one cycle, and speed from 0.25× slow-motion to 10× fast-forward.

**Why this priority**: Some failures are only legible at the right speed. Slow-motion lets a single phase resolve over seconds; fast-forward lets a thousand-cycle run be skimmed for the moment something changed.

**Independent Test**: On a recorded run, drag the scrubber to cycle 30 and confirm the model shows cycle 30's state; set speed to 0.25× and confirm a single phase visibly resolves over ~1 second; step-by-phase and confirm exactly one phase advances per press.

**Acceptance Scenarios**:

1. **Given** any run, **When** the operator drags the scrubber to cycle K, **Then** the model jumps to cycle K's end-of-cycle state (and the cycle/phase markers update).
2. **Given** playback is running, **When** the operator changes speed, **Then** the animation rate changes accordingly across the full 0.25×–10× range without skipping frames at slow speeds.
3. **Given** playback is paused, **When** the operator presses step-by-phase, **Then** the model advances exactly one phase; step-by-cycle advances exactly one full cycle.

---

### User Story 4 — Switch between the three visual models (Priority: P2)

The operator toggles between three lenses on the same run — **Orchestration Board**, **Cycle Engine (radial)**, and **Living System (particle field)** — without losing their place (same cycle, same playback state).

**Why this priority**: Different lenses make different things legible; the board reads dataflow and blocks best, the radial reads the cycle heartbeat best, the field conveys overall "motion". One core, three renderings.

**Independent Test**: At cycle 23 of the stuck-loop run, switch lens; confirm all three render cycle 23's state and the playback position/speed is preserved across the switch.

**Acceptance Scenarios**:

1. **Given** the operator is at cycle K in one lens, **When** they switch lens, **Then** the new lens renders cycle K's state and preserves play/pause and speed.
2. **Given** any lens, **When** the stuck-loop run plays, **Then** the pathology (repetition, inert items, no delegation) is legible in that lens (each lens meets the legibility bar).

---

### User Story 5 — Inspect what a component actually did (Priority: P3)

Hovering any component in any lens reveals the underlying trace row(s) for the current frame — the ground truth behind the animation.

**Why this priority**: The animation is the hypothesis-former; the trace row is the confirmation. Bridges the visual back to the data when the operator wants certainty.

**Independent Test**: Hover the Decide component at cycle 23 and confirm the decide trace row (chosen action, blocks, duration) is shown; hover a substrate firing and confirm the law/outcome/reason row appears.

**Acceptance Scenarios**:

1. **Given** the model is on cycle K, **When** the operator hovers a component, **Then** the underlying trace row(s) that produced that component's state this frame are shown.
2. **Given** a component had no activity this frame, **When** hovered, **Then** it indicates "no activity this cycle" rather than stale data from an earlier cycle.

---

### Edge Cases

- **Empty / cycle-0 run**: a lattice with no completed cycles shows an explicit empty state, not a broken canvas.
- **Thousands of cycles**: a 5,000-cycle run scrubs and plays smoothly without loading every row at once (see Success Criteria SC-005).
- **Sparse phases**: a cycle that rolled back (no commit) or a phase with no trace row renders as "skipped/absent", distinct from "active".
- **Live + scrubbing simultaneously**: new live cycles do not yank the operator's view while they are scrubbing history.
- **Trace gaps**: if a signal the visualizer wants is not emitted by the lattice (see Data Sufficiency), the component renders an explicit "not emitted" state rather than guessing.
- **Run deleted / db missing**: opening a lattice whose trace SQLite is gone shows a clear error, not a hang.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST render a lattice run as an animated visual model in which orchestration components are spatial elements that animate when active in a phase.
- **FR-002**: The system MUST make state changes visually distinct: an item open→passed, a gate pass vs. a gate fail, and a substrate-law firing MUST each look unmistakably different from one another and from inactivity.
- **FR-003**: The system MUST always display the current cycle number and current phase.
- **FR-004**: The system MUST support live playback: while a lattice is running, new cycles MUST appear in the visualizer automatically without manual refresh.
- **FR-005**: The system MUST provide a timeline (cycles on the X axis) the operator can drag to jump the model to any cycle's state.
- **FR-006**: The system MUST provide playback controls: play, pause, step-by-phase, step-by-cycle.
- **FR-007**: The system MUST provide variable speed from approximately 0.25× (slow-motion) to approximately 10× (fast-forward), with slow speeds resolving individual phases legibly.
- **FR-008**: The system MUST let the operator hover any component to see the underlying trace row(s) for the current frame.
- **FR-009**: The system MUST offer three switchable visual models (Orchestration Board, Cycle Engine, Living System) over a single shared playback core, preserving cycle position and playback state across a switch.
- **FR-010**: Each of the three visual models MUST independently meet the legibility bar (SC-001) for the reference stuck-loop run.
- **FR-011**: The system MUST read only from the lattice's existing trace store; it MUST NOT add any new write path and MUST NOT require any change to the lattice runtime.
- **FR-012**: When following live, new cycles MUST advance the view; when the operator has scrubbed into history, new live cycles MUST NOT move the operator's view (but MUST remain reachable on the timeline).
- **FR-013**: The system MUST render explicit states for: empty/no-cycles, paused/idle run, skipped/absent phase, and "signal not emitted by the lattice".
- **FR-014**: The system MUST surface, as documented follow-up items, any per-frame signal the visualization wants that the lattice does not currently emit sufficiently — without extending the runtime to supply it.
- **FR-015**: The visualizer MUST be reachable from the existing per-lattice view and MUST operate on a single named lattice run.

### Key Entities *(include if feature involves data)*

- **Run**: one lattice's life recorded in its trace store, identified by lattice id. Has an ordered set of cycles.
- **Cycle Frame**: the derived state of all components at a given cycle (and, at finer grain, at a given phase within the cycle). The unit the visual model renders. Derived incrementally from trace rows, not stored.
- **Phase Event**: a single trace row attributed to a (cycle, phase, component) — e.g. a decide output, a substrate firing, an item transition, a memory write. The atom from which Cycle Frames are composed.
- **Component**: a visual element standing for a lattice subsystem (senses, decide, dispatch, gates, items, substrate, memory tiers, clocks, delegate, cycle loop). Has per-frame visual state (idle / active / firing / blocked / changed).
- **Lens**: one of the three visual models. A renderer over the shared Cycle Frame stream.
- **Playback State**: current cycle, current phase, play/pause, speed, follow-live flag, selected lens.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001 (the legibility bar)**: An operator who has never seen a given run can watch a 60-cycle replay and state a correct one-sentence hypothesis of what the lattice did, without consulting documentation. For the reference stuck-loop run, ≥ 80% of first-time viewers identify "repeated the same action, items never progressed, never delegated" within 15 seconds of playback.
- **SC-002**: An item state change, a gate pass, a gate fail, and a substrate-law firing are each identifiable as distinct events by a first-time viewer in a blind test (no legend), ≥ 90% correct.
- **SC-003**: Live playback advances within 2 seconds of a cycle completing on an active lattice.
- **SC-004**: Scrubbing to any cycle updates the model in under 200 ms (feels instant) for runs up to 1,000 cycles.
- **SC-005**: A 5,000-cycle run loads to first interactive frame in under 3 seconds and scrubs smoothly without fetching all rows at once (windowed loading).
- **SC-006**: At 0.25× speed a single phase's animation resolves over ≥ ~0.8 seconds (legibly watchable); at 10× a 60-cycle run plays through in roughly the time of a 6× skim, without dropping cycles.
- **SC-007**: Switching lenses preserves the exact cycle position and playback state (0 perceived jump in "where am I").

---

## Assumptions

- The existing trace store (`data/<lattice-id>.sqlite`, plus the live SSE trace stream the bridge already serves) carries enough per-cycle/per-phase structure to derive Cycle Frames for v1. Gaps are handled by FR-013/FR-014, not by changing the runtime.
- The visualizer is an addition to the existing bridge UI (Vue 3 + Pinia + Vite) and reuses its design tokens; it is **not** React (the prompt's "React" is overridden — the existing UI is Vue).
- The visualizer lives at a dedicated full-screen route for one lattice (`/lattice/:id/visualize`), linked from the existing inspect view. (Operator may revisit placement; dedicated route assumed because three switchable lenses need the viewport.)
- Rendering is SVG-first (crisp hover/state, DOM events); Canvas is a fallback only if a lens (e.g. the particle field at high cycle counts) demands it.
- "Clocks" are partially derived from cadence (fast = every cycle, medium = every N) rather than discrete trace events — see Data Sufficiency.
- Out of scope for v1: comparison views across runs; editing or replaying with modifications; exporting to video; mobile.

---

## Technical contract & design (for planning)

> Included at the operator's request so the spec covers the event-stream API contract, the frame data model, scrub/playback semantics, and the performance approach. Implementation choices are firmed up in `plan.md`; this section pins the contracts the design must satisfy.

### The three visual models (the high-leverage design)

All three are renderers over one **Cycle Frame** stream. Foreground vs. background and the meaning of motion/colour are fixed here; the operator chose to ship all three.

**Lens A — Orchestration Board** (dataflow, left→right). Foreground: dispatch, the substrate "wall", the delegate lane, the items column. A packet flows senses→decide→dispatch each cycle; a substrate firing is a wall the packet hits (turns red, stops); a passing gate lets an item flip; the delegate lane lights only on a `delegate` action. *Loop reads as:* packet dies at the wall every cycle, items column static, delegate lane never lights.

```
CYCLE 23 ▸ act      [▶ ❚❚ ⏭φ ⏭cyc]  speed 0.25×━━10×
 SENSES   DECIDE      DISPATCH      GATES·ITEMS   MEMORY
 ┌────┐  ┌───────┐   ┌─────────┐   ┌──────────┐  ┌─────┐
 │fs ●│─●▶│action │─●▶│workspace│╳  │▣ plan  ◻│  │epi ▒│
 │ws ●│  │workspc│   │ BLOCKED │▲  │◻ index ◻│  │sem ▒│
 └────┘  │ ↻×23  │   └─────────┘│  │◻ readme◻│  └─────┘
         └───────┘   no-progress┘  └──────────┘
 DELEGATE → executor COLD (0 delegations all run)
 ├──────────────●23──────────────────────────────┤ 0──60
```

**Lens B — Cycle Engine** (radial heartbeat). Foreground: the 8-phase ring and the central decision. A pulse orbits once per cycle; the centre holds the chosen action; arcs fire from centre to the dispatched component; clocks/memory/items/substrate are satellites. *Loop reads as:* identical monotonous revolutions, same centre action, satellites inert.

**Lens C — Living System** (particle field). Foreground: motion itself. Components are bodies; data are particles; decide emits a particle that collides with a component; gates are membranes (pass/bounce); substrate laws repel; memory accretes. *Loop reads as:* a dense recurring decide→workspace stream repelled by the no-progress field; gates/items untouched.

### Event-stream & history API contract (read-only, bridge side)

- **Live**: reuse the existing trace SSE stream (`/api/lattices/:id/trace/stream`, `trace` events carrying one trace row each). The visualizer's frame builder consumes the same stream the trace list already uses; no new live endpoint required unless the existing event shape is insufficient.
- **History (new)**: a windowed range read, e.g. `GET /api/lattices/:id/trace?after_cycle=&before_cycle=&limit=` (extend the existing trace query with a cycle range), returning trace rows ordered by (cycle, at_ms). Scrubbing fetches only the window around the target cycle.
- Optionally, a **frame summary** read: `GET /api/lattices/:id/frames?from=&to=` returning pre-reduced per-cycle summaries (dominant action, item-state set, substrate firings, delegate?, gate results) so the timeline and far scrubs don't need raw rows. Whether this is server-derived or client-derived is a planning decision; the contract is "the timeline and coarse scrub must not require all raw rows".
- Hard constraint: **read-only**. No new write path; no runtime change.

### Frame data model (what the frontend consumes)

A `CycleFrame` derived from trace rows: `{ cycle, phases: PhaseSlice[8], components: {senses, decide:{action,blocks,durationMs}, dispatch:{action,result,blockedBy?}, gates:[{item,result}], items:[{id,state,changedThisCycle}], substrate:[{law,outcome}], memory:{identity,episodic,semantic,plan counts}, clocks:{fast,medium?,slow?}, delegate?:{brief}}, transitions: [...] }`. Frames are derived **incrementally** — appending a cycle's rows extends the model in O(rows-in-cycle); scrubbing to cycle K reconstructs K's frame from a nearby checkpoint + forward replay, not from cycle 0.

### Scrub / playback semantics

- Timeline X = cycle index; the playhead = current cycle. Phase is a sub-position within a cycle.
- Play advances the playhead at the chosen rate; speed scales phase duration (0.25×–10×). Step-by-phase advances one PhaseSlice; step-by-cycle advances one CycleFrame.
- Follow-live: when the playhead is at the latest cycle, new cycles advance it; when the operator scrubs back, follow-live disengages until they return to the head.

### Performance approach (thousands of cycles)

- Windowed history loading: fetch rows only for the visible/near cycles; keep a bounded ring in memory.
- Frame checkpoints: periodic reduced snapshots so a far scrub reconstructs from the nearest checkpoint forward, not from 0.
- Coarse timeline from frame summaries (not raw rows), so the full-run overview is cheap.
- SVG element budget per frame is bounded (components are O(1), items/substrate are small lists); the particle lens caps live particles and may fall back to Canvas if its element count blows the budget.

### Data sufficiency & follow-ups (surfaced, not fixed by changing the runtime)

The lattice already emits most of what's needed (phase rows with summaries, substrate firings with law/outcome, job item events, subconscious sweep passes, act results incl. the delegate action). Known thin spots to file as **follow-ups**, per FR-014 (do not extend the runtime here):

- **F-V1 — clock ticks aren't discrete events.** Fast/medium clocks run inside the write phase without a per-tick trace; the slow clock is a separate worker. v1 derives them from cadence (fast = every cycle, medium = cycle % N). A future `clock-tick` trace would let the visualizer show real tick timing/cost.
- **F-V2 — item transitions are partly implicit.** Item passes show up via subconscious-sweep rows and job events; blocked→unblocked (Item 5 chaining) and per-gate pass/fail detail are less explicit. A dedicated `item-transition` / `gate-eval` trace event would make Lens-A/B item motion exact rather than reconstructed.
- **F-V3 — decision content is summary-level.** The decide row carries `action=…;blocks=N`; the full R++ rationale isn't in the trace. Hover can show what exists; richer decision inspection would need the decider to persist more.

These are visualization follow-ups, not blockers — v1 renders what is emitted and marks the rest "not emitted" (FR-013).
