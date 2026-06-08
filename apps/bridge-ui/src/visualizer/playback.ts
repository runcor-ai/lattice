import { PHASE_ORDER } from './frameModel.js';

/**
 * playback — the single, lens-agnostic clock.
 *
 * Owns the playhead (cycle + phase), play/pause, speed, and follow-live.
 * Every lens reads this state; none of them owns a timer. Switching lens
 * does not touch playback, so position + speed are preserved (SC-007).
 *
 * Time model: a cycle is PHASE_ORDER.length phase-steps. At 1× each phase
 * lasts BASE_PHASE_MS; speed scales that (0.25× = 4× longer, 10× = 1/10th).
 */

export type Lens = 'board' | 'engine' | 'system';

export const BASE_PHASE_MS = 360;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 10;
const PHASES_PER_CYCLE = PHASE_ORDER.length;

export interface PlaybackSnapshot {
  cycle: number;
  phaseIndex: number;
  playing: boolean;
  speed: number;
  followLive: boolean;
  lens: Lens;
  latestCycle: number;
  firstCycle: number;
  hoverRowId: number | null;
}

export type PlaybackListener = (s: PlaybackSnapshot) => void;

function clampSpeed(s: number): number {
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, s));
}

export interface PlaybackOptions {
  /** Injected for tests; defaults to performance.now in the browser. */
  now?: () => number;
  /** Injected scheduler; defaults to requestAnimationFrame. Return a cancel handle. */
  raf?: (cb: () => void) => number;
  caf?: (handle: number) => void;
}

export class Playback {
  private cycle = 0;
  private phaseIndex = 0;
  private playing = false;
  private speed = 1;
  private followLive = true;
  private lens: Lens = 'board';
  private latestCycle = 0;
  private firstCycle = 0;
  private hoverRowId: number | null = null;

  private acc = 0; // accumulated ms toward the next phase step
  private lastTick = 0;
  private rafHandle: number | null = null;
  private readonly listeners = new Set<PlaybackListener>();

  private readonly now: () => number;
  private readonly raf: (cb: () => void) => number;
  private readonly caf: (h: number) => void;

  constructor(opts: PlaybackOptions = {}) {
    this.now = opts.now ?? (() => performance.now());
    this.raf =
      opts.raf ?? ((cb) => (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(cb) : 0));
    this.caf = opts.caf ?? ((h) => typeof cancelAnimationFrame !== 'undefined' && cancelAnimationFrame(h));
  }

  snapshot(): PlaybackSnapshot {
    return {
      cycle: this.cycle,
      phaseIndex: this.phaseIndex,
      playing: this.playing,
      speed: this.speed,
      followLive: this.followLive,
      lens: this.lens,
      latestCycle: this.latestCycle,
      firstCycle: this.firstCycle,
      hoverRowId: this.hoverRowId,
    };
  }

  subscribe(fn: PlaybackListener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }

  /** Update the known cycle range as rows load / stream in. */
  setRange(firstCycle: number, latestCycle: number): void {
    this.firstCycle = firstCycle;
    this.latestCycle = latestCycle;
    if (this.cycle < firstCycle) this.cycle = firstCycle;
    if (this.followLive && this.cycle < latestCycle) this.cycle = latestCycle;
    if (this.cycle > latestCycle) this.cycle = latestCycle;
    this.emit();
  }

  /** A new live cycle completed. Advances the playhead only when following live. */
  onLiveCycle(cycle: number): void {
    this.latestCycle = Math.max(this.latestCycle, cycle);
    if (this.followLive) {
      this.cycle = this.latestCycle;
      // Restart the phase animation from the top so each arriving cycle is
      // visibly animated observe→pulse rather than snapping to the end.
      this.phaseIndex = this.playing ? 0 : PHASES_PER_CYCLE - 1;
    }
    this.emit();
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.lastTick = this.now();
    this.acc = 0;
    this.loop();
    this.emit();
  }

  pause(): void {
    this.playing = false;
    if (this.rafHandle !== null) {
      this.caf(this.rafHandle);
      this.rafHandle = null;
    }
    this.emit();
  }

  toggle(): void {
    this.playing ? this.pause() : this.play();
  }

  setSpeed(speed: number): void {
    this.speed = clampSpeed(speed);
    this.emit();
  }

  setLens(lens: Lens): void {
    this.lens = lens;
    this.emit();
  }

  setHover(rowId: number | null): void {
    this.hoverRowId = rowId;
    this.emit();
  }

  /** Jump to a cycle (scrub). Disengages follow-live unless landing on latest. */
  seek(cycle: number, phaseIndex = PHASES_PER_CYCLE - 1): void {
    this.cycle = Math.min(this.latestCycle, Math.max(this.firstCycle, Math.round(cycle)));
    this.phaseIndex = Math.min(PHASES_PER_CYCLE - 1, Math.max(0, phaseIndex));
    this.followLive = this.cycle >= this.latestCycle;
    this.emit();
  }

  stepPhase(dir: 1 | -1 = 1): void {
    let idx = this.phaseIndex + dir;
    let cyc = this.cycle;
    if (idx >= PHASES_PER_CYCLE) {
      idx = 0;
      cyc = Math.min(this.latestCycle, cyc + 1);
    } else if (idx < 0) {
      idx = PHASES_PER_CYCLE - 1;
      cyc = Math.max(this.firstCycle, cyc - 1);
    }
    this.cycle = cyc;
    this.phaseIndex = idx;
    this.followLive = this.cycle >= this.latestCycle && idx === PHASES_PER_CYCLE - 1;
    this.emit();
  }

  stepCycle(dir: 1 | -1 = 1): void {
    this.cycle = Math.min(this.latestCycle, Math.max(this.firstCycle, this.cycle + dir));
    this.phaseIndex = PHASES_PER_CYCLE - 1;
    this.followLive = this.cycle >= this.latestCycle;
    this.emit();
  }

  setFollowLive(on: boolean): void {
    this.followLive = on;
    if (on) this.cycle = this.latestCycle;
    this.emit();
  }

  /**
   * Advance the clock by elapsed wall time. Exposed for tests (deterministic
   * stepping); the rAF loop calls it with real elapsed time.
   */
  tick(elapsedMs: number): void {
    if (!this.playing) return;
    const phaseMs = BASE_PHASE_MS / this.speed;
    this.acc += elapsedMs;
    while (this.acc >= phaseMs) {
      this.acc -= phaseMs;
      if (this.cycle >= this.latestCycle && this.phaseIndex >= PHASES_PER_CYCLE - 1) {
        // Reached the live edge; keep following, stop stepping.
        this.followLive = true;
        if (!this.playing) break;
        // pause stepping but stay "playing" so live cycles continue.
        this.acc = 0;
        break;
      }
      this.stepPhaseInternal();
    }
    this.emit();
  }

  private stepPhaseInternal(): void {
    let idx = this.phaseIndex + 1;
    let cyc = this.cycle;
    if (idx >= PHASES_PER_CYCLE) {
      idx = 0;
      cyc = Math.min(this.latestCycle, cyc + 1);
    }
    this.cycle = cyc;
    this.phaseIndex = idx;
  }

  private loop(): void {
    if (!this.playing) return;
    this.rafHandle = this.raf(() => {
      const t = this.now();
      const elapsed = t - this.lastTick;
      this.lastTick = t;
      this.tick(elapsed);
      if (this.playing) this.loop();
    });
  }

  dispose(): void {
    this.pause();
    this.listeners.clear();
  }
}
