import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEchoSense, makeNoopAction } from '@runcor/capabilities';
import { StubBackend } from '@runcor/engine';
import { AdmissionRejection, classify, DEFAULT_DECAY, durability } from '@runcor/memory';
import { Lattice, RuntimeMemoryAdapter } from '@runcor/runtime';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Slice 4 — four memory systems under the live runtime cycle.
 *
 * Asserts the slice 4 work integrates cleanly: every cycle's write
 * lands in episodic via @runcor/memory + admission rule; identity
 * survives a sweep; resume parity (from slice 3) still holds.
 */
describe('Slice 4 — runtime + memory integration', () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-slice4-'));
    sqlitePath = join(dir, 'entity.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runtime write phase routes through admission; episodic count grows', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'slice-4 test' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    await lattice.runN(5);
    expect(lattice.memory.size('episodic')).toBe(5);
    expect(lattice.memory.size('identity')).toBe(0);
    expect(lattice.memory.size('semantic')).toBe(0);
    lattice.close();
  });

  it('memory.all() entries carry "cycle-outcome" admission tag', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'slice-4 test' },
      engine: new StubBackend(),
      sqlite: { path: sqlitePath },
    });
    await lattice.runOnce();
    const entries = lattice.memory.all();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.admissionTag).toBe('cycle-outcome');
    expect(entries[0]?.why.length).toBeGreaterThan(0);
    lattice.close();
  });

  it('plan-system write is rejected at runtime (owned by @runcor/jobs)', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'slice-4 test' },
      engine: new StubBackend(),
      sqlite: { path: sqlitePath },
    });
    expect(() =>
      lattice.memory.write(
        { system: 'plan', body: 'x', why: 'y', admissionTag: 'decision' },
        { cycle: 1, at_ms: Date.now() },
      ),
    ).toThrow(/owned by @runcor\/jobs/);
    lattice.close();
  });

  it('an admission-rejected write throws and does not persist', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'slice-4 test' },
      engine: new StubBackend(),
      sqlite: { path: sqlitePath },
    });
    const adapter = lattice.memory as RuntimeMemoryAdapter;
    let caught: unknown;
    try {
      adapter.memory.write(
        'episodic',
        { body: 'should reject', why: 'auto', admissionTag: 'file-content' },
        { cycle: 1, at_ms: Date.now() },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdmissionRejection);
    expect(lattice.memory.size('episodic')).toBe(0);
    lattice.close();
  });

  it('memory + decay survives restart (FR-013 + resume parity)', async () => {
    const a = new Lattice({
      identity: { composed_body: 'slice-4 decay' },
      engine: new StubBackend(),
      sqlite: { path: sqlitePath },
    });
    await a.runN(3);
    const aEpisodic = a.memory.size('episodic');
    a.close();

    const b = new Lattice({
      identity: { composed_body: 'slice-4 decay' },
      engine: new StubBackend(),
      sqlite: { path: sqlitePath },
    });
    expect(b.memory.size('episodic')).toBe(aEpisodic);
    // Apply decay sweep with extreme age — all 3 entries become "forget".
    const adapter = b.memory as RuntimeMemoryAdapter;
    const sweep = adapter.memory.episodic.sweep(Number.MAX_SAFE_INTEGER);
    expect(sweep.examined).toBe(3);
    expect(sweep.forgotten).toBe(3);
    expect(b.memory.size('episodic')).toBe(0);
    b.close();
  });

  it('recall returns episodic memories with human age (FR-017)', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'recall test' },
      engine: new StubBackend(),
      sqlite: { path: sqlitePath },
    });
    await lattice.runN(3);
    const adapter = lattice.memory as RuntimeMemoryAdapter;
    const res = await adapter.memory.recall({
      query: 'recent',
      breadth: 10,
      nowMs: Date.now(),
    });
    expect(res.memories.length).toBeGreaterThan(0);
    for (const m of res.memories) {
      expect(m.humanAge).toBeTruthy();
    }
    lattice.close();
  });

  it('decay formula reference value matches hand-computed reference', () => {
    // Compute the standard reference value used in unit tests via the
    // re-exported decay symbol, to prove @runcor/memory is exported
    // correctly through the workspace boundary.
    const now = 1_000_000_000_000;
    const M = durability(
      { reinforcement: 2.0, access_count: 4, last_access_ms: now - 3_600_000 },
      now,
      { tau: 7200, D: 2.0, forgetBelow: 0.05, promoteAbove: 0.6 },
    );
    expect(M).toBeCloseTo(2.0 * Math.log(5) * Math.exp(-0.25), 10);

    const c = classify(
      { reinforcement: 2.0, access_count: 20, last_access_ms: now },
      now,
      DEFAULT_DECAY,
    );
    expect(c.decision).toBe('promote');
  });
});
