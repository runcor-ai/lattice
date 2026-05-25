import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEchoSense, makeNoopAction } from '@runcor/capabilities';
import { StubBackend } from '@runcor/engine';
import { JobsService, PassByAssertionError } from '@runcor/jobs';
import { Lattice } from '@runcor/runtime';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { rppDecision } from '../helpers/rpp.js';

/**
 * Slice 9 — jobs against the live Lattice.
 *
 * The Lattice's SQLite has plan_job/plan_item tables from slice 3's
 * migrations. JobsService runs against that same handle. Resume
 * parity is implicit — jobs are persistent across restarts.
 */
describe('Slice 9 — jobs + completion checks + deferral, end-to-end', () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-slice9-'));
    sqlitePath = join(dir, 'entity.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a 3-item job: pass two, defer one, close partial; deferred persists across restart', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'slice-9 jobs' },
      engine: new StubBackend({ responder: () => rppDecision('Observed. No action.') }),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });

    const jobs = new JobsService(lattice.dbHandle());
    const job = jobs.openJob({
      title: 'Catalogue reading queue',
      source: 'operator',
      why: 'operator-handed test job',
      cycle: lattice.currentCycle,
      at_ms: Date.now(),
    });
    const i1 = jobs.addItem(job.id, {
      description: 'a',
      spec: { hooks: [{ name: 'always_pass' }] },
    });
    const i2 = jobs.addItem(job.id, {
      description: 'b',
      spec: { hooks: [{ name: 'always_pass' }] },
    });
    const i3 = jobs.addItem(job.id, {
      description: 'c',
      spec: { hooks: [{ name: 'always_fail' }] },
    });

    await lattice.runOnce();

    expect(jobs.attemptCheck(i1.id, { cycle: 1 }).outcome).toBe('passed');
    expect(jobs.attemptCheck(i2.id, { cycle: 1 }).outcome).toBe('passed');
    const r3 = jobs.attemptCheck(i3.id, { cycle: 1 });
    expect(r3.outcome).toBe('failed_iterating');

    // Defer the third with a valid reason + unblock.
    const validation = jobs.defer(
      {
        itemId: i3.id,
        reason: 'waiting for stakeholder approval before retrying',
        unblockCondition: 'stakeholder approval visible in inbox',
        unblockTest: JSON.stringify({
          kind: 'sense_data_contains',
          sense: 'echo',
          needle: 'approved',
        }),
      },
      { cycle: 1 },
    );
    expect(validation.admit).toBe(true);

    // Close partial at autonomy=high.
    const close = jobs.close({
      jobId: job.id,
      cycle: 2,
      at_ms: Date.now(),
      autonomy: 'high',
    });
    expect(close.result).toBe('closed');
    if (close.result === 'closed') expect(close.mode).toBe('partial');

    lattice.close();

    // Restart and confirm the deferred item is still there.
    const after = new Lattice({
      identity: { composed_body: 'slice-9 jobs' },
      engine: new StubBackend(),
      sqlite: { path: sqlitePath },
    });
    const jobsAfter = new JobsService(after.dbHandle());
    const itemAfter = jobsAfter.checklist.getItem(i3.id);
    expect(itemAfter).not.toBeNull();
    expect(itemAfter?.state).toBe('deferred');
    expect(itemAfter?.defer_reason).toMatch(/stakeholder/);

    after.close();
  });

  it('pass-by-assertion is rejected even with a live lattice + valid SQLite', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'slice-9 reject' },
      engine: new StubBackend(),
      sqlite: { path: sqlitePath },
    });
    const jobs = new JobsService(lattice.dbHandle());
    const job = jobs.openJob({
      title: 't',
      source: 's',
      why: 'y',
      cycle: 0,
      at_ms: 0,
    });
    const item = jobs.addItem(job.id, {
      description: 'a',
      spec: { hooks: [{ name: 'always_pass' }] },
    });
    expect(() => jobs.markPassed(item.id)).toThrow(PassByAssertionError);
    lattice.close();
  });

  it('unblock-watcher observes (does not mutate) deferred items', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'slice-9 unblock' },
      engine: new StubBackend(),
      sqlite: { path: sqlitePath },
    });
    const jobs = new JobsService(lattice.dbHandle());
    const job = jobs.openJob({ title: 't', source: 's', why: 'y', cycle: 0, at_ms: 0 });
    const item = jobs.addItem(job.id, {
      description: 'a',
      spec: { hooks: [{ name: 'always_fail' }] },
    });
    jobs.defer(
      {
        itemId: item.id,
        reason: 'waiting for budget figure from the planning team',
        unblockCondition: 'budget arrives',
        unblockTest: JSON.stringify({
          kind: 'sense_data_contains',
          sense: 'inbox',
          needle: 'budget',
        }),
      },
      { cycle: 0 },
    );

    // Perception without the data → no unblock.
    expect(
      jobs.detectUnblocked({ cycle: 1, senses: { inbox: { result: 'ok', data: 'noise' } } }),
    ).toHaveLength(0);

    // Perception with the data → reported, but item state UNCHANGED.
    const u = jobs.detectUnblocked({
      cycle: 2,
      senses: { inbox: { result: 'ok', data: 'budget is $100k' } },
    });
    expect(u).toHaveLength(1);
    expect(jobs.checklist.getItem(item.id)?.state).toBe('deferred');

    lattice.close();
  });
});
