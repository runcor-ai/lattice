# Phase 1 Data Model: Lattice Run Visualizer

All types live on the **frontend** (`apps/bridge-ui/src/visualizer/`). The only backend shape is the trace row the read API returns (see `contracts/trace-read.md`). Nothing here is persisted — frames are derived in memory from trace rows.

## Source: TraceRow (what the API returns)

The `trace` table stores `body = JSON.stringify(entry)` — the **entire flat entry**, so `cycle`, `at_ms`, `kind`, and `phase` (for phase/substrate) are already inside `body`. The historical read returns the parsed flat entry; the bridge edit only **attaches the DB row `id`** (not present in body) for stable hover/ordering, and adds `before_cycle` windowing. So `TraceRow` is the flat entry plus `id`:

```ts
type TraceRow = {
  id: number;                    // DB row id, attached by the API (NOT in body)
  cycle: number;
  at_ms: number;
  kind: 'phase' | 'substrate' | 'subconscious' | 'job' | 'operator';
  phase?: string;                // present for kind='phase'|'substrate'
  [k: string]: unknown;          // kind-specific fields, flat (table below)
};
```

This matches the shape the live SSE store already consumes (flat `entry.kind/cycle/phase`), so historical + live fold through one reducer.

Body shapes (from runtime source — `cycle.ts`, `act.ts`, `judge.ts`, `write.ts`, `decide.ts`):

| kind | fields used by the visualizer |
|---|---|
| `phase` | `phase`, `duration_ms`, `result` (`ok`/`failed`), `output_summary` (e.g. observe→`senses=N`, act→action+result), `failed_reason?` |
| `substrate` | `phase` (`act`/`judge`), `law` (`persistence`/`no-progress`/the 11), `outcome` (`pass`/`modify`/`block`/`escalate`), `reason` |
| `subconscious` | `rule`, `memory_id?`, `was?`, `now?` — **item pass** = `rule:'auto-attempt-deterministic'`, `memory_id`=item id, `now:'item … passed: …'` |
| `job` | `event` (`closed_full`/`closed_partial`/`item_appended`/…), `job_id`, `detail` |
| `operator` | `action`, `detail` — lifecycle/drift/usage notes |

## Derived: CycleFrame (the unit every lens renders)

```ts
interface CycleFrame {
  cycle: number;
  phases: PhaseSlice[];              // ordered observe..pulse; absent phase => status 'skipped'
  components: ComponentStates;       // end-of-cycle component state
  transitions: Transition[];         // what CHANGED this cycle (drives "obvious" motion, FR-002)
  rowIds: number[];                  // trace row ids folded into this frame (for hover, FR-008)
}

interface PhaseSlice {
  phase: 'observe'|'ground'|'recall'|'decide'|'act'|'judge'|'write'|'pulse';
  status: 'active' | 'ok' | 'failed' | 'skipped';
  durationMs?: number;
  summary?: string;                  // output_summary
  rowId?: number;
}

interface ComponentStates {
  senses:   { reads: string[]; status: ComponentStatus };
  decide:   { action: string | null; blocks?: number; durationMs?: number; status: ComponentStatus };
  dispatch: { action: string | null; result?: 'ok'|'failed'; blockedBy?: string; status: ComponentStatus };
  gates:    { item: string; result: 'pass'|'fail' }[];     // from auto-attempt rows this cycle
  items:    ItemState[];             // running set, with changedThisCycle marked
  substrate:{ law: string; outcome: 'pass'|'modify'|'block'|'escalate'; phase: string; reason: string }[];
  memory:   { identity: number; episodic: number; semantic: number; plan: number };  // running counts (best-effort)
  clocks:   { fast: boolean; medium: boolean; slow: boolean };   // fast=every cycle; medium=cycle%N; slow=best-effort
  delegate: { brief: string } | null;  // set when dispatch.action is a delegate capability
}

type ComponentStatus = 'idle' | 'active' | 'firing' | 'blocked' | 'changed' | 'absent';

interface ItemState {
  id: string;
  label: string;
  state: 'open' | 'passed' | 'deferred' | 'blocked';
  changedThisCycle: boolean;
}

interface Transition {           // the high-salience events a first-time viewer must catch (SC-002)
  kind: 'item-passed' | 'gate-pass' | 'gate-fail' | 'substrate-fired' | 'delegation' | 'job-closed';
  label: string;
  rowId: number;
}
```

