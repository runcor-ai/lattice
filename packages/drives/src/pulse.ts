import { type DriveState, DEFAULT_DRIVE_STATE, type DriveName } from './types.js';

export interface PulseInputs {
  readonly budgetSpentFraction: number;        // 0..1
  readonly cyclesSinceNewPerception: number;
  readonly cyclesOnCurrentJob: number;
}

/**
 * pulse — derive the next drive state from the current state and the
 * cycle's inputs. The combined magnitude (Σ values) is a continuation
 * force; the loop reads it for telemetry, never to decide whether to
 * stop (FR-003).
 *
 * Slice 11 will replace this with the calibrated multi-drive
 * dynamics. Slice 2 keeps the shape and proves the pulse moves with
 * inputs.
 */
export function pulse(prev: DriveState, inputs: PulseInputs): DriveState {
  const next: Record<DriveName, number> = { ...prev };
  next.resource_pressure = clamp01(inputs.budgetSpentFraction);
  next.reactivity = clamp01(1 - 1 / (1 + inputs.cyclesSinceNewPerception));
  // Curiosity decays as we stay on one job; coherence rises symmetrically.
  const cohRise = clamp01(inputs.cyclesOnCurrentJob / 50);
  next.coherence = clamp01(0.5 + 0.5 * cohRise);
  next.curiosity = clamp01(1 - 0.5 * cohRise);
  return Object.freeze(next);
}

export function magnitude(state: DriveState): number {
  return (
    state.resource_pressure + state.curiosity + state.reactivity + state.coherence
  );
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export { DEFAULT_DRIVE_STATE };
