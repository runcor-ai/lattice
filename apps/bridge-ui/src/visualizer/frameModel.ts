import type { TraceRow } from '@runcor/bridge-shared';

/**
 * frameModel — derive per-cycle visual frames from flat trace rows.
 *
 * This is the shared core. All three lenses are pure renderers of the
 * CycleFrame this produces; they never read the trace themselves. The
 * derivation is a pure fold over rows ordered by id, so historical
 * (windowed) rows and live SSE rows compose through the same path, and
 * a window can be reconstructed from a checkpoint by seeding `initialItems`.
 *
 * Trace body shapes (verified against the runtime) are flat:
 *   phase:        { phase, duration_ms, result, output_summary }
 *                 output_summary: observe=senses=N, decide=action=X;blocks=N,
 *                 act=result=ok|failed, write=writes=N, …
 *   substrate:    { phase, law, outcome, reason }
 *   subconscious: { rule, memory_id?, was?, now? }  (item pass = auto-attempt-deterministic)
 *   job:          { event, job_id, detail }
 *   operator:     { action, detail }
 */

export const PHASE_ORDER = [
  'observe',
  'ground',
  'recall',
  'decide',
  'act',
  'judge',
  'write',
  'pulse',
] as const;

export type Phase = (typeof PHASE_ORDER)[number];

export type ComponentStatus =
  | 'idle'
  | 'active'
  | 'firing'
  | 'blocked'
  | 'changed'
  | 'absent';

export interface PhaseSlice {
  phase: Phase;
  status: 'active' | 'ok' | 'failed' | 'skipped';
  durationMs?: number;
  summary?: string;
  rowId?: number;
}

export interface ItemState {
  id: string;
  label: string;
  state: 'open' | 'passed' | 'deferred' | 'blocked';
  changedThisCycle: boolean;
}

export interface SubstrateFiring {
  law: string;
  outcome: 'pass' | 'modify' | 'block' | 'escalate';
  phase: string;
  reason: string;
  rowId: number;
}

export type TransitionKind =
  | 'item-passed'
  | 'gate-pass'
  | 'gate-fail'
  | 'substrate-fired'
  | 'delegation'
  | 'job-closed';

export interface Transition {
  kind: TransitionKind;
  label: string;
  rowId: number;
}

export interface ComponentStates {
  senses: { count: number; status: ComponentStatus };
  decide: { action: string | null; blocks: number; durationMs?: number; status: ComponentStatus };
  dispatch: {
    action: string | null;
    result?: 'ok' | 'failed';
    blockedBy?: string;
    status: ComponentStatus;
  };
  gates: { item: string; result: 'pass' | 'fail'; rowId: number }[];
  items: ItemState[];
  substrate: SubstrateFiring[];
  memory: { writes: number; status: ComponentStatus };
  clocks: { fast: boolean; medium: boolean; slow: boolean };
  delegate: { brief: string } | null;
}

export interface CycleFrame {
  cycle: number;
  phases: PhaseSlice[];
  components: ComponentStates;
  transitions: Transition[];
  rowIds: number[];
}

export interface DeriveOpts {
  /** Capability names that count as delegation (from the lattice's manifest). */
  delegateNames?: ReadonlySet<string>;
  /** Medium-clock cadence; medium tick = cycle % cadence === 0. Default 20. */
  mediumCadence?: number;
  /** Item state carried in from a checkpoint (state as of before the first row). */
  initialItems?: ItemState[];
}

function emptyPhases(): PhaseSlice[] {
  return PHASE_ORDER.map((phase) => ({ phase, status: 'skipped' as const }));
}

function parseSummary(summary: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!summary) return m;
  for (const part of summary.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) m.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return m;
}

/** Group rows into contiguous cycles, preserving id order within each. */
function groupByCycle(rows: TraceRow[]): Map<number, TraceRow[]> {
  const groups = new Map<number, TraceRow[]>();
  for (const row of rows) {
    const arr = groups.get(row.cycle);
    if (arr) arr.push(row);
    else groups.set(row.cycle, [row]);
  }
  return groups;
}

/**
 * Derive frames for a contiguous run of rows. Item state is threaded across
 * cycles starting from `initialItems`, so each frame reflects state AS OF the
 * end of its cycle (not the latest).
 */
