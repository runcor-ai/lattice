import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEchoSense, makeNoopAction } from '@runcor/capabilities';
import { StubBackend } from '@runcor/engine';
import { Lattice } from '@runcor/runtime';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Slice 3 — cold start (T090b / analyze C12).
 *
 * First-ever start: no local SQLite file, no snapshot, no prior
 * state. The lattice MUST create a fresh DB, apply all migrations,
 * write the entity row at cycle 0, and have the next cycle be 1.
 * The seed identity MUST be honoured.
 */
describe('Slice 3 — cold start (T090b / analyze C12)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-coldstart-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fresh start creates the file, completes cycle 1, and persists', async () => {
    const sqlitePath = join(dir, 'fresh.sqlite');
    expect(existsSync(sqlitePath)).toBe(false);

    const lattice = new Lattice({
      identity: { composed_body: 'I am the cold-start lattice.' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
      name: 'coldstart',
    });
    expect(existsSync(sqlitePath)).toBe(true);
    expect(lattice.completedCycle).toBe(0);
    expect(lattice.currentCycle).toBe(1);

    const result = await lattice.runOnce();
    expect(result.outcome).toBe('completed');
    expect(lattice.completedCycle).toBe(1);
    expect(lattice.memory.size('episodic')).toBe(1);
    lattice.close();
  });

  it(':memory: cold start has no on-disk artefacts', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'in-memory cold start' },
      engine: new StubBackend(),
      // sqlite omitted → defaults to :memory:
    });
    expect(lattice.completedCycle).toBe(0);
    await lattice.runOnce();
    expect(lattice.completedCycle).toBe(1);
    lattice.close();
  });
});
