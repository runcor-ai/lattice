import type { TraceRow } from '@runcor/bridge-shared';
import { ref, shallowRef, triggerRef } from 'vue';


import { Api } from '../api.js';

import {
  deriveFrames,
  itemsAfter,
  type CycleFrame,
  type ItemState,
} from './frameModel.js';
import type { Playback } from './playback.js';

/**
 * useRunFrames — the windowed run model behind the visualizer.
 *
 * Owns: windowed historical loading (never the whole run at once), frame
 * checkpoints (so a far scrub reconstructs from the nearest checkpoint, not
 * cycle 0), and live SSE ingest. Lenses never touch this — they render the
 * CycleFrame the host hands them.
 */

const WINDOW = 60; // cycles loaded on each side of a scrub target
const CHECKPOINT_INTERVAL = 50; // snapshot item state every N cycles

function isDelegateName(name: string): boolean {
  // No manifest is exposed via inspect; the only delegation capability in the
  // stack is "claude-delegate". Heuristic: any capability whose name carries
  // "delegate". (Documented as a v1 simplification; refine if inspect ever
  // surfaces the tool manifest.)
  return /delegate/i.test(name);
}

export function useRunFrames(latticeId: string, playback: Playback) {
  const frames = shallowRef(new Map<number, CycleFrame>());
  const latestCycle = ref(0);
  const firstCycle = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const empty = ref(false);

  // Item-state checkpoints (cycle → items as of end of that cycle).
  const checkpoints = new Map<number, ItemState[]>();
  // Cycle ranges already materialized, to avoid refetch.
  const loadedRanges: Array<[number, number]> = [];
  // Live row buffer keyed by cycle, drained into frames as cycles complete.
  const liveBuffer = new Map<number, TraceRow[]>();

  const delegateNames = new Set<string>();
  const mediumCadence = 20;

  // Resolve rowId → row for hover (FR-008). Bounded loosely; windows are small.
  const rowsById = new Map<number, TraceRow>();
  function rememberRows(rows: TraceRow[]): void {
    for (const r of rows) rowsById.set(r.id, r);
  }
  function rowById(id: number): TraceRow | null {
    return rowsById.get(id) ?? null;
  }

  function isLoaded(cycle: number): boolean {
    return loadedRanges.some(([lo, hi]) => cycle >= lo && cycle <= hi);
  }

  /**
   * Pre-scan rows for decided actions whose name looks like a delegation, and
   * register them BEFORE deriving — otherwise the first delegating cycle would
   * be missed (the frame model matches against the known-name set).
   */
  function scanDelegateNames(rows: TraceRow[]): void {
    for (const r of rows) {
      if (r.kind !== 'phase' || r.phase !== 'decide') continue;
      const summary = typeof r.output_summary === 'string' ? r.output_summary : '';
      const m = /action=([^;]+)/.exec(summary);
      const name = m?.[1]?.trim();
      if (name && isDelegateName(name)) delegateNames.add(name);
    }
  }

  function recordCheckpoints(derived: CycleFrame[]): void {
    let runningItems: ItemState[] | null = null;
    for (const f of derived) {
      if (f.cycle % CHECKPOINT_INTERVAL === 0) {
        checkpoints.set(f.cycle, f.components.items.map((i) => ({ ...i, changedThisCycle: false })));
      }
      runningItems = f.components.items;
    }
    void runningItems;
  }

  function nearestCheckpoint(beforeCycle: number): { cycle: number; items: ItemState[] } {
    let best = { cycle: 0, items: [] as ItemState[] };
    for (const [cyc, items] of checkpoints) {
      if (cyc <= beforeCycle && cyc >= best.cycle) best = { cycle: cyc, items };
    }
    return best;
  }

  function mergeFrames(derived: CycleFrame[]): void {
    const map = frames.value;
    for (const f of derived) map.set(f.cycle, f);
    triggerRef(frames);
  }

  /** Discover the run's current cycle and seed the first window. */
  async function init(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const inspect = await Api.inspect(latticeId);
      latestCycle.value = inspect.cycle ?? 0;
      firstCycle.value = inspect.cycle > 0 ? 1 : 0;
      if (!inspect.cycle || inspect.cycle === 0) {
        empty.value = true;
      } else {
        await loadWindow(latestCycle.value);
      }
      playback.setRange(firstCycle.value, latestCycle.value);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  /**
   * Ensure the window around `center` is materialized. Reconstructs item
   * state from the nearest checkpoint ≤ window start, so frames are correct
   * without loading from cycle 0.
   */
  async function loadWindow(center: number): Promise<void> {
    const lo = Math.max(firstCycle.value, center - WINDOW);
    const hi = Math.min(latestCycle.value, center + WINDOW);
    if (isLoaded(center) && isLoaded(lo) && isLoaded(hi)) return;

    const cp = nearestCheckpoint(lo);
    const fromCycle = Math.min(lo, cp.cycle || lo);
    loading.value = true;
    error.value = null;
    try {
      // Fetch [fromCycle, hi] inclusive: after_cycle is exclusive, before_cycle is exclusive.
      const rows = await Api.traceRange(latticeId, {
        after_cycle: fromCycle - 1,
        before_cycle: hi + 1,
        limit: 1000,
      });
      scanDelegateNames(rows);
      rememberRows(rows);
      const derived = deriveFrames(rows, {
        delegateNames,
        mediumCadence,
        initialItems: cp.items,
      });
      mergeFrames(derived);
      recordCheckpoints(derived);
      loadedRanges.push([fromCycle, hi]);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  function frameAt(cycle: number): CycleFrame | null {
    return frames.value.get(cycle) ?? null;
  }

  /** Fold one live SSE row; derive + append the cycle when it advances. */
  function ingestLiveRow(row: TraceRow): void {
    const buf = liveBuffer.get(row.cycle);
    if (buf) buf.push(row);
    else liveBuffer.set(row.cycle, [row]);

    // When a cycle finishes (we see its pulse phase, the last phase), derive it.
    const isCycleEnd = row.kind === 'phase' && row.phase === 'pulse';
    if (!isCycleEnd) return;

    const rows = liveBuffer.get(row.cycle) ?? [];
    scanDelegateNames(rows);
    rememberRows(rows);
    const prev = frameAt(row.cycle - 1);
    const seed = prev ? itemsAfter([prev]) : [];
    const derived = deriveFrames(rows, { delegateNames, mediumCadence, initialItems: seed });
    if (derived.length > 0) {
      mergeFrames(derived);
      recordCheckpoints(derived);
      if (!isLoaded(row.cycle)) loadedRanges.push([row.cycle, row.cycle]);
    }
    liveBuffer.delete(row.cycle);

    if (row.cycle > latestCycle.value) {
      latestCycle.value = row.cycle;
      empty.value = false;
      playback.onLiveCycle(row.cycle);
    }
  }

  return {
    frames,
    latestCycle,
    firstCycle,
    loading,
    error,
    empty,
    init,
    loadWindow,
    frameAt,
    ingestLiveRow,
    rowById,
  };
}
