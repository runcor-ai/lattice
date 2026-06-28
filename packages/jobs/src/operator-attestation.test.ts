import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { default as DatabaseCtor } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JobsService } from './service.js';

const Database = DatabaseCtor;

/**
 * Operator-attestation lock — entry-layer protection at
 * JobsService.attemptCheck. Run-2 failure mode: the architect, under
 * no-progress pressure, wrote the operator's done-attestation file
 * itself; the file_exists gate auto-closed the operator item via the
 * write-phase auto-sweep, transitioning the job to closed_full before
 * the actual work was done.
 *
 * Fix: items with source='operator' refuse non-operator mode. The bridge
 * endpoint POST /api/lattices/:id/items/:item_id/attest is the only
 * caller in the codebase that passes mode='operator'. The architect's
 * close-job-item path defaults to mode='lattice'; the auto-sweep uses
 * mode='auto'. plan_item.source is architect-immutable (proved in
 * source-immutability.test.ts), so the protection cannot be picked from
 * the side.
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
      source TEXT NOT NULL DEFAULT 'operator', blocked_by TEXT
    );
  `);
  return db;
}

describe('operator-attestation lock (entry-layer refusal at attemptCheck)', () => {
  let dir: string;
  let jobs: JobsService;
  let jobId: string;
  let gatedPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-attest-'));
    jobs = new JobsService(freshDb());
    const job = jobs.openJob({ title: 'test', source: 'operator', why: 'verify lock', cycle: 1, at_ms: 1 });
    jobId = job.id;
    gatedPath = join(dir, 'attestation.md');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function addOperatorItem(): string {
    // The addItem layer now rejects file_exists on operator items (the run-3
    // fix). Use always_pass here — the source-lock refusal at attemptCheck
    // fires BEFORE any gate runs, so the gate semantics don't matter for the
    // tests in this file; we just need a gate the addItem layer accepts.
    const item = jobs.addItem(jobId, {
      description: 'land done attestation',
      spec: { hooks: [{ name: 'always_pass' }] },
      source: 'operator',
    });
    return item.id;
  }

  function addLatticeItem(): string {
    const item = jobs.addItem(jobId, {
      description: 'lattice-side deliverable',
      spec: { hooks: [{ name: 'file_exists', args: { path: gatedPath, minBytes: 4000 } }] },
      source: 'lattice_appended',
    });
    return item.id;
  }

  function writeGatedFile(bytes = 5000) {
    writeFileSync(gatedPath, 'x'.repeat(bytes));
  }

  it("architect's close-job-item (mode='lattice') is REFUSED on source='operator' items even when the gate is satisfied", async () => {
    const id = addOperatorItem();
    writeGatedFile(); // file_exists gate would pass under any other mode
    const r = await jobs.attemptCheck(id, { cycle: 2, mode: 'lattice' });
    expect(r.outcome).toBe('awaiting_operator');
    expect(r.reason).toMatch(/operator endpoint|attest/i);
    // Item must still be open AND iteration_count untouched — no hook ran.
    const item = jobs.checklist.getItem(id)!;
    expect(item.state).toBe('open');
    expect(item.iteration_count).toBe(0);
  });

  it("auto-sweep (mode='auto') is REFUSED on source='operator' items even when the gate is satisfied", async () => {
    const id = addOperatorItem();
    writeGatedFile();
    const r = await jobs.attemptCheck(id, { cycle: 2, mode: 'auto' });
    expect(r.outcome).toBe('awaiting_operator');
    const item = jobs.checklist.getItem(id)!;
    expect(item.state).toBe('open');
  });

  it("operator endpoint (mode='operator') CLOSES the item when the gate is satisfied", async () => {
    const id = addOperatorItem();
    writeGatedFile();
    const r = await jobs.attemptCheck(id, { cycle: 7, mode: 'operator' });
    expect(r.outcome).toBe('passed');
    const item = jobs.checklist.getItem(id)!;
    expect(item.state).toBe('passed');
    expect(item.passed_at_cycle).toBe(7);
  });

  // Note: a previous test here verified "operator endpoint is NOT a force-
  // pass" using a file_exists gate that wouldn't satisfy. That test moved
  // to operator-attested-hook.test.ts and was strengthened: the new hook
  // refuses on missing attestation row AND on incomplete siblings, including
  // deferred ones. file_exists is no longer permitted on operator items at
  // all (engine rejects at addItem boundary).

  it("source='lattice_appended' items behave exactly as before (no regression)", async () => {
    const id = addLatticeItem();
    writeGatedFile();
    // lattice mode (the architect's close-job-item path) passes the item.
    const r = await jobs.attemptCheck(id, { cycle: 4, mode: 'lattice' });
    expect(r.outcome).toBe('passed');
    const item = jobs.checklist.getItem(id)!;
    expect(item.state).toBe('passed');
  });

  it("when an architect closes every other item but ord=1 is source='operator', the job stays open until the operator endpoint runs", async () => {
    const opId = addOperatorItem();
    const latticeId = addLatticeItem();
    writeGatedFile();
    // Architect closes the lattice-side item.
    const r1 = await jobs.attemptCheck(latticeId, { cycle: 1, mode: 'lattice' });
    expect(r1.outcome).toBe('passed');
    // Architect tries the operator item — refused.
    const r2 = await jobs.attemptCheck(opId, { cycle: 1, mode: 'lattice' });
    expect(r2.outcome).toBe('awaiting_operator');
    // Operator finally calls /attest.
    const r3 = await jobs.attemptCheck(opId, { cycle: 99, mode: 'operator' });
    expect(r3.outcome).toBe('passed');
  });
});
