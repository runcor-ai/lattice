import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEchoSense, makeNoopAction } from '@runcor/capabilities';
import { StubBackend } from '@runcor/engine';
import { DEPRECATION_MARKER } from '@runcor/memory';
import { Lattice, RuntimeMemoryAdapter } from '@runcor/runtime';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { rppDecision } from '../helpers/rpp.js';

/**
 * Slice 6 — runtime + subconscious integration. Asserts the sweep
 * runs in the write phase, fixes flat issues, observes (but does
 * not act on) judgement-required ones, and lands trace entries of
 * kind='subconscious' for both.
 */
describe('Slice 6 — runtime + subconscious integration', () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-slice6-'));
    sqlitePath = join(dir, 'entity.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a flat issue planted before a cycle is fixed by the cycle', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'slice-6 test' },
      engine: new StubBackend({ responder: () => rppDecision('Observed: no memory. No action.') }),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    // Plant a stale semantic row (admissible, but tagged for deprecation).
    const adapter = lattice.memory as RuntimeMemoryAdapter;
    adapter.memory.write(
      'semantic',
      {
        body: `${DEPRECATION_MARKER} stale fact`,
        why: 'planted by slice-6 test',
        admissionTag: 'guidance',
      },
      { cycle: 0, at_ms: Date.now() },
    );
    const before = adapter.memory.semantic.all()[0]!;
    expect(before.body).toContain(DEPRECATION_MARKER);

    await lattice.runOnce();

    // After one cycle, the sweep has fixed it.
    const after = adapter.memory.semantic.all()[0]!;
    expect(after.body).not.toContain(DEPRECATION_MARKER);

    // The trace shows the subconscious correction.
    const sub = lattice.trace.filter((e) => e.kind === 'subconscious');
    expect(sub.some((e) => (e as { rule: string }).rule === 'stale_semantic_marker')).toBe(true);

    // An audit row exists in memory_semantic_correction.
    const audit = lattice
      .dbHandle()
      .prepare(`SELECT COUNT(*) AS n FROM memory_semantic_correction`)
      .get() as { n: number };
    expect(audit.n).toBeGreaterThan(0);

    lattice.close();
  });

  it('a judgement-required issue is observed, NOT acted on', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'slice-6 test' },
      engine: new StubBackend({ responder: () => rppDecision('Observed: nothing. No action.') }),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    const adapter = lattice.memory as RuntimeMemoryAdapter;
    adapter.memory.write(
      'semantic',
      { body: 'this might be the right call', why: 'rule', admissionTag: 'guidance' },
      { cycle: 0, at_ms: Date.now() },
    );
    const planted = adapter.memory.semantic.all()[0]!;
    expect(planted.body).toContain('might');

    await lattice.runOnce();
    const after = adapter.memory.semantic.all()[0]!;
    // Body unchanged — Principle V: subconscious does not act on
    // judgement-required issues.
    expect(after.body).toBe('this might be the right call');

    // The trace records the observation explicitly.
    const sub = lattice.trace.filter((e) => e.kind === 'subconscious');
    expect(
      sub.some((e) =>
        (e as { rule: string }).rule.startsWith('ambiguous_semantic (observed'),
      ),
    ).toBe(true);

    lattice.close();
  });

  it('orphan index rows are cleaned up by the sweep', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'slice-6 test' },
      engine: new StubBackend({ responder: () => rppDecision('Observed: nothing. No action.') }),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    // Plant an orphan index row.
    const orphanIndexId = randomUUID();
    lattice
      .dbHandle()
      .prepare(
        `INSERT INTO memory_index (id, memory_table, memory_id, description, written_at_ms)
         VALUES (?, 'episodic', ?, 'orphan', ?)`,
      )
      .run(orphanIndexId, randomUUID(), Date.now());

    await lattice.runOnce();

    const left = lattice
      .dbHandle()
      .prepare(`SELECT COUNT(*) AS n FROM memory_index WHERE id = ?`)
      .get(orphanIndexId) as { n: number };
    expect(left.n).toBe(0);

    const sub = lattice.trace.filter((e) => e.kind === 'subconscious');
    expect(sub.some((e) => (e as { rule: string }).rule === 'orphan_index_row')).toBe(true);

    lattice.close();
  });

  it('a clean store produces zero subconscious entries per cycle', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'slice-6 clean' },
      engine: new StubBackend({ responder: () => rppDecision('Observed: nothing. No action.') }),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    await lattice.runN(3);
    const sub = lattice.trace.filter((e) => e.kind === 'subconscious');
    expect(sub).toHaveLength(0);
    lattice.close();
  });

  it('the sweep commits inside the cycle transaction (resume parity holds)', async () => {
    const a = new Lattice({
      identity: { composed_body: 'slice-6 tx' },
      engine: new StubBackend({ responder: () => rppDecision('Observed: nothing. No action.') }),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    (a.memory as RuntimeMemoryAdapter).memory.write(
      'semantic',
      {
        body: `${DEPRECATION_MARKER} a fact that should get fixed`,
        why: 'planted',
        admissionTag: 'guidance',
      },
      { cycle: 0, at_ms: Date.now() },
    );
    await a.runN(2);
    a.close();

    const b = new Lattice({
      identity: { composed_body: 'slice-6 tx' },
      engine: new StubBackend({ responder: () => rppDecision('Observed: nothing. No action.') }),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    // After restart: cycle counter at 2, semantic was fixed.
    expect(b.completedCycle).toBe(2);
    const sem = (b.memory as RuntimeMemoryAdapter).memory.semantic.all()[0]!;
    expect(sem.body).not.toContain(DEPRECATION_MARKER);
    // The audit row is durable too.
    const audit = b
      .dbHandle()
      .prepare(`SELECT COUNT(*) AS n FROM memory_semantic_correction`)
      .get() as { n: number };
    expect(audit.n).toBeGreaterThan(0);
    b.close();
  });
});
