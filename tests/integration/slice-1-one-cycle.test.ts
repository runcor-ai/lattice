import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEchoSense, makeNoopAction } from '@runcor/capabilities';
import { StubBackend } from '@runcor/engine';
import { Lattice } from '@runcor/runtime';
import { CYCLE_PHASES } from '@runcor/trace';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Slice 1 acceptance — T047.
 *
 * Prove the lattice cycle is real end-to-end: 8 phases in pinned
 * order, 1+ episodic memory write, and a JSONL trace file containing
 * all 8 phase entries.
 */
describe('Slice 1 — one cycle end-to-end (T047)', () => {
  let dir: string;
  let tracePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-slice1-'));
    tracePath = join(dir, 'trace.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs all 8 phases in pinned order; writes 1 memory; trace file has 8 phase lines', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'I am the slice-1 smoke lattice.' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      trace: { jsonlPath: tracePath },
    });

    const result = await lattice.runOnce();
    expect(result.outcome).toBe('completed');

    // 8 phase entries in pinned order via the in-memory buffer
    const phases = lattice.trace
      .filter((e) => e.kind === 'phase')
      .map((e) => (e as any).phase);
    expect(phases).toEqual([...CYCLE_PHASES]);

    // 1 episodic memory written with a non-empty "why"
    expect(lattice.memory.size('episodic')).toBe(1);
    const entry = lattice.memory.all()[0]!;
    expect(entry.why.length).toBeGreaterThan(0);

    // JSONL file on disk has the 8 phase lines. Substrate findings
    // (slice 5) may add extra entries of kind='substrate'; filter to
    // phase entries before the count + order assertion.
    const jsonlText = readFileSync(tracePath, 'utf8');
    const lines = jsonlText
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; phase?: string });
    const phaseLines = lines.filter((e) => e.kind === 'phase');
    expect(phaseLines).toHaveLength(8);
    expect(phaseLines.map((l) => l.phase)).toEqual([...CYCLE_PHASES]);
  });

  it('cycle counter is 0 before; 1 after; 50 after 50 cycles', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'counter test' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      trace: { jsonlPath: null },
    });

    expect(lattice.completedCycle).toBe(0);
    await lattice.runOnce();
    expect(lattice.completedCycle).toBe(1);
    await lattice.runN(49);
    expect(lattice.completedCycle).toBe(50);
  });
});

/**
 * Analyze C2 — every phase, including empty ones, produces a trace
 * entry (FR-002 + US2 acceptance scenario 3).
 */
describe('Slice 1 — empty-phase trace coverage (T048a / analyze C2)', () => {
  it('a lattice with no actions still records phase=act each cycle', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'no actions' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [], // empty manifest legal (spec FR-041)
      trace: { jsonlPath: null },
    });

    await lattice.runOnce();
    const acts = lattice.trace.filter((e) => e.kind === 'phase' && (e as any).phase === 'act');
    expect(acts).toHaveLength(1);
    expect((acts[0] as any).output_summary).toContain('no-action');
  });
});
