import { randomUUID } from 'node:crypto';

import { migrate, openDb, renderOpenQuestions, type Db } from '@runcor/runtime';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { driftReview } from './drift-review.js';

/**
 * Step 4 — Tier-3 frame_order detector, wired into the slow-clock pipe.
 *
 * The load-bearing safety properties are STRUCTURAL:
 *   (a) Tier-3 surfaces are physically in a different table than corrections;
 *   (b) The render section reads only that table;
 *   (c) The age-out is decision-keyed (memory marker), not object-keyed.
 *
 * These properties are not just tested behaviourally — they're enforced by the
 * schema (NOT NULL CHECKs on the three text columns), the typed
 * OPEN_QUESTION_AGE_OUT Record, and the corrections/open-questions selectors
 * reading disjoint tables.
 */

let dbHandle: Db | null = null;
beforeEach(() => {
  dbHandle = openDb(':memory:');
  migrate(dbHandle);
  dbHandle.prepare(
    `INSERT INTO entity (id, lattice_id, name, created_at_ms, cycle, schema_version)
     VALUES ('self', ?, 'test', 0, 0, 1)`,
  ).run(randomUUID());
});
afterEach(() => {
  if (dbHandle) {
    try {
      dbHandle.close();
    } catch {
      /* already closed */
    }
    dbHandle = null;
  }
});

function db(): Db {
  if (!dbHandle) throw new Error('db not initialised');
  return dbHandle;
}

function addJob(body: string): string {
  const id = randomUUID();
  db().prepare(
    `INSERT INTO plan_job (id, opened_at_cycle, opened_at_ms, title, source, status, why, body)
     VALUES (?, 0, 0, 'test', 'operator', 'open', 'test', ?)`,
  ).run(id, body);
  return id;
}

function addPassed(jobId: string, description: string, passedAt: number): string {
  const id = randomUUID();
  db().prepare(
    `INSERT INTO plan_item
       (id, job_id, ordinal, description, state, completion_check, source, passed_at_cycle)
     VALUES (?, ?, 0, ?, 'passed', '{"hooks":[]}', 'operator', ?)`,
  ).run(id, jobId, description, passedAt);
  return id;
}

function countCorrections(): number {
  return (db()
    .prepare(`SELECT COUNT(*) AS n FROM memory_semantic_correction`)
    .get() as { n: number }).n;
}

function countSemanticMemories(): number {
  return (db()
    .prepare(`SELECT COUNT(*) AS n FROM memory_semantic`)
    .get() as { n: number }).n;
}

function readOpenQuestions(): Array<{
  id: string;
  kind: string;
  item_id: string | null;
  lattice_position: string;
  watchdog_position: string;
  no_object_reason: string;
  resolved_at_ms: number | null;
  resolved_by_memory_id: string | null;
}> {
  return db()
    .prepare(
      `SELECT id, kind, item_id, lattice_position, watchdog_position,
              no_object_reason, resolved_at_ms, resolved_by_memory_id
       FROM drift_open_question
       ORDER BY cycle ASC, at_ms ASC`,
    )
    .all() as Array<{
    id: string;
    kind: string;
    item_id: string | null;
    lattice_position: string;
    watchdog_position: string;
    no_object_reason: string;
    resolved_at_ms: number | null;
    resolved_by_memory_id: string | null;
  }>;
}

