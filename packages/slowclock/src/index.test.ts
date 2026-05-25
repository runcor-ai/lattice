import { describe, it, expect } from 'vitest';

import {
  DEFAULT_CADENCE,
  intervalCycles,
  nextWakeAtCycle,
  slowclockLockPath,
} from './index.js';

/* ============================== T151 ============================== */

describe('Cadence — load-aware interval (T151 / FR-026)', () => {
  it('load=1.0 returns the baseline', () => {
    expect(intervalCycles(1.0, { baseline: 100, loadAware: true })).toBe(100);
  });

  it('load > 1 shortens the interval', () => {
    const baseline = intervalCycles(1.0, { baseline: 100, loadAware: true });
    const busy = intervalCycles(2.0, { baseline: 100, loadAware: true });
    expect(busy).toBeLessThan(baseline);
  });

  it('load < 1 lengthens the interval', () => {
    const baseline = intervalCycles(1.0, { baseline: 100, loadAware: true });
    const quiet = intervalCycles(0.5, { baseline: 100, loadAware: true });
    expect(quiet).toBeGreaterThan(baseline);
  });

  it('clamps within [baseline/4, baseline*4]', () => {
    const insane = intervalCycles(100, { baseline: 100, loadAware: true });
    const dead = intervalCycles(0.001, { baseline: 100, loadAware: true });
    expect(insane).toBeGreaterThanOrEqual(25);
    expect(dead).toBeLessThanOrEqual(400);
  });

  it('loadAware=false ignores the load metric', () => {
    expect(intervalCycles(5.0, { baseline: 100, loadAware: false })).toBe(100);
  });

  it('cycle count within ±10% of baseline at load=1.0', () => {
    // Test variant uses baseline 10 to keep tests fast.
    const cad = { baseline: 10, loadAware: true };
    const interval = intervalCycles(1.0, cad);
    expect(interval).toBeGreaterThanOrEqual(9);
    expect(interval).toBeLessThanOrEqual(11);
  });

  it('nextWakeAtCycle adds the interval to the current cycle', () => {
    expect(nextWakeAtCycle(50, 1.0, { baseline: 100, loadAware: true })).toBe(150);
  });
});

describe('default cadence values', () => {
  it('baseline is 100', () => {
    expect(DEFAULT_CADENCE.baseline).toBe(100);
  });
  it('loadAware is true', () => {
    expect(DEFAULT_CADENCE.loadAware).toBe(true);
  });
});

/* ============================== T152 ============================== */

describe('Slowclock lockfile — separate from fast-clock lock (T156)', () => {
  it('slowclockLockPath returns sqlitepath + .slowclock.lock', () => {
    expect(slowclockLockPath('/tmp/entity.sqlite')).toBe('/tmp/entity.sqlite.slowclock.lock');
  });

  it('the path differs from the fast-clock lock path', () => {
    const fast = '/tmp/entity.sqlite.lock';
    const slow = slowclockLockPath('/tmp/entity.sqlite');
    expect(slow).not.toBe(fast);
  });
});
