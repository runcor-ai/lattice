import { StubBackend } from '@runcor/engine';
import { describe, it, expect } from 'vitest';

import { Lattice } from './lattice.js';
import { MEDIUM_CLOCK_EVERY, readSituation } from './memory-clocks.js';

const NOOP_RPP = 'TARGET { output: "noop" }\nBEHAVIOR Decide {\n  No action this cycle.\n}\n';

/**
 * StubBackend that answers each clock prompt distinctly so the test can
 * trace what flowed where. Decide prompts are captured for inspection.
 */
function makeEngine(decidePrompts?: string[]) {
  return new StubBackend({
    responder: (req) => {
      const p = String(req.prompt);
      if (p.includes('running situation report')) return 'SITUATION-REPORT-XYZ: wrote lexer; next is parser.';
      if (p.includes('Compact the recent episodic')) return 'COMPACTED-MEMORY summary';
      decidePrompts?.push(p);
      return NOOP_RPP;
    },
  });
}

describe('Three-clock memory — fast clock (Item 1)', () => {
  it('writes a situation report each cycle that the NEXT cycle prompt reads', async () => {
    const decidePrompts: string[] = [];
    const lattice = new Lattice({ identity: { composed_body: 'clock test' }, engine: makeEngine(decidePrompts) });
    await lattice.runN(2);

    // The fast clock persisted a situation report.
    expect(readSituation(lattice.dbHandle())).toContain('SITUATION-REPORT-XYZ');
    // Cycle 2's decide prompt embeds the report the fast clock wrote after cycle 1 —
    // the lattice reads the synthesized summary instead of re-deriving from raw history.
    expect(decidePrompts.some((p) => p.includes('SITUATION-REPORT-XYZ'))).toBe(true);

    lattice.close();
  });

  it('does nothing when memoryClocks is disabled', async () => {
    const lattice = new Lattice({ identity: { composed_body: 'off' }, engine: makeEngine(), memoryClocks: false });
    await lattice.runN(2);
    expect(readSituation(lattice.dbHandle())).toBeNull();
    lattice.close();
  });
});

describe('Three-clock memory — medium clock (Item 1)', () => {
  it(`compacts episodic into a derived semantic every ${MEDIUM_CLOCK_EVERY} cycles`, async () => {
    const lattice = new Lattice({ identity: { composed_body: 'medium' }, engine: makeEngine() });
    await lattice.runN(MEDIUM_CLOCK_EVERY);
    const n = (
      lattice
        .dbHandle()
        .prepare(`SELECT COUNT(*) AS n FROM memory_semantic WHERE source_kind = 'derived'`)
        .get() as { n: number }
    ).n;
    expect(n).toBeGreaterThanOrEqual(1);
    lattice.close();
  });
});
