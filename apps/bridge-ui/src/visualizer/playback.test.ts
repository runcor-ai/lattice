import { describe, it, expect } from 'vitest';

import { Playback, BASE_PHASE_MS, MIN_SPEED, MAX_SPEED } from './playback.js';

function makePlayback() {
  // No real rAF/now needed — we drive tick() directly for determinism.
  return new Playback({ now: () => 0, raf: () => 0, caf: () => {} });
}

describe('Playback — speed', () => {
  it('clamps speed to [0.25, 10]', () => {
    const p = makePlayback();
    p.setSpeed(100);
    expect(p.snapshot().speed).toBe(MAX_SPEED);
    p.setSpeed(0.001);
    expect(p.snapshot().speed).toBe(MIN_SPEED);
  });

  it('a phase advances after BASE_PHASE_MS at 1x', () => {
    const p = makePlayback();
    p.setRange(1, 10);
    p.seek(1, 0);
    p.play();
    p.tick(BASE_PHASE_MS - 1);
    expect(p.snapshot().phaseIndex).toBe(0); // not yet
    p.tick(2);
    expect(p.snapshot().phaseIndex).toBe(1); // crossed the boundary
  });

  it('slow-motion (0.25x) takes 4x longer per phase', () => {
    const p = makePlayback();
    p.setRange(1, 10);
    p.seek(1, 0);
    p.setSpeed(0.25);
    p.play();
    p.tick(BASE_PHASE_MS); // would be one phase at 1x; at 0.25x not yet
    expect(p.snapshot().phaseIndex).toBe(0);
    p.tick(BASE_PHASE_MS * 3);
    expect(p.snapshot().phaseIndex).toBe(1);
  });
});

describe('Playback — stepping', () => {
  it('stepPhase advances exactly one phase and rolls into the next cycle', () => {
    const p = makePlayback();
    p.setRange(1, 10);
    p.seek(1, 6); // judge slice
    p.stepPhase(1); // -> pulse (idx 7)
    expect(p.snapshot().phaseIndex).toBe(7);
    p.stepPhase(1); // -> next cycle, observe (idx 0)
    expect(p.snapshot()).toMatchObject({ cycle: 2, phaseIndex: 0 });
  });

  it('stepCycle advances exactly one cycle', () => {
    const p = makePlayback();
    p.setRange(1, 10);
    p.seek(3);
    p.stepCycle(1);
    expect(p.snapshot().cycle).toBe(4);
    p.stepCycle(-1);
    expect(p.snapshot().cycle).toBe(3);
  });

  it('cannot step before the first or past the latest cycle', () => {
    const p = makePlayback();
    p.setRange(2, 5);
    p.seek(2);
    p.stepCycle(-1);
    expect(p.snapshot().cycle).toBe(2);
    p.seek(5);
    p.stepCycle(1);
    expect(p.snapshot().cycle).toBe(5);
  });
});

describe('Playback — follow-live vs scrub (FR-012)', () => {
  it('follow-live engages only at the latest cycle', () => {
    const p = makePlayback();
    p.setRange(1, 10);
    p.seek(10); // at the edge
    expect(p.snapshot().followLive).toBe(true);
    p.seek(4); // scrub back
    expect(p.snapshot().followLive).toBe(false);
  });

  it('a new live cycle advances the playhead only when following', () => {
    const p = makePlayback();
    p.setRange(1, 10);
    p.seek(4); // scrubbed back, not following
    p.onLiveCycle(11);
    expect(p.snapshot().cycle).toBe(4); // view stays put
    expect(p.snapshot().latestCycle).toBe(11); // but range grows

    p.seek(11); // return to edge -> following
    p.onLiveCycle(12);
    expect(p.snapshot().cycle).toBe(12); // now it advances
  });
});

describe('Playback — lens switch preserves position (SC-007)', () => {
  it('changing lens leaves cycle/phase/speed/playing untouched', () => {
    const p = makePlayback();
    p.setRange(1, 50);
    p.seek(23, 3);
    p.setSpeed(2);
    const before = p.snapshot();
    p.setLens('engine');
    const after = p.snapshot();
    expect(after.lens).toBe('engine');
    expect({ cycle: after.cycle, phaseIndex: after.phaseIndex, speed: after.speed }).toEqual({
      cycle: before.cycle,
      phaseIndex: before.phaseIndex,
      speed: before.speed,
    });
  });
});
