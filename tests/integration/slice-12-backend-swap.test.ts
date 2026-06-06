import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEchoSense, makeNoopAction } from '@runcor/capabilities';
import {
  ClaudeCodeHostBackend,
  ModelBackendError,
  StubBackend,
  type CliRunner,
  type RppPrompt,
} from '@runcor/engine';
import { JobsService } from '@runcor/jobs';
import { handleUsageLimit, Lattice, RuntimeMemoryAdapter } from '@runcor/runtime';
import { Trace } from '@runcor/trace';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { rppDecision } from '../helpers/rpp.js';

/* ============================== T230 ============================== */

describe('Slice 12 — backend swap mid-flight (T230 / FR-054 swap-backend)', () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-slice12-swap-'));
    sqlitePath = join(dir, 'entity.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('next cycle uses the new backend; identity + memory untouched', async () => {
    let stubCalls = 0;
    const stub = new StubBackend({
      responder: () => {
        stubCalls += 1;
        return rppDecision('Observed. No action.');
      },
    });
    const lattice = new Lattice({
      identity: { composed_body: 'swap test' },
      engine: stub,
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
      memoryClocks: false, // isolate per-cycle backend call count (Item 1 clocks add engine calls)
    });
    await lattice.runOnce();
    expect(stubCalls).toBe(1);

    // Swap to a different backend.
    let hostCalls = 0;
    const hostRunner: CliRunner = {
      async run() {
        hostCalls += 1;
        return {
          stdout: rppDecision('Observed (host). No action.'),
          stderr: '',
          exitCode: 0,
        };
      },
    };
    const host = new ClaudeCodeHostBackend({ runner: hostRunner });
    const cycleBefore = lattice.completedCycle;
    const memorySizeBefore = lattice.memory.size('episodic');
    const identityBefore = lattice.identity.composed_body;
    lattice.setEngine(host);

    expect(lattice.engine.name).toBe('claude-code-host');
    // The lattice's identity is unchanged; the cycle counter is unchanged.
    expect(lattice.identity.composed_body).toBe(identityBefore);
    expect(lattice.completedCycle).toBe(cycleBefore);
    expect(lattice.memory.size('episodic')).toBe(memorySizeBefore);

    await lattice.runOnce();
    expect(hostCalls).toBe(1);
    expect(stubCalls).toBe(1); // stub NOT called again

    // The trace records the swap.
    const opEntries = lattice.trace.filter(
      (e) =>
        e.kind === 'operator' &&
        (e as { detail?: string }).detail?.includes('engine swapped to'),
    );
    expect(opEntries).toHaveLength(1);

    lattice.close();
  });
});

/* ============================== T230a / Analyze C5 ============================== */

