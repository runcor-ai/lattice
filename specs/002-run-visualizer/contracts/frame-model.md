# Contract: Frame Model ↔ Lens (frontend)

The boundary every visual lens depends on. A lens is a **pure renderer** of this contract; it MUST NOT read the trace API, own a clock, or hold cross-cycle state. This is what makes "three lenses, one core" true (FR-009/FR-010) and lets each lens be smoke-tested with a hand-built frame.

## Props every lens receives (`lensProps.ts`)

```ts
interface LensProps {
  frame: CycleFrame;          // the current cycle's derived state (see data-model.md)
  playback: PlaybackState;    // cycle, phaseIndex, playing, speed, lens, hover
  onHover: (rowId: number | null) => void;   // component hover → trace row (FR-008)
}
```

A lens renders `frame.components` + `frame.transitions`, highlighting the phase at `playback.phaseIndex`. It emits `onHover(rowId)` from any element bound to a `rowId`; the host shows the trace row.

## Invariants the core guarantees to lenses

1. `frame` is internally consistent for one cycle (no half-applied rows).
2. `frame.transitions` lists exactly the changes that happened *entering* this cycle — the events a first-time viewer must catch (SC-002). A lens MUST make each `transition.kind` visually distinct.
3. Component `status` values map to fixed visual meaning across all lenses:
   - `idle` (background), `active` (this phase touched it), `firing` (substrate law), `blocked` (dispatch stopped), `changed` (state moved — item passed / job closed), `absent` ("not emitted this cycle").
4. Colours come from `tokens.css` only: substrate `#c084fc`, subconscious `#67e8f9`, accent sky-300 `#7dd3fc`, status green/yellow/orange/red. No lens hard-codes a hex.

## Host responsibilities (NOT the lens's)

- Own the single `PlaybackState` and advance it (`playback.ts`).
- Own windowed loading + live SSE + checkpoints (`useRunFrames.ts` / `RunModel`).
- Provide `frameAt(cycle)` and re-render the active lens when `playback.cycle` changes.
- Render the timeline/controls and the hover tooltip (shared chrome, not per-lens).

## Lens switch contract

Switching `playback.lens` swaps the rendered component only. `cycle`, `phaseIndex`, `playing`, `speed`, `followLive`, `hover` are untouched (SC-007). Because each lens is a pure function of `(frame, playback)`, the new lens renders the same cycle immediately.

## The three lenses (rendering obligations)

| Lens | Foreground | Loop must read as |
|---|---|---|
| `OrchestrationBoard` | dispatch packet, substrate wall, delegate lane, items column | packet dies at the wall each cycle; items column static; delegate lane never lights |
| `CycleEngine` | 8-phase ring, central decision, arc to dispatched component | identical revolutions; same centre action; inert satellites |
| `LivingSystem` | bodies + particles + membranes + repelling law-fields | dense decide→workspace stream repelled; gates/items untouched |

Each lens independently MUST pass the legibility bar (SC-001) on the recorded stuck-loop run.
