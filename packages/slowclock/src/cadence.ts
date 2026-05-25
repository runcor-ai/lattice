/**
 * Slow-clock cadence (constitution Principle VII; spec FR-026).
 *
 *   Fires on CYCLE COUNT, not wall-clock time.
 *   Load-aware: heavier recent activity shortens the interval; quieter
 *   activity lengthens it. Baseline ~100 cycles by default.
 *
 * "Load" is summarised by an opaque number in [0, 2] where 1.0 is the
 * neutral baseline. The runtime supplies the load metric (slice 11
 * will fold drives + perception volume into it; for slice 7 the
 * runtime defaults to 1.0).
 *
 * Test variants supply small baselines (e.g. 10) so a few cycles
 * trigger a wake.
 */

export interface CadenceParams {
  readonly baseline: number;
  readonly loadAware: boolean;
}

export const DEFAULT_CADENCE: CadenceParams = Object.freeze({
  baseline: 100,
  loadAware: true,
});

/**
 * Compute the interval (in cycles) before the next slow-clock wake,
 * given the current load multiplier.
 *
 * - load = 1.0 → interval = baseline
 * - load > 1.0 → interval shrinks (more activity → wake sooner)
 * - load < 1.0 → interval grows (less activity → wake later)
 *
 * Clamped to [max(1, baseline / 4), baseline * 4] so a runaway load
 * metric can't burn the worker.
 */
export function intervalCycles(load: number, params: CadenceParams = DEFAULT_CADENCE): number {
  if (!params.loadAware) return params.baseline;
  const clampedLoad = Math.max(0.1, Math.min(10, load));
  const raw = params.baseline / clampedLoad;
  const min = Math.max(1, Math.floor(params.baseline / 4));
  const max = params.baseline * 4;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

export function nextWakeAtCycle(
  currentCycle: number,
  load: number,
  params: CadenceParams = DEFAULT_CADENCE,
): number {
  return currentCycle + intervalCycles(load, params);
}