describe('Slice 12 — usage-limit end-to-end (T230a / analyze C5 / Edge Case)', () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-slice12-usage-'));
    sqlitePath = join(dir, 'entity.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('handleUsageLimit defers the active item with cycle_after unblock test', () => {
    const tr = new Trace({ jsonlPath: null });
    let deferred: {
      itemId: string;
      reason: string;
      unblockCondition: string;
      unblockTest: string;
    } | null = null;
    const err = new ModelBackendError(
      'claude-code: usage limit reached (resets at 2026-05-25T18:00:00Z)',
      'usage_limit',
    );
    const out = handleUsageLimit(err, {
      trace: tr,
      cycle: 42,
      at_ms: 1_000,
      activeItemId: 'item-1',
      deferActiveItem: (args) => {
        deferred = args;
      },
    });
    expect(out.deferredItemId).toBe('item-1');
    expect(out.resetAt).toContain('2026-05-25T18:00:00Z');
    expect(deferred).not.toBeNull();
    expect(deferred?.itemId).toBe('item-1');
    expect(deferred?.unblockTest).toContain('cycle_after');

    // Trace records the alert.
    const alerts = tr.filter(
      (e) =>
        e.kind === 'operator' &&
        (e as { detail?: string }).detail?.includes('usage-limit'),
    );
    expect(alerts).toHaveLength(1);
  });

  it('without an activeItemId, the handler still writes an operator alert', () => {
    const tr = new Trace({ jsonlPath: null });
    const err = new ModelBackendError('usage limit reached', 'usage_limit');
    const out = handleUsageLimit(err, { trace: tr, cycle: 1, at_ms: 1 });
    expect(out.deferredItemId).toBeUndefined();
    expect(out.operatorAlert).toMatch(/usage-limit/);
    expect(tr.filter((e) => e.kind === 'operator')).toHaveLength(1);
  });

  it('the decide phase records an alert when the backend throws usage_limit; cycle fails; entity.cycle does not advance', async () => {
    const runner: CliRunner = {
      async run() {
        return {
          stdout: '',
          stderr: 'usage limit reached, resets at 2026-05-26T00:00:00Z',
          exitCode: 1,
        };
      },
    };
    const lattice = new Lattice({
      identity: { composed_body: 'usage-limit test' },
      engine: new ClaudeCodeHostBackend({ runner }),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    const result = await lattice.runOnce();
    expect(result.outcome).toBe('failed');
    // The cycle that failed at decide rolls back: entity.cycle stays at 0.
    expect(lattice.completedCycle).toBe(0);
    // Trace recorded the operator alert from the usage-limit handler.
    // (The trace buffer holds it even though the SQLite transaction
    // rolled back — Trace.write goes to both the in-memory buffer and
    // the SQLite indexer; the in-memory side survives ROLLBACK.)
    const alerts = lattice.trace.filter(
      (e) =>
        e.kind === 'operator' &&
        (e as { detail?: string }).detail?.includes('usage-limit'),
    );
    expect(alerts.length).toBeGreaterThan(0);
    lattice.close();
  });

  it('after a usage-limit failure, the next cycle on a fresh backend completes normally', async () => {
    const runner: CliRunner = {
      async run() {
        return { stdout: '', stderr: 'usage limit reached', exitCode: 1 };
      },
    };
    const lattice = new Lattice({
      identity: { composed_body: 'recovery test' },
      engine: new ClaudeCodeHostBackend({ runner }),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    const failed = await lattice.runOnce();
    expect(failed.outcome).toBe('failed');

    // Swap to a working backend and re-cycle.
    lattice.setEngine(new StubBackend({ responder: () => rppDecision('Observed.') }));
    const ok = await lattice.runOnce();
    expect(ok.outcome).toBe('completed');
    expect(lattice.completedCycle).toBe(1);
    lattice.close();
  });

  it('usage-limit handler integrates with @runcor/jobs deferral', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'job + usage test' },
      engine: new StubBackend(),
      sqlite: { path: sqlitePath },
    });
    const jobs = new JobsService(lattice.dbHandle());
    const job = jobs.openJob({
      title: 't',
      source: 'op',
      why: 'because',
      cycle: 0,
      at_ms: 0,
    });
    const item = jobs.addItem(job.id, {
      description: 'a',
      spec: { hooks: [{ name: 'always_pass' }] },
    });

    const err = new ModelBackendError(
      'usage limit reached (resets at 2026-05-25T18:00:00Z)',
      'usage_limit',
    );
    const outcome = handleUsageLimit(err, {
      trace: lattice.trace,
      cycle: 1,
      at_ms: Date.now(),
      activeItemId: item.id,
      deferActiveItem: (args) => {
        jobs.defer(
          {
            itemId: args.itemId,
            reason: args.reason,
            unblockCondition: args.unblockCondition,
            unblockTest: args.unblockTest,
          },
          { cycle: 1 },
        );
      },
    });
    expect(outcome.deferredItemId).toBe(item.id);
    const after = jobs.checklist.getItem(item.id)!;
    expect(after.state).toBe('deferred');
    expect(after.defer_reason).toMatch(/usage limit/);
    expect(after.unblock_test).toContain('cycle_after');

    lattice.close();
  });
});

/* ============================== Recovery via runtime adapter ============================== */

describe('Slice 12 — memory still operates during usage-limit period', () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-slice12-mem-'));
    sqlitePath = join(dir, 'entity.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('memory adapter is healthy even after a failed cycle', async () => {
    const runner: CliRunner = {
      async run() {
        return { stdout: '', stderr: 'usage limit reached', exitCode: 1 };
      },
    };
    const lattice = new Lattice({
      identity: { composed_body: 'mem test' },
      engine: new ClaudeCodeHostBackend({ runner }),
      sqlite: { path: sqlitePath },
    });
    await lattice.runOnce(); // fails
    const adapter = lattice.memory as RuntimeMemoryAdapter;
    // Direct write — no decide involved.
    adapter.memory.write(
      'semantic',
      { body: 'x', why: 'planted', admissionTag: 'guidance' },
      { cycle: 1, at_ms: Date.now() },
    );
    expect(adapter.memory.semantic.totalCount()).toBe(1);
    lattice.close();
  });
});
