import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEchoSense, makeNoopAction } from '@runcor/capabilities';
import { StubBackend } from '@runcor/engine';
import { Lattice, LockfileError, RuntimeMemoryAdapter } from '@runcor/runtime';
import { SlowclockWorker } from '@runcor/slowclock';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { rppDecision } from '../helpers/rpp.js';

/**
 * Slice 7 — the two clocks in coexistence.
 *
 * T153: spawn lattice + slowclock against the same SQLite; both run;
 *       consolidation reduces episodic when applicable.
 * T154: drift detector writes a correction memory; fast loop picks
 *       it up naturally on the next cycle (no interrupt).
 * T155: long delay between ticks → only the most recent missed wake
 *       fires; consolidation is idempotent.
 * T152: two slowclock workers on the same file: second fails with
 *       LockfileError(held).
 */
describe('Slice 7 — two clocks coexist on one SQLite (T153)', () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-slice7-'));
    sqlitePath = join(dir, 'entity.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fast loop + slow clock share the SQLite under WAL; both processes work', async () => {
    // Start the lattice (fast clock).
    const lattice = new Lattice({
      identity: { composed_body: 'two-clocks test' },
      engine: new StubBackend({ responder: () => rppDecision('Observed: nothing. No action.') }),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    // Run a few cycles so consolidate has something to do.
    await lattice.runN(3);

    // Start the slowclock — separate "process" within the same test for ease,
    // but with its own lockfile so we know they don't collide.
    const worker = new SlowclockWorker({
      sqlitePath,
      pollIntervalMs: 50,
      cadence: { baseline: 2, loadAware: false },
    });

    // Tick should fire immediately because next-wake was anchored at
    // cycle 3, and we are already at cycle 3 (the lattice ran 3 cycles
    // BEFORE the worker initialized). Force a wake by advancing first.
    await lattice.runN(3);
    const out = worker.tick();
    expect(out).not.toBeNull();
    expect(out!.cycle).toBeGreaterThanOrEqual(3);
    // Drift review wrote at least one semantic memory (the no_drift
    // case is filtered out, so this asserts the path runs and either
    // produces zero findings or writes them).
    expect(out!.drift.findings.length).toBeGreaterThanOrEqual(1);

    worker.close();
    lattice.close();
  });
});

describe('Slice 7 — drift correction flows into semantic memory (T154)', () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-slice7-drift-'));
    sqlitePath = join(dir, 'entity.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a deterministic drift detector writes a derived semantic memory; fast loop reads it naturally', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'drift test' },
      engine: new StubBackend({ responder: () => rppDecision('Observed: nothing. No action.') }),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    await lattice.runN(2);

    // Inject a drift detector that always finds off-purpose drift.
    const worker = new SlowclockWorker({
      sqlitePath,
      pollIntervalMs: 50,
      cadence: { baseline: 2, loadAware: false },
      detector: () => [
        {
          kind: 'off_purpose',
          summary: 'TEST-INJECTED: entity has been doing busywork',
          evidence: 'test-injection',
        },
      ],
    });
    // Worker anchored next-wake at cycle+baseline; advance past it.
    await lattice.runN(3);
    const out = worker.tick();
    expect(out).not.toBeNull();
    expect(out!.drift.correctionIds).toHaveLength(1);

    // The correction is now in the lattice's semantic memory — the
    // fast loop did NOT need to be interrupted.
    const sem = (lattice.memory as RuntimeMemoryAdapter).memory.semantic.all();
    const drift = sem.find((s) => s.body.includes('TEST-INJECTED'));
    expect(drift).toBeDefined();
    expect(drift?.source_kind).toBe('derived');

    // Run another fast cycle — it must succeed (no interrupt).
    const result = await lattice.runOnce();
    expect(result.outcome).toBe('completed');

    worker.close();
    lattice.close();
  });
});

describe('Slice 7 — only the most recent missed wake fires (T155 / FR-029)', () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-slice7-sleep-'));
    sqlitePath = join(dir, 'entity.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('after a long gap, one tick handles the gap (idempotent)', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'machine-sleep test' },
      engine: new StubBackend({ responder: () => rppDecision('Observed: nothing. No action.') }),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    const worker = new SlowclockWorker({
      sqlitePath,
      pollIntervalMs: 50,
      cadence: { baseline: 5, loadAware: false },
    });

    // Run many cycles past several wake boundaries without ticking.
    await lattice.runN(50); // worker missed ~10 wakes
    const out1 = worker.tick();
    expect(out1).not.toBeNull();
    // A second tick at the same cycle should be a no-op (next wake
    // anchored ahead of current).
    const out2 = worker.tick();
    expect(out2).toBeNull();

    worker.close();
    lattice.close();
  });
});

describe('Slice 7 — slowclock lockfile (T152)', () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-slice7-lock-'));
    sqlitePath = join(dir, 'entity.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('two SlowclockWorker instances on the same file: second fails with LockfileError(held)', async () => {
    // Need an existing DB.
    const lattice = new Lattice({
      identity: { composed_body: 'lock test' },
      engine: new StubBackend(),
      sqlite: { path: sqlitePath },
    });
    lattice.close();

    const w1 = new SlowclockWorker({ sqlitePath, pollIntervalMs: 50 });
    let caught: unknown;
    try {
      new SlowclockWorker({ sqlitePath, pollIntervalMs: 50 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LockfileError);
    expect((caught as LockfileError).kind).toBe('held');

    w1.close();

    // After release, a new worker can claim.
    const w2 = new SlowclockWorker({ sqlitePath, pollIntervalMs: 50 });
    w2.close();
  });
});

describe('Slice 7 — fast loop never interrupted by drift writes (FR-028)', () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-slice7-no-interrupt-'));
    sqlitePath = join(dir, 'entity.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('worker.tick during a paused lattice does not affect cycle counter', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'no-interrupt test' },
      engine: new StubBackend({ responder: () => rppDecision('Observed: nothing. No action.') }),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    await lattice.runN(5);

    const worker = new SlowclockWorker({
      sqlitePath,
      pollIntervalMs: 50,
      cadence: { baseline: 1, loadAware: false },
      detector: () => [
        { kind: 'off_purpose', summary: 'forced drift', evidence: 'test' },
      ],
    });
    // Worker constructor anchors next-wake at cycle+1; advance past it.
    await lattice.runN(2);
    const cycleBefore = lattice.completedCycle;
    const out = worker.tick();
    expect(out).not.toBeNull();

    // The lattice's in-memory cycle counter is unchanged (the slow
    // clock did not call into the runtime). The DB's entity.cycle
    // is also unchanged (slow clock doesn't write to it).
    expect(lattice.completedCycle).toBe(cycleBefore);
    const db = lattice.dbHandle();
    const row = db.prepare<[]>(`SELECT cycle FROM entity WHERE id = 'self'`).get() as {
      cycle: number;
    };
    expect(row.cycle).toBe(cycleBefore);

    worker.close();
    lattice.close();
  });
});
