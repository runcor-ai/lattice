# Phase 0 Research: Lattice Run Visualizer

All Technical Context items were resolvable from the existing codebase + spec; no open NEEDS CLARIFICATION remained. The decisions below record the reasoning so planning/tasks are grounded.

## D1 — Trace read path must return the full envelope

**Decision**: Extend `GET /api/lattices/:id/trace` to return the full row `{ id, cycle, at_ms, kind, phase, body }` (body parsed to an object), not just `safeJson(row.body)`.

**Rationale**: Today the handler does `rows.map((row) => safeJson(row.body))` (server.ts:206) — it discards `cycle`, `at_ms`, `kind`, `phase`, and `id`. The visualizer's frame model is keyed on `(cycle, phase, kind)`; without the envelope the frontend would have to guess cycle boundaries from body contents, which is fragile and breaks the legibility bar. The SSE stream already carries the full envelope, so making the historical read match it gives one row shape for both paths.

**Alternatives considered**: (a) Parse cycle/phase out of `body` — rejected; not all bodies carry them and it couples the UI to body internals. (b) A brand-new `/frames` endpoint that returns derived frames server-side — deferred; richer than v1 needs and would duplicate the derivation logic. The frontend reducer is the single source of truth for v1; a server `/frames` summary remains a clean future optimization (kept as a contract option, not built).

## D2 — Cycle-range windowing via `before_cycle`

**Decision**: Add `before_cycle` to `TraceQuerySchema` (alongside the existing `after_cycle`, `kind`, `phase`, `limit`). Scrubbing fetches the window `[target - W, target + W]`.

**Rationale**: `after_cycle` exists but there is no upper bound, so a scrub to cycle 30 of a 5,000-cycle run would over-fetch. A symmetric range + `limit` keeps each fetch bounded (SC-005). SQL already filters `cycle > ?`; adding `cycle < ?` is one clause.

**Alternatives**: Offset pagination — rejected; cycle is the natural, stable key and the X axis of the timeline.

## D3 — Frame derivation is a pure, incremental reducer on the frontend

**Decision**: `frameModel.ts` exposes a pure reducer: `applyRow(state, row) → state` and a `frameAt(cycle)` projector. Frames are built by folding trace rows in `(cycle, at_ms, id)` order. Live rows from SSE fold onto the same state.

**Rationale**: One deterministic function feeds all three lenses (FR-009/FR-010) and is trivially unit-testable against the recorded stuck-loop run (the legibility bar, SC-001). Incremental folding makes live playback O(rows-in-cycle) per cycle and lets historical windows extend the model without a full rebuild.

**Alternatives**: Per-lens ad-hoc parsing — rejected; would let lenses disagree about state and triples the bug surface. Server-side derivation — deferred (see D1).

## D4 — Frame checkpoints for far scrubs

**Decision**: Every K cycles (K≈50) snapshot the reduced component state. A scrub to cycle C reconstructs from the nearest checkpoint ≤ C by folding forward only the rows in `(checkpoint, C]`.

**Rationale**: Meets SC-004 (<200ms scrub) without keeping every cycle's full frame in memory and without re-folding from cycle 0. Checkpoints are small (component-state snapshot, not raw rows).

**Alternatives**: Keep every frame materialized — rejected; unbounded memory for thousands of cycles. Re-fold from 0 each scrub — rejected; O(N) per scrub fails SC-004 at scale.

## D5 — SVG-first rendering, Canvas only for the particle lens at scale

**Decision**: Render lenses as Vue-templated SVG. The Living System particle lens caps concurrently animated particles and may fall back to a Canvas layer if its element count exceeds a budget.

**Rationale**: SVG gives free DOM hover/tooltip (FR-008) and crisp state styling from `tokens.css`; the Board and Engine lenses are O(1) components + small lists, well within SVG's comfort zone. Only the particle field risks element-count blowups, so its fallback is localized.

**Alternatives**: Canvas/WebGL everywhere — rejected; loses cheap hover-to-trace and reuse of CSS tokens, over-engineered for two of three lenses. A charting lib — rejected; no new dependency, and none of these are charts.

## D6 — One playback clock, lens-agnostic

**Decision**: `playback.ts` owns `{ cycle, phaseIndex, playing, speed, followLive }` and advances on `requestAnimationFrame` with a phase-duration scaled by `speed` (0.25×–10×). Lens switch reads the same state; it does not reset.

**Rationale**: Guarantees SC-007 (lens switch preserves position) and FR-007 by construction — speed and position live above the lenses. Step-by-phase/cycle are discrete advances of the same state.

**Alternatives**: Per-lens animation timers — rejected; lens switch would lose place and speeds could diverge.

## D7 — Live vs. scrub coexistence

**Decision**: `followLive` is true only while the playhead is at the latest known cycle. Incoming SSE rows always extend the model + timeline length; they advance the playhead only when `followLive` (FR-012).

**Rationale**: Satisfies FR-012/SC-003 without yanking an operator who has scrubbed into history.

## D8 — Data sufficiency confirmed; three thin spots filed as follow-ups

**Decision**: v1 derives clocks from cadence (fast=every cycle, medium=cycle%N) and reconstructs item/gate transitions from subconscious-sweep + job rows; decision detail is shown at the summary level the decide row carries. Gaps are surfaced (spec F-V1/F-V2/F-V3), **not** patched into the runtime.

**Rationale**: Honors FR-011/FR-014. What's emitted is sufficient for the legibility bar (the stuck-loop run is legible from act-result sameness + absent item transitions + absent delegate, all present in trace). The follow-ups would make item/gate motion exact rather than reconstructed — a quality improvement, not a v1 blocker.

**Open verification carried into Phase 1**: confirm against a real trace which rows carry item-state transitions (job events vs. subconscious sweep) so `frameModel.ts` reconstructs them correctly. Captured as a data-model note + a quickstart manual check, not a clarification.
