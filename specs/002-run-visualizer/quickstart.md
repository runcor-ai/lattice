# Quickstart: Lattice Run Visualizer

How to run the feature and manually verify it against the reference stuck-loop run.

## Prerequisites

- Monorepo built: `pnpm install && pnpm -w turbo run build`
- A trace SQLite to view. The reference is the 2026-06-06 stuck-loop run (`docs/live-run-2026-06-06.md`); its db is under `apps/bridge-api/data/<lattice-id>.sqlite`. Any run's db works.

## Run

```bash
pnpm --filter @runcor/bridge-api dev      # serves /api/lattices/:id/trace[/stream]
pnpm --filter @runcor/bridge-ui dev       # Vite dev server
```

Open the UI, go to a lattice, click **Visualize** (or navigate to `#/lattice/<id>/visualize`).

## Verify (acceptance walk-through)

1. **Replay & legibility (US1 / SC-001)**: open the stuck-loop run, press play. Within ~15s you should *see* — without reading docs — that the dispatch packet is blocked at the substrate wall every cycle, the items column never changes, and the delegate lane never lights. State the one-sentence hypothesis: "it repeated the same action, items never progressed, it never delegated."
2. **Distinct events (SC-002)**: scrub to a cycle with an item pass (if any) vs. a substrate block vs. a gate fail — each must look different at a glance.
3. **Live (US2 / SC-003)**: start a fresh lattice, open Visualize; new cycles appear within ~2s without refresh. Scrub back into history → new cycles keep arriving on the timeline but the view stays put (FR-012).
4. **Scrub + speed (US3)**: drag to cycle 30 → model shows cycle 30 (<200ms). Set 0.25× → a single phase visibly resolves over ~1s. Step-by-phase advances exactly one phase; step-by-cycle one cycle.
5. **Lens switch (US4 / SC-007)**: at a chosen cycle, switch Board → Engine → System; each renders the same cycle, play/pause and speed preserved.
6. **Hover (US5 / FR-008)**: hover Decide → the decide trace row; hover a substrate firing → its law/outcome/reason row. A component with no activity says "no activity this cycle".
7. **Scale (SC-005)**: open a multi-thousand-cycle run → first interactive frame <3s; scrubbing stays smooth (windowed fetches in the Network tab, not one giant load).

## What to file as follow-ups (not fixed here)

If clock timing, exact item/gate transitions, or full decision rationale look thin in the UI, that is expected — F-V1/F-V2/F-V3 in `spec.md`. The visualizer renders what's emitted and marks the rest "not emitted"; do not extend the runtime to fill these.

## Tests

```bash
pnpm --filter @runcor/bridge-api test     # trace read: full envelope + before_cycle range
pnpm --filter @runcor/bridge-ui test      # frameModel reducer (stuck-loop fixture) + playback clock
```

The decisive automated check is `frameModel.test.ts`: fold the recorded stuck-loop rows and assert the derived frames show no item transitions, no delegations, and a repeated dominant action — the machine-checkable form of the legibility bar.