describe('drift-review · Tier-3 frame_order — wired into the slow-clock pipe', () => {
  it('END-TO-END — divergence is surfaced in drift_open_question with all three text columns populated', () => {
    // Topic words must be disjoint between positions for the divergence to
    // surface (token-overlap match is conservative — shared word = match).
    const jobId = addJob('1. Architecture\n2. Implementation');
    addPassed(jobId, 'Implementation produced', 1);
    addPassed(jobId, 'Architecture sketch produced', 2);

    const result = driftReview(db(), { cycle: 50, at_ms: 1_000 });
    expect(result.openQuestions).toHaveLength(1);
    expect(result.openQuestions[0]!.kind).toBe('frame_order');

    const rows = readOpenQuestions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lattice_position.length).toBeGreaterThan(0);
    expect(rows[0]!.watchdog_position.length).toBeGreaterThan(0);
    expect(rows[0]!.no_object_reason.length).toBeGreaterThan(0);
    expect(rows[0]!.lattice_position).toContain('Implementation');
    expect(rows[0]!.watchdog_position).toContain('Architecture');
  });

  it('PHYSICAL SEPARATION — a Tier-3 surface adds ZERO rows to memory_semantic or memory_semantic_correction', () => {
    const beforeCorr = countCorrections();
    const beforeSem = countSemanticMemories();

    const jobId = addJob('1. Architecture\n2. Implementation');
    addPassed(jobId, 'Implementation produced', 1);
    addPassed(jobId, 'Architecture sketch produced', 2);

    driftReview(db(), { cycle: 50, at_ms: 1_000 });

    expect(countCorrections()).toBe(beforeCorr);
    expect(countSemanticMemories()).toBe(beforeSem);
    expect(readOpenQuestions()).toHaveLength(1);
  });

  it('END-TO-END — the surface renders under the distinct open-questions header', () => {
    const jobId = addJob('1. Architecture\n2. Implementation');
    addPassed(jobId, 'Implementation produced', 1);
    addPassed(jobId, 'Architecture sketch produced', 2);

    driftReview(db(), { cycle: 50, at_ms: 1_000 });

    const rendered = renderOpenQuestions(db(), 4, 1500);
    const firstLine = rendered.split('\n')[0];
    expect(firstLine).toBe(
      'open questions from last review (no authoritative object — your dialectic decides):',
    );
    expect(rendered).toContain('[frame_order]');
    expect(rendered).toContain("lattice's position:");
    expect(rendered).toContain("watchdog's position:");
    expect(rendered).toContain('no authoritative object because:');
  });

  it('DEDUP — the same divergence on a second pass does NOT write a fresh row', () => {
    const jobId = addJob('1. Architecture\n2. Implementation');
    addPassed(jobId, 'Implementation produced', 1);
    addPassed(jobId, 'Architecture sketch produced', 2);

    driftReview(db(), { cycle: 50, at_ms: 1_000 });
    driftReview(db(), { cycle: 60, at_ms: 2_000 });

    expect(readOpenQuestions()).toHaveLength(1);
  });

  it('AGE-OUT — a memory with the resolves-question marker flips resolved_at_*', () => {
    const jobId = addJob('1. Architecture\n2. Implementation');
    addPassed(jobId, 'Implementation produced', 1);
    addPassed(jobId, 'Architecture sketch produced', 2);

    const result = driftReview(db(), { cycle: 50, at_ms: 1_000 });
    const questionId = result.openQuestionIds[0]!;

    // Lattice writes a decision memory that includes the resolution marker.
    const memId = randomUUID();
    db().prepare(
      `INSERT INTO memory_semantic
         (id, written_at_ms, last_validated_ms, cycle, body, why, source_kind, source_ref)
       VALUES (?, 1500, 1500, 55, ?, 'lattice decided', 'operator', NULL)`,
    ).run(
      memId,
      `Decided to follow lattice's reordering; resolves-question:${questionId}; rationale: tests-first is healthier.`,
    );

    driftReview(db(), { cycle: 60, at_ms: 2_000 });

    const rows = readOpenQuestions();
    expect(rows[0]!.resolved_at_ms).toBe(2_000);
    expect(rows[0]!.resolved_by_memory_id).toBe(memId);

    // And the recall section no longer shows it.
    expect(renderOpenQuestions(db(), 4, 1500)).toBe('');
  });

  it('AGE-OUT — file changes do NOT resolve a Tier-3 question (wrong-arm protection)', () => {
    const jobId = addJob('1. Architecture\n2. Implementation');
    addPassed(jobId, 'Implementation produced', 1);
    addPassed(jobId, 'Architecture sketch produced', 2);

    driftReview(db(), { cycle: 50, at_ms: 1_000 });

    // Even after many passes with arbitrary plan_item / file activity, the
    // question stays open until the lattice records a resolution. The
    // resolver only consults memory_semantic markers.
    addPassed(jobId, 'Some new unrelated work', 3);
    driftReview(db(), { cycle: 60, at_ms: 2_000 });

    const rows = readOpenQuestions();
    expect(rows[0]!.resolved_at_ms).toBeNull();
  });

  it('SCHEMA — drift_open_question NOT-NULL CHECKs prevent a one-position row', () => {
    // Direct probe: try to INSERT a row with empty watchdog_position.
    expect(() => {
      db().prepare(
        `INSERT INTO drift_open_question
           (id, kind, cycle, at_ms, item_id, lattice_position, watchdog_position, no_object_reason)
         VALUES (?, 'frame_order', 1, 1, NULL, 'x', '', 'no obj')`,
      ).run(randomUUID());
    }).toThrow();
  });
});
