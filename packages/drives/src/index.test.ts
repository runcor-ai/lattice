import { describe, it, expect } from 'vitest';

import { pulse, magnitude, DEFAULT_DRIVE_STATE, DRIVE_NAMES } from './index.js';

describe('drives.pulse — slice 2 (T075)', () => {
  it('produces a non-zero magnitude from defaults', () => {
    expect(magnitude(DEFAULT_DRIVE_STATE)).toBeGreaterThan(0);
  });

  it('resource_pressure rises with budgetSpentFraction', () => {
    const low = pulse(DEFAULT_DRIVE_STATE, {
      budgetSpentFraction: 0.1,
      cyclesSinceNewPerception: 1,
      cyclesOnCurrentJob: 1,
    });
    const high = pulse(DEFAULT_DRIVE_STATE, {
      budgetSpentFraction: 0.9,
      cyclesSinceNewPerception: 1,
      cyclesOnCurrentJob: 1,
    });
    expect(high.resource_pressure).toBeGreaterThan(low.resource_pressure);
  });

  it('coherence rises with cyclesOnCurrentJob; curiosity falls', () => {
    const fresh = pulse(DEFAULT_DRIVE_STATE, {
      budgetSpentFraction: 0.1,
      cyclesSinceNewPerception: 1,
      cyclesOnCurrentJob: 1,
    });
    const old = pulse(DEFAULT_DRIVE_STATE, {
      budgetSpentFraction: 0.1,
      cyclesSinceNewPerception: 1,
      cyclesOnCurrentJob: 80,
    });
    expect(old.coherence).toBeGreaterThan(fresh.coherence);
    expect(old.curiosity).toBeLessThan(fresh.curiosity);
  });

  it('all drives stay clamped to [0,1]', () => {
    const wild = pulse(DEFAULT_DRIVE_STATE, {
      budgetSpentFraction: 99,
      cyclesSinceNewPerception: 1_000_000,
      cyclesOnCurrentJob: 1_000_000,
    });
    for (const name of DRIVE_NAMES) {
      expect(wild[name]).toBeGreaterThanOrEqual(0);
      expect(wild[name]).toBeLessThanOrEqual(1);
    }
  });
});
