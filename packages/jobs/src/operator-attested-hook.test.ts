import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { default as DatabaseCtor } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JobsService, OperatorItemValidationError } from './service.js';
import type { Item } from './types.js';

const Database = DatabaseCtor;

/**
 * `operator_attested` hook + addItem validation — covers the terminal
 * attestation fix.
 *
 * Run-2 bug: ord=1's gate was `file_exists` on a 4000-byte path; any
 * file satisfied it. Run-3 bug: same gate, a stale file from a sibling
 * lattice falsely passed it (the architect ground 6 close-attempts
 * before the no-progress circuit-breaker fired).
 *
 * The fix this file tests:
 *   - operator_attested reads from operator_attestation, never the filesystem
 *   - the hook ALSO refuses if any sibling item is open OR deferred
 *     (deferral is unfinished work, not excluded work — see the deferred-
 *      laundering test below for the central correctness assertion)
 *   - JobsService.addItem refuses file_exists on operator items
 *   - JobsService.addItem refuses blocked_by:null on operator items when
 *     the job already has non-operator items
 */

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE plan_job (
      id TEXT PRIMARY KEY, opened_at_cycle INTEGER NOT NULL, opened_at_ms INTEGER NOT NULL,
      title TEXT NOT NULL, source TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','closed_full','closed_partial')),
      closed_at_cycle INTEGER, closed_at_ms INTEGER, why TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE plan_item (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES plan_job(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, description TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open','passed','deferred')),
      iteration_count INTEGER NOT NULL DEFAULT 0,
      completion_check TEXT NOT NULL,
      passed_at_cycle INTEGER, deferred_at_cycle INTEGER,
      defer_reason TEXT, unblock_condition TEXT, unblock_test TEXT,
      source TEXT NOT NULL DEFAULT 'lattice_appended', blocked_by TEXT
    );
    CREATE TABLE operator_attestation (
      item_id           TEXT PRIMARY KEY,
      lattice_id        TEXT NOT NULL,
      attested_at_cycle INTEGER NOT NULL,
      attested_at_ms    INTEGER NOT NULL,
      note              TEXT
    );
  `);
  return db;
}

function makeJobWithItems(jobs: JobsService) {
  const job = jobs.openJob({ title: 't', source: 'operator', why: 'w', cycle: 1, at_ms: 1 });
  // Insert the attestation FIRST while the job has no siblings (legitimate
  // blocked_by:null case). The hook layer (not the blocked_by chain) is what
  // these tests exercise — we deliberately don't gate the attestation on the
  // work items at the chain layer so the hook gets reached. Then add work
  // items as siblings; the hook will query them as "every other item on the
  // same job."
  const attest = jobs.addItem(job.id, {
    description: 'terminal attestation',
    spec: { hooks: [{ name: 'operator_attested' }] },
    source: 'operator',
  });
  const work1 = jobs.addItem(job.id, {
    description: 'work 1',
    spec: { hooks: [{ name: 'always_pass' }] },
    source: 'lattice_appended',
  });
  const work2 = jobs.addItem(job.id, {
    description: 'work 2',
    spec: { hooks: [{ name: 'always_pass' }] },
    source: 'lattice_appended',
  });
  return { job, work1, work2, attest };
}

/* ============================================================ */
/* The operator_attested hook                                   */
/* ============================================================ */

describe('operator_attested hook — file existence does NOT satisfy', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oa-hook-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a 5KB file at the old hardcoded path does NOT satisfy the gate (file-vs-judgment regression)', async () => {
    // Plant the exact failure mode that broke run-3: a file at a real path
    // with the right minBytes. operator_attested does not read files.
    const stalePath = join(dir, 'done-attestation.md');
    writeFileSync(stalePath, 'x'.repeat(5000));
    const jobs = new JobsService(freshDb());
    const { work1, work2, attest } = makeJobWithItems(jobs);
    // Pass the work items so the only blocker is the attestation row.
    await jobs.attemptCheck(work1.id, { cycle: 1, mode: 'lattice' });
    await jobs.attemptCheck(work2.id, { cycle: 1, mode: 'lattice' });
    // No row inserted into operator_attestation — the file alone must not pass.
    const r = await jobs.attemptCheck(attest.id, { cycle: 1, mode: 'operator' });
    expect(r.outcome).toBe('failed_iterating');
    expect(r.reason).toMatch(/no attestation recorded/);
  });

  it('a stale file from another lattice does NOT satisfy the gate (cross-lattice contamination regression)', async () => {
    // Even simpler: the hook doesn't care about files at all. A file at
    // another lattice's data dir cannot satisfy this gate. We assert by
    // never inserting an operator_attestation row and observing the same
    // refusal regardless of what's on disk anywhere.
    writeFileSync(join(dir, 'another-lattice-done-attestation.md'), 'y'.repeat(99999));
    const jobs = new JobsService(freshDb());
    const { work1, work2, attest } = makeJobWithItems(jobs);
    await jobs.attemptCheck(work1.id, { cycle: 1, mode: 'lattice' });
    await jobs.attemptCheck(work2.id, { cycle: 1, mode: 'lattice' });
    const r = await jobs.attemptCheck(attest.id, { cycle: 1, mode: 'operator' });
    expect(r.outcome).toBe('failed_iterating');
    expect(r.reason).toMatch(/no attestation recorded/);
  });
});

describe('operator_attested hook — completeness check refuses partial jobs', () => {
  function insertAttestRow(db: ReturnType<typeof freshDb>, itemId: string, latticeId: string) {
    db.prepare(
      `INSERT INTO operator_attestation (item_id, lattice_id, attested_at_cycle, attested_at_ms, note)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(itemId, latticeId, 1, 1, 'test attest');
  }

  it('endpoint refuses to close while prior work items are OPEN (architect attest-with-incomplete-work)', async () => {
    const db = freshDb();
    const jobs = new JobsService(db);
    const { work1, work2, attest } = makeJobWithItems(jobs);
    // Operator pre-inserts an attestation row, but the work items are still open.
    insertAttestRow(db, attest.id, 'lattice-a');
    const r = await jobs.attemptCheck(attest.id, { cycle: 1, mode: 'operator' });
    expect(r.outcome).toBe('failed_iterating');
    expect(r.reason).toMatch(/2 items still open/);
    expect(jobs.checklist.getItem(attest.id)!.state).toBe('open');
    expect(work1).toBeDefined();
    expect(work2).toBeDefined();
  });

  /**
   * The central correctness test the operator required: deferral cannot
   * launder incompleteness. If the architect (or the no-progress circuit-
   * breaker) defers items, the attestation must still refuse.
   */
  it('endpoint refuses when work items are all PASSED EXCEPT ONE DEFERRED (the run-3 laundering hole)', async () => {
    const db = freshDb();
    const jobs = new JobsService(db);
    const { work1, work2, attest } = makeJobWithItems(jobs);
    await jobs.attemptCheck(work1.id, { cycle: 1, mode: 'lattice' });
    // work2 → deferred. Mirrors run-3's gap-E circuit-breaker behaviour.
    // Defer directly via the checklist to bypass the deferral-reason-policy
    // validator — the test cares about the deferred STATE, not how it got
    // there. The no-progress circuit-breaker in act.ts uses exactly this
    // path: markDeferred with an internally-generated reason.
    jobs.checklist.markDeferred(work2.id, {
      cycle: 2,
      reason: 'no-progress circuit-breaker: simulated test defer',
      unblockCondition: 'new work or signal arrives (next feed cycle)',
      unblockTest: 'a new job is posted to this lattice',
    });
    expect(jobs.checklist.getItem(work2.id)!.state).toBe('deferred');
    insertAttestRow(db, attest.id, 'lattice-a');
    const r = await jobs.attemptCheck(attest.id, { cycle: 3, mode: 'operator' });
    expect(r.outcome).toBe('failed_iterating');
    expect(r.reason).toMatch(/1 items deferred \(incomplete\)/);
    expect(r.reason).toMatch(/refuse to attest a partial job/);
    expect(jobs.checklist.getItem(attest.id)!.state).toBe('open');
  });

  it('endpoint refuses when work items are mixed: some open + some deferred', async () => {
    const db = freshDb();
    const jobs = new JobsService(db);
    const { work2, attest } = makeJobWithItems(jobs);
    // work1 left open, work2 deferred. Use checklist.markDeferred directly so
    // the deferral-reason-policy validator (which rejects short reasons) does
    // not interfere with the test setup.
    jobs.checklist.markDeferred(work2.id, {
      cycle: 1,
      reason: 'simulated test defer for mixed-state coverage',
      unblockCondition: 'signal',
      unblockTest: 'next-job',
    });
    insertAttestRow(db, attest.id, 'lattice-a');
    const r = await jobs.attemptCheck(attest.id, { cycle: 2, mode: 'operator' });
    expect(r.outcome).toBe('failed_iterating');
    expect(r.reason).toMatch(/1 items still open/);
    expect(r.reason).toMatch(/1 items deferred/);
  });

  it('endpoint DOES close when ALL prior items are passed (genuine completion)', async () => {
    const db = freshDb();
    const jobs = new JobsService(db);
    const { work1, work2, attest } = makeJobWithItems(jobs);
    await jobs.attemptCheck(work1.id, { cycle: 1, mode: 'lattice' });
    await jobs.attemptCheck(work2.id, { cycle: 2, mode: 'lattice' });
    expect(jobs.checklist.getItem(work1.id)!.state).toBe('passed');
    expect(jobs.checklist.getItem(work2.id)!.state).toBe('passed');
    insertAttestRow(db, attest.id, 'lattice-a');
    const r = await jobs.attemptCheck(attest.id, { cycle: 3, mode: 'operator' });
    expect(r.outcome).toBe('passed');
    const final = jobs.checklist.getItem(attest.id)!;
    expect(final.state).toBe('passed');
    expect(final.passed_at_cycle).toBe(3);
  });

  it("architect's close-job-item (mode='lattice') is refused on operator_attested item even when all conditions met", async () => {
    // Verifies the source='operator' lock still wraps the new gate.
    const db = freshDb();
    const jobs = new JobsService(db);
    const { work1, work2, attest } = makeJobWithItems(jobs);
    await jobs.attemptCheck(work1.id, { cycle: 1, mode: 'lattice' });
    await jobs.attemptCheck(work2.id, { cycle: 2, mode: 'lattice' });
    insertAttestRow(db, attest.id, 'lattice-a');
    // Architect tries to close.
    const r = await jobs.attemptCheck(attest.id, { cycle: 3, mode: 'lattice' });
    expect(r.outcome).toBe('awaiting_operator');
    expect(jobs.checklist.getItem(attest.id)!.state).toBe('open');
  });
});

