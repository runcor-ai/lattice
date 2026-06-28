import { describe, it, expect } from 'vitest';

import {
  AGE_OUT_HANDLERS,
  OPEN_QUESTION_AGE_OUT,
  WATCHDOG_KINDS,
  WATCHDOG_TIER3_KINDS,
} from './drift-review.js';

/**
 * Detector-completeness guard.
 *
 * The TypeScript Record type already enforces this at compile time: adding a
 * new `WatchdogKind` without a matching `AGE_OUT_HANDLERS` entry will not
 * type-check, which means a half-done detector cannot ship. This runtime
 * test is the belt-and-braces co-check against a refactor that loosens the
 * typed Record (e.g. someone changes it to `Record<string, AgeOutHandler>`
 * and silently drops a kind).
 *
 * Without an age-out arm a finding would nag the lattice forever, so the
 * invariant is critical. Tested two ways: types + this runtime probe.
 */
describe('AGE_OUT_HANDLERS — every WatchdogKind has a matching arm', () => {
  it('every WatchdogKind appears in AGE_OUT_HANDLERS with a callable isResolved', () => {
    for (const kind of WATCHDOG_KINDS) {
      const rule = `watchdog:${kind}` as const;
      expect(AGE_OUT_HANDLERS).toHaveProperty(rule);
      expect(typeof AGE_OUT_HANDLERS[rule].isResolved).toBe('function');
    }
  });

  it('every AGE_OUT_HANDLERS key corresponds to a known WatchdogKind (no stragglers)', () => {
    const knownKeys = new Set(WATCHDOG_KINDS.map((k) => `watchdog:${k}`));
    for (const key of Object.keys(AGE_OUT_HANDLERS)) {
      expect(knownKeys.has(key)).toBe(true);
    }
  });
});

describe('OPEN_QUESTION_AGE_OUT — every WatchdogTier3Kind has a resolver', () => {
  it('every Tier-3 kind appears in OPEN_QUESTION_AGE_OUT with a callable resolvedBy', () => {
    for (const kind of WATCHDOG_TIER3_KINDS) {
      const rule = `tier3:${kind}` as const;
      expect(OPEN_QUESTION_AGE_OUT).toHaveProperty(rule);
      expect(typeof OPEN_QUESTION_AGE_OUT[rule].resolvedBy).toBe('function');
    }
  });

  it('every OPEN_QUESTION_AGE_OUT key corresponds to a known Tier-3 kind', () => {
    const knownKeys = new Set(WATCHDOG_TIER3_KINDS.map((k) => `tier3:${k}`));
    for (const key of Object.keys(OPEN_QUESTION_AGE_OUT)) {
      expect(knownKeys.has(key)).toBe(true);
    }
  });

  it('PHYSICAL SEPARATION — Tier-3 resolver shape differs from Tier-1/2 handler shape', () => {
    // The Tier-1/2 handlers expose `isResolved` (file-check-style).
    // The Tier-3 resolvers expose `resolvedBy` (memory-marker-style).
    // Mixing the two would either nag forever or falsely age-out — the
    // distinct shape is the safety property.
    for (const rule of Object.keys(OPEN_QUESTION_AGE_OUT)) {
      const handler = OPEN_QUESTION_AGE_OUT[rule as keyof typeof OPEN_QUESTION_AGE_OUT];
      expect(handler).not.toHaveProperty('isResolved');
      expect(handler).toHaveProperty('resolvedBy');
    }
    for (const rule of Object.keys(AGE_OUT_HANDLERS)) {
      const handler = AGE_OUT_HANDLERS[rule as keyof typeof AGE_OUT_HANDLERS];
      expect(handler).toHaveProperty('isResolved');
      expect(handler).not.toHaveProperty('resolvedBy');
    }
  });
});
