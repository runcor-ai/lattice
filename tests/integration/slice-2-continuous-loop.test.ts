import { makeEchoSense, makeNoopAction } from '@runcor/capabilities';
import { StubBackend } from '@runcor/engine';
import { Lattice } from '@runcor/runtime';
import { describe, it, expect } from 'vitest';

/**
 * Slice 2 — continuous loop.
 *
 * T073: 100 cycles back-to-back; counter goes 1..100; trace has 800 phase entries.
 * T074: the loop has no internal exit (FR-003); only the abort signal stops it.
 */
describe('Slice 2 — continuous loop (T073, T074)', () => {
  it('runs 100 cycles, counter monotonic 1..100, 800 phase entries in trace', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'continuous-loop test' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
    });
    await lattice.runN(100);
    expect(lattice.completedCycle).toBe(100);
    const phaseEntries = lattice.trace.filter((e) => e.kind === 'phase');
    expect(phaseEntries).toHaveLength(800);
    // Spot-check monotonic cycle numbers across the trace.
    const cycles = phaseEntries.map((e) => e.cycle);
    expect(cycles[0]).toBe(1);
    expect(cycles[cycles.length - 1]).toBe(100);
  });

  it('runUntilAborted respects the abort signal and never exits on its own (FR-003)', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'no-internal-exit test' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
    });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    const completed = await lattice.runUntilAborted(ctrl.signal);
    expect(completed).toBeGreaterThan(0);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('after restart simulation (new Lattice on same logical config), counter restarts at 0 — slice 3 will fix this', async () => {
    // This test pins the slice-1/2 behavior so slice 3's persistence
    // diff is observable: today a fresh Lattice() always starts at 0.
    const a = new Lattice({
      identity: { composed_body: 'restart sim' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
    });
    await a.runN(10);
    expect(a.completedCycle).toBe(10);

    const b = new Lattice({
      identity: { composed_body: 'restart sim' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
    });
    expect(b.completedCycle).toBe(0); // slice 3 will make this resume to 11
  });
});
