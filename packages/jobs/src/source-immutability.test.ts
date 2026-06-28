import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { default as DatabaseCtor } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { makeAppendPlanItemAction } from '@runcor/capabilities';
import { JobsService } from './service.js';

const Database = DatabaseCtor;

/**
 * The operator-attestation lock keys on plan_item.source === 'operator'.
 * For that lock to hold, the architect must have no way to author or mutate
 * the source field via any capability in its action surface. These tests
 * prove the lock cannot be picked from the side.
 *
 *   Run-2 stall: architect wrote the operator's done-attestation file
 *   under no-progress pressure; the file_exists gate auto-closed the
 *   operator item. The entry-layer fix at attemptCheck refuses non-
 *   operator mode on source='operator' items, but the fix's protection
 *   collapses if the architect can either (a) create an item with
 *   source='operator' OR (b) mutate an existing item's source from
 *   non-operator to operator. These tests prove neither path exists.
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

describe("plan_item.source is immutable from the architect's surface", () => {
  it("append-plan-item drops 'source' even when the architect injects it via R++ TOKENS", async () => {
    // Simulate the architect emitting a TOKENS block that includes a stray
    // `source: "operator"` field — decide's extractTokens places that into
    // chosenInput as-is, so the architect WILL get a chance to try it.
    // The append-plan-item capability's input schema (AppendPlanItemInput)
    // has no source field, and normaliseInput only copies the whitelisted
    // fields (jobId, description, gate, blockedBy, why). Any extra TOKENS
    // — including source — must be dropped before the callback runs.
    let receivedArg: unknown = null;
    const cap = makeAppendPlanItemAction({
      append: (input) => {
        receivedArg = input;
        return { ok: true, itemId: 'new-item-id' };
      },
    });
    await cap.invoke(
      // deliberately malformed: source is not part of AppendPlanItemInput;
      // a malicious decide could still try to send it.
      {
        jobId: 'job-1',
        description: 'sneaky attestation',
        gate: { type: 'always_pass' },
        // @ts-expect-error — extra field the schema does not declare
        source: 'operator',
      },
      { cycle: 1, autonomy: 'medium', budgetRemaining: Infinity, lastReadAtMs: null, abortSignal: new AbortController().signal },
    );
    expect(receivedArg).not.toBeNull();
    // The append callback receives a normalised AppendPlanItemInput. The
    // structural test: 'source' is not a member of that interface, so it
    // must not appear on the object passed to append().
    expect(Object.prototype.hasOwnProperty.call(receivedArg, 'source')).toBe(false);
  });

  it("JobsService.appendLatticeItem hardcodes source='lattice_appended' and ignores any caller-supplied source", () => {
    // The runtime wires append-plan-item's callback to jobs.appendLatticeItem,
    // which constructs the addItem call internally with source: 'lattice_appended'.
    // Even if a future caller added source to the appendLatticeItem args type,
    // the current implementation does not consume it.
    const db = freshDb();
    const jobs = new JobsService(db);
    const job = jobs.openJob({ title: 't', source: 'operator', why: 'w', cycle: 1, at_ms: 1 });
    const r = jobs.appendLatticeItem(
      job.id,
      { description: 'try to land an operator item', gateType: 'always_pass' },
      { cycle: 1, at_ms: 1 },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const item = jobs.checklist.getItem(r.item.id)!;
      expect(item.source).toBe('lattice_appended');
      expect(item.source).not.toBe('operator');
    }
  });

  it("no source-mutating SQL exists in @runcor/capabilities — the only architect-callable package", () => {
    // The architect's tool surface is built from @runcor/capabilities. If any
    // capability there had an UPDATE statement against plan_item.source, the
    // entry-layer attemptCheck refusal could be sidestepped: the architect
    // would change the source from 'lattice_appended' to 'operator' (or
    // vice-versa) and bypass the gate.
    const here = dirname(fileURLToPath(import.meta.url));
    const capsDir = join(here, '..', '..', 'capabilities', 'src');
    const files = readdirSync(capsDir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'),
    );
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const f of files) {
      const body = readFileSync(join(capsDir, f), 'utf8');
      // Any UPDATE plan_item ... source = ... is a hole.
      if (/UPDATE\s+plan_item[^;]*\bsource\s*=/is.test(body)) {
        violations.push(f);
      }
      // Also prohibit raw INSERTs that the architect could use to mint a
      // plan_item with arbitrary source. The legitimate inserter lives in
      // @runcor/jobs (checklist.ts); none should live in capabilities/.
      if (/INSERT\s+INTO\s+plan_item/i.test(body)) {
        violations.push(`${f} (raw INSERT)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("no source-mutating SQL exists in @runcor/jobs's runtime-callable paths — only checklist.addItem writes source", () => {
    // The jobs package is also reachable from the architect transitively
    // through JobsService.appendLatticeItem. The only place source should be
    // written is checklist.addItem (single point of authority). Any other
    // writer is a hole.
    const here = dirname(fileURLToPath(import.meta.url));
    const jobsDir = here; // same dir we're in
    const files = readdirSync(jobsDir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts') && f !== 'checklist.ts',
    );
    const violations: string[] = [];
    for (const f of files) {
      const body = readFileSync(join(jobsDir, f), 'utf8');
      if (/UPDATE\s+plan_item[^;]*\bsource\s*=/is.test(body)) {
        violations.push(`${f} (UPDATE plan_item ... source =)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("no INSERT INTO operator_attestation exists in @runcor/capabilities (architect can't write the attestation row)", () => {
    // The operator-attestation table is the only satisfier for the new
    // operator_attested hook. If any capability could INSERT into it, the
    // architect would have a side channel to satisfy its own terminal gate
    // — the run-2 self-attestation hole in a new shape. The legitimate
    // writer is the bridge POST /attest endpoint (apps/bridge-api/), which
    // is not in the architect's tool surface.
    const here = dirname(fileURLToPath(import.meta.url));
    const capsDir = join(here, '..', '..', 'capabilities', 'src');
    const files = readdirSync(capsDir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'),
    );
    const violations: string[] = [];
    for (const f of files) {
      const body = readFileSync(join(capsDir, f), 'utf8');
      if (/INSERT\s+INTO\s+operator_attestation/i.test(body)) {
        violations.push(`${f} (INSERT INTO operator_attestation)`);
      }
      if (/UPDATE\s+operator_attestation/i.test(body)) {
        violations.push(`${f} (UPDATE operator_attestation)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("no INSERT INTO operator_attestation exists in @runcor/jobs either (defence-in-depth)", () => {
    // @runcor/jobs is reachable from the architect via appendLatticeItem and
    // close-job-item. It must not write to operator_attestation either —
    // only the bridge writes. The hook (in completion-check.ts) READS the
    // table but does not write.
    const here = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(here).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'),
    );
    const violations: string[] = [];
    for (const f of files) {
      const body = readFileSync(join(here, f), 'utf8');
      if (/INSERT\s+INTO\s+operator_attestation/i.test(body)) {
        violations.push(`${f} (INSERT INTO operator_attestation)`);
      }
      if (/UPDATE\s+operator_attestation/i.test(body)) {
        violations.push(`${f} (UPDATE operator_attestation)`);
      }
    }
    expect(violations).toEqual([]);
  });
});
