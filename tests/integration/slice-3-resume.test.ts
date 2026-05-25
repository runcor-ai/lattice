import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEchoSense, makeNoopAction } from '@runcor/capabilities';
import { StubBackend } from '@runcor/engine';
import { Lattice, openDb, closeDb } from '@runcor/runtime';
import { CYCLE_PHASES } from '@runcor/trace';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { dbEquals } from '../helpers/dbEquals.js';

/**
 * Slice 3 — the canonical resume parity test (T087).
 *
 * Spec FR-007 + SC-002 + constitution Principle II: stop a lattice
 * mid-run; the next start resumes on the very next cycle with
 * logically-equal persistent state.
 *
 * This is the single most important test in the suite.
 */
describe('Slice 3 — resume parity (T087 / FR-007 / SC-002)', () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-resume-'));
    sqlitePath = join(dir, 'entity.sqlite');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('cycle counter continues at N+1 after restart', async () => {
    // A: run 50 cycles, close cleanly.
    const a = new Lattice({
      identity: { composed_body: 'resume test' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
      name: 'resume-test',
    });
    await a.runN(50);
    expect(a.completedCycle).toBe(50);
    a.close();

    // B: open the same file; expect to be at 50; next cycle is 51.
    const b = new Lattice({
      identity: { composed_body: 'resume test' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
      name: 'resume-test',
    });
    expect(b.completedCycle).toBe(50);
    expect(b.currentCycle).toBe(51);
    await b.runOnce();
    expect(b.completedCycle).toBe(51);
    b.close();
  });

  it('persistent state is logically equal pre- and post-restart', async () => {
    // A: run 25 cycles, close.
    const a = new Lattice({
      identity: { composed_body: 'parity test' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
      name: 'parity-test',
      latticeId: '00000000-0000-0000-0000-deadbeef0001',
    });
    await a.runN(25);
    a.close();

    // Snapshot A's persistent state via a read-only connection.
    const before = openDb(sqlitePath, { readonly: true, skipWalConfig: true });

    // B: open the same file (write mode) and IMMEDIATELY close — no
    // cycle is run. State must be identical.
    const b = new Lattice({
      identity: { composed_body: 'parity test' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
      name: 'parity-test',
      latticeId: '00000000-0000-0000-0000-deadbeef0001',
    });
    b.close();

    const after = openDb(sqlitePath, { readonly: true, skipWalConfig: true });
    const result = dbEquals(before, after);
    if (!result.equal) {
      // Surface diffs for debugging.
      console.error('dbEquals diffs:', result.diffs);
    }
    expect(result.equal, result.diffs.join('\n')).toBe(true);

    closeDb(before);
    closeDb(after);
  });

  it('trace + episodic memory accumulate across restart', async () => {
    const a = new Lattice({
      identity: { composed_body: 'accumulate test' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
      name: 'accumulate-test',
    });
    await a.runN(3);
    const aEpisodicCount = a.memory.size('episodic');
    a.close();

    const b = new Lattice({
      identity: { composed_body: 'accumulate test' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
      name: 'accumulate-test',
    });
    // BEFORE running new cycles, the episodic count must equal the pre-close count.
    expect(b.memory.size('episodic')).toBe(aEpisodicCount);
    await b.runN(2);
    // After 2 more cycles, the count is the sum.
    expect(b.memory.size('episodic')).toBe(aEpisodicCount + 2);
    b.close();
  });

  it('the SQLite file exists on disk after a file-backed run', async () => {
    const a = new Lattice({
      identity: { composed_body: 'disk-existence' },
      engine: new StubBackend(),
      sqlite: { path: sqlitePath },
    });
    await a.runOnce();
    a.close();
    expect(existsSync(sqlitePath)).toBe(true);
  });

  it('trace.phase entries cover all 8 phases per cycle, persisted to the indexed store', async () => {
    const a = new Lattice({
      identity: { composed_body: 'trace persist' },
      engine: new StubBackend(),
      sqlite: { path: sqlitePath },
    });
    await a.runN(2);
    a.close();
    // Read trace back via a fresh connection.
    const db = openDb(sqlitePath, { readonly: true, skipWalConfig: true });
    const traceRows = db.prepare(`SELECT phase FROM trace WHERE kind = 'phase' ORDER BY id`).all() as Array<{
      phase: string;
    }>;
    expect(traceRows.length).toBe(16); // 8 phases * 2 cycles
    expect(traceRows.slice(0, 8).map((r) => r.phase)).toEqual([...CYCLE_PHASES]);
    expect(traceRows.slice(8, 16).map((r) => r.phase)).toEqual([...CYCLE_PHASES]);
    closeDb(db);
  });
});