export function deriveFrames(rows: TraceRow[], opts: DeriveOpts = {}): CycleFrame[] {
  const delegateNames = opts.delegateNames ?? new Set<string>();
  const mediumCadence = opts.mediumCadence && opts.mediumCadence > 0 ? opts.mediumCadence : 20;

  // Running item state, threaded across cycles.
  const items = new Map<string, ItemState>();
  for (const it of opts.initialItems ?? []) items.set(it.id, { ...it, changedThisCycle: false });

  const frames: CycleFrame[] = [];
  const groups = groupByCycle(rows);
  const cycles = [...groups.keys()].sort((a, b) => a - b);

  for (const cycle of cycles) {
    const cycleRows = groups.get(cycle)!;
    // Clear per-cycle change flags; item identities persist.
    for (const it of items.values()) it.changedThisCycle = false;

    const phases = emptyPhases();
    const transitions: Transition[] = [];
    const rowIds: number[] = [];
    const substrate: SubstrateFiring[] = [];
    const gates: ComponentStates['gates'] = [];

    const components: ComponentStates = {
      senses: { count: 0, status: 'idle' },
      decide: { action: null, blocks: 0, status: 'idle' },
      dispatch: { action: null, status: 'idle' },
      gates,
      items: [],
      substrate,
      memory: { writes: 0, status: 'idle' },
      clocks: { fast: true, medium: cycle % mediumCadence === 0, slow: false },
      delegate: null,
    };

    for (const row of cycleRows) {
      rowIds.push(row.id);
      switch (row.kind) {
        case 'phase': {
          const phaseName = row.phase as Phase | undefined;
          if (phaseName) {
            const slice = phases.find((p) => p.phase === phaseName);
            if (slice) {
              slice.status = row.result === 'failed' ? 'failed' : 'ok';
              if (typeof row.duration_ms === 'number') slice.durationMs = row.duration_ms;
              if (typeof row.output_summary === 'string') slice.summary = row.output_summary;
              slice.rowId = row.id;
            }
            const fields = parseSummary(row.output_summary as string | undefined);
            if (phaseName === 'observe') {
              components.senses = { count: Number(fields.get('senses') ?? 0), status: 'active' };
            } else if (phaseName === 'decide') {
              const action = fields.get('action');
              components.decide = {
                action: action && action !== '(none)' ? action : null,
                blocks: Number(fields.get('blocks') ?? 0),
                status: 'active',
                ...(typeof row.duration_ms === 'number' ? { durationMs: row.duration_ms } : {}),
              };
              // Dispatch action is the decided action; result comes from the act row.
              components.dispatch.action = components.decide.action;
              if (components.decide.action && delegateNames.has(components.decide.action)) {
                components.delegate = { brief: components.decide.action };
                transitions.push({
                  kind: 'delegation',
                  label: `delegated: ${components.decide.action}`,
                  rowId: row.id,
                });
              }
            } else if (phaseName === 'act') {
              const result = fields.get('result') === 'failed' ? 'failed' : 'ok';
              components.dispatch.result = result;
              components.dispatch.status = result === 'failed' ? 'blocked' : 'active';
            } else if (phaseName === 'write') {
              components.memory = {
                writes: Number(fields.get('writes') ?? 0),
                status: Number(fields.get('writes') ?? 0) > 0 ? 'changed' : 'idle',
              };
            }
          }
          break;
        }
        case 'substrate': {
          const firing: SubstrateFiring = {
            law: String(row.law ?? 'unknown'),
            outcome: (row.outcome as SubstrateFiring['outcome']) ?? 'pass',
            phase: String(row.phase ?? ''),
            reason: String(row.reason ?? ''),
            rowId: row.id,
          };
          substrate.push(firing);
          if (firing.outcome !== 'pass') {
            transitions.push({
              kind: 'substrate-fired',
              label: `${firing.law}: ${firing.outcome}`,
              rowId: row.id,
            });
            if (firing.phase === 'act') {
              components.dispatch.blockedBy = firing.law;
              components.dispatch.status = 'blocked';
            }
          }
          break;
        }
        case 'subconscious': {
          const rule = String(row.rule ?? '');
          if (rule === 'auto-attempt-deterministic' && typeof row.memory_id === 'string') {
            const id = row.memory_id;
            const label = typeof row.now === 'string' ? row.now : id;
            const existing = items.get(id);
            if (existing) {
              existing.state = 'passed';
              existing.changedThisCycle = true;
              existing.label = label;
            } else {
              items.set(id, { id, label, state: 'passed', changedThisCycle: true });
            }
            gates.push({ item: id, result: 'pass', rowId: row.id });
            transitions.push({ kind: 'gate-pass', label, rowId: row.id });
            transitions.push({ kind: 'item-passed', label, rowId: row.id });
          }
          break;
        }
        case 'job': {
          const event = String(row.event ?? '');
          const jobId = String(row.job_id ?? '');
          if (event === 'item_appended') {
            // A new open item entered the plan. Use job_id-scoped placeholder id.
            const id = `${jobId}:${row.id}`;
            items.set(id, {
              id,
              label: typeof row.detail === 'string' ? row.detail : 'item appended',
              state: 'open',
              changedThisCycle: true,
            });
          } else if (event === 'closed_full' || event === 'closed_partial') {
            transitions.push({
              kind: 'job-closed',
              label: `${event} ${jobId.slice(0, 8)}`,
              rowId: row.id,
            });
          }
          break;
        }
        // operator rows carry no component state the lenses render directly.
        default:
          break;
      }
    }

    // Snapshot item state as of the end of this cycle.
    components.items = [...items.values()].map((it) => ({ ...it }));

    frames.push({ cycle, phases, components, transitions, rowIds });
  }

  return frames;
}

/** Item state as of the end of the last derived frame — for checkpointing. */
export function itemsAfter(frames: CycleFrame[]): ItemState[] {
  const last = frames[frames.length - 1];
  if (!last) return [];
  return last.components.items.map((it) => ({ ...it, changedThisCycle: false }));
}

/** Convenience: derive and index frames by cycle. */
export function deriveFrameMap(rows: TraceRow[], opts: DeriveOpts = {}): Map<number, CycleFrame> {
  const map = new Map<number, CycleFrame>();
  for (const f of deriveFrames(rows, opts)) map.set(f.cycle, f);
  return map;
}