/* ============================================================ */
/* JobsService.addItem validation                                */
/* ============================================================ */

describe('addItem — operator-item misconfiguration is refused at the engine boundary', () => {
  it('refuses file_exists hook on a source="operator" item (run-2 foot-gun)', () => {
    const jobs = new JobsService(freshDb());
    const job = jobs.openJob({ title: 't', source: 'operator', why: 'w', cycle: 1, at_ms: 1 });
    expect(() =>
      jobs.addItem(job.id, {
        description: 'terminal attest with bad gate',
        spec: { hooks: [{ name: 'file_exists', args: { path: '/tmp/x.md', minBytes: 4000 } }] },
        source: 'operator',
      }),
    ).toThrowError(OperatorItemValidationError);
  });

  it("refuses source='operator' + blocked_by:null when non-operator siblings exist (run-3 trap)", () => {
    const jobs = new JobsService(freshDb());
    const job = jobs.openJob({ title: 't', source: 'operator', why: 'w', cycle: 1, at_ms: 1 });
    // System plan-gate exists first (mirrors bridge POST /jobs behaviour).
    jobs.addItem(job.id, {
      description: 'plan gate',
      spec: { hooks: [{ name: 'file_exists', args: { path: '/tmp/plan.md', minBytes: 200 } }] },
      source: 'system',
    });
    // Operator item with no blocked_by — refused.
    let caught: OperatorItemValidationError | null = null;
    try {
      jobs.addItem(job.id, {
        description: 'terminal attest',
        spec: { hooks: [{ name: 'operator_attested' }] },
        source: 'operator',
      });
    } catch (e) {
      caught = e as OperatorItemValidationError;
    }
    expect(caught).toBeInstanceOf(OperatorItemValidationError);
    expect(caught!.code).toBe('operator_item_missing_blocked_by');
  });

  it('ALLOWS operator item with blocked_by set to an existing item (the bridge auto-chain path)', () => {
    const jobs = new JobsService(freshDb());
    const job = jobs.openJob({ title: 't', source: 'operator', why: 'w', cycle: 1, at_ms: 1 });
    const planGate: Item = jobs.addItem(job.id, {
      description: 'plan gate',
      spec: { hooks: [{ name: 'file_exists', args: { path: '/tmp/plan.md', minBytes: 200 } }] },
      source: 'system',
    });
    expect(() =>
      jobs.addItem(job.id, {
        description: 'terminal attest',
        spec: { hooks: [{ name: 'operator_attested' }] },
        source: 'operator',
        blocked_by: planGate.id,
      }),
    ).not.toThrow();
  });

  it('ALLOWS operator item with blocked_by:null when the job has no non-operator siblings yet', () => {
    // First-inserted operator item on an empty job (the only legitimate
    // case for blocked_by:null on operator items).
    const jobs = new JobsService(freshDb());
    const job = jobs.openJob({ title: 't', source: 'operator', why: 'w', cycle: 1, at_ms: 1 });
    expect(() =>
      jobs.addItem(job.id, {
        description: 'first item, no siblings',
        spec: { hooks: [{ name: 'operator_attested' }] },
        source: 'operator',
      }),
    ).not.toThrow();
  });

  it("non-operator items are unaffected by both checks (no regression)", () => {
    // The validation must be narrow: it fires only when source='operator'.
    const jobs = new JobsService(freshDb());
    const job = jobs.openJob({ title: 't', source: 'operator', why: 'w', cycle: 1, at_ms: 1 });
    jobs.addItem(job.id, {
      description: 'plan-step with file_exists',
      spec: { hooks: [{ name: 'file_exists', args: { path: '/tmp/x.md' } }] },
      source: 'plan_step',
    });
    // lattice_appended with no blocked_by, even with prior non-self siblings, is fine.
    expect(() =>
      jobs.addItem(job.id, {
        description: 'lattice_appended with no blocked_by',
        spec: { hooks: [{ name: 'always_pass' }] },
        source: 'lattice_appended',
      }),
    ).not.toThrow();
  });
});