### Derivation rules (folded in `(cycle, at_ms, id)` order)

- **Phase rows** → fill the matching `PhaseSlice` (status from `result`); `decide` row → `components.decide.action` (parsed from `output_summary`); `act` row → `components.dispatch.{action,result}`; `observe` → `components.senses`.
- **Substrate rows** → append to `components.substrate`; if `outcome ∈ {block,modify,escalate}` and `phase='act'`, set `dispatch.blockedBy = law`, `dispatch.status='blocked'`, and emit a `substrate-fired` transition.
- **Subconscious `auto-attempt-deterministic`** → mark the named item `passed` + `changedThisCycle`, push a `gate-pass` + `item-passed` transition.
- **Job `item_appended`** → add an `open` item; **`closed_full`/`closed_partial`** → emit `job-closed` transition.
- **Dispatch action that is a delegate capability** → set `components.delegate`, emit a `delegation` transition. (Delegate capability names are matched against the lattice's tool manifest, surfaced once at load.)
- **Clocks**: `fast=true` every cycle; `medium = (cycle % N === 0)` where N is the medium-clock cadence (default surfaced at load; fallback 20); `slow` best-effort from slow-clock operator/trace rows if present, else false. *(Per F-V1, these are cadence-derived, not discrete events.)*

### State transitions (item lifecycle, as reconstructed)

```
open ──auto-attempt-deterministic passes──▶ passed
open ──(deferral reason recorded)─────────▶ deferred
open ──(unblock pending)──────────────────▶ blocked ──unblock──▶ open
```

Reconstruction caveat (F-V2): `open→passed` is exact (subconscious row). `deferred`/`blocked` are partially implicit; where the trace doesn't carry the transition, the item shows its last-known state and the component renders `absent`/"not emitted" rather than guessing.

## Derived: PlaybackState (the clock, lens-agnostic)

```ts
interface PlaybackState {
  cycle: number;            // current playhead cycle
  phaseIndex: number;       // 0..7 sub-position within the cycle
  playing: boolean;
  speed: number;            // 0.25 .. 10
  followLive: boolean;      // true only while cycle === latestCycle
  lens: 'board' | 'engine' | 'system';
  latestCycle: number;      // max cycle known (grows as SSE arrives)
  hover: { rowId: number } | null;
}
```

## Derived: RunModel (the windowed store the composable owns)

```ts
interface RunModel {
  latticeId: string;
  framesWindow: Map<number, CycleFrame>;   // bounded ring around the playhead
  checkpoints: Map<number, ComponentStates>; // every K cycles (D4)
  latestCycle: number;
  delegateCapabilityNames: Set<string>;
  mediumClockCadence: number;
  loadWindow(centerCycle: number): Promise<void>;  // fetch [c-W, c+W] via traceRange
  ingestLiveRow(row: TraceRow): void;              // fold SSE row, extend latestCycle
  frameAt(cycle: number): CycleFrame | undefined;  // from window or reconstruct from checkpoint
}
```

## Key entities ↔ spec

| Spec entity | Type here |
|---|---|
| Run | `RunModel` |
| Cycle Frame | `CycleFrame` (+ `PhaseSlice` for phase grain) |
| Phase Event | `TraceRow` |
| Component | `ComponentStates` field + `ComponentStatus` |
| Lens | a Vue component consuming `{ frame: CycleFrame, playback: PlaybackState }` |
| Playback State | `PlaybackState` |
