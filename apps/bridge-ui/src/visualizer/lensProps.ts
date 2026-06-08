import type { CycleFrame } from './frameModel.js';
import type { PlaybackSnapshot } from './playback.js';

/**
 * The contract every visual lens receives. A lens is a PURE renderer of this:
 * it must not read the trace API, own a clock, or hold cross-cycle state.
 * That is what makes "three lenses, one core" true (FR-009/FR-010) and lets
 * each lens be smoke-tested with a hand-built frame.
 */
export interface LensProps {
  /** The current cycle's derived state. */
  frame: CycleFrame | null;
  /** The shared playback state (cycle, phaseIndex, speed, lens, hover). */
  playback: PlaybackSnapshot;
}

export interface LensEmits {
  /** A hoverable element was entered/left → underlying trace row id (FR-008). */
  (e: 'hover', rowId: number | null): void;
}

/**
 * Fixed visual meaning of component status across ALL lenses (contract §3):
 *   idle     — background
 *   active   — this phase touched it
 *   firing   — a substrate law fired
 *   blocked  — dispatch was stopped
 *   changed  — state moved (item passed / job closed / memory wrote)
 *   absent   — not emitted this cycle
 * Colours come from tokens.css only; never hard-code a hex in a lens.
 */
export const STATUS_TOKEN: Record<string, string> = {
  idle: 'var(--text-3)',
  active: 'var(--accent)',
  firing: 'var(--substrate)',
  blocked: 'var(--red)',
  changed: 'var(--green)',
  absent: 'var(--text-3)',
};
