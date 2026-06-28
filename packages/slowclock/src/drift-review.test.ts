import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrate, openDb, type Db, renderWatchdogCorrections } from '@runcor/runtime';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { driftReview } from './drift-review.js';

/**
 * Three-tier watchdog Step 1 — recall wire on the existing tool_unused finding.
 *
 * Proves end-to-end that:
 *   1. A blind_spot finding from findGaps produces ONE coherent persistence
 *      event: a semantic row + a watchdog-rule audit row, atomically.
 *   2. The same gap is NOT re-asserted on the next pass while unresolved.
 *   3. Age-out flips resolved_at_* when the underlying gap closes; the audit
 *      row is preserved (forensic).
 *   4. Recurrence after resolution writes a FRESH audit row (preserves
 *      "fixed at c40, broke again at c80").
 *
 * The READ-ONLY INVARIANT (no shell-exec, no fs writes outside the in-process
 * sqlite connection) is tested separately in read-only-invariant.test.ts so it
 * can use vi.mock without affecting these tests.
 */

function freshDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO entity (id, lattice_id, name, created_at_ms, cycle, schema_version)
     VALUES ('self', ?, 'test', 0, 0, 1)`,
  ).run(randomUUID());
  return db;
}

function addCapability(db: Db, name: string): void {
  db.prepare(
    `INSERT INTO capability
       (id, name, source_kind, role_sense, role_action, added_at_cycle, enabled)
     VALUES (?, ?, 'manifest', 0, 1, 0, 1)`,
  ).run(randomUUID(), name);
}

function addGoal(db: Db, body: string): void {
  db.prepare(
    `INSERT INTO goal (id, body, proposed_at_cycle, state, why)
     VALUES (?, ?, 0, 'active', 'test')`,
  ).run(randomUUID(), body);
}

function recordActUsage(db: Db, cycle: number, action: string): void {
  db.prepare(
    `INSERT INTO trace (cycle, at_ms, kind, phase, body)
     VALUES (?, 0, 'phase', 'act', ?)`,
  ).run(cycle, JSON.stringify({ output_summary: `action=${action} ok` }));
}

function readCorrections(
  db: Db,
): Array<{
  id: string;
  rule: string;
  was: string;
  now_is: string;
  cycle: number;
  resolved_at_ms: number | null;
  resolved_at_cycle: number | null;
  body: string;
  source_ref: string | null;
}> {
  return db
    .prepare(
      `SELECT msc.id, msc.rule, msc.was, msc.now_is, msc.cycle,
              msc.resolved_at_ms, msc.resolved_at_cycle,
              ms.body, ms.source_ref
         FROM memory_semantic_correction msc
         JOIN memory_semantic ms ON ms.id = msc.semantic_id
        ORDER BY msc.cycle ASC, msc.at_ms ASC`,
    )
    .all() as Array<{
    id: string;
    rule: string;
    was: string;
    now_is: string;
    cycle: number;
    resolved_at_ms: number | null;
    resolved_at_cycle: number | null;
    body: string;
    source_ref: string | null;
  }>;
}

describe('drift-review · three-tier watchdog Step 1 — recall wire', () => {
  it('writes ONE coherent persistence event per watchdog finding: semantic row + audit row, atomic', () => {
    const db = freshDb();
    addCapability(db, 'foo');
    addGoal(db, 'use the foo tool to do the thing');

    const result = driftReview(db, { cycle: 50, at_ms: 1_000 });
    expect(result.findings.some((f) => f.kind === 'blind_spot')).toBe(true);

    const corrections = readCorrections(db);
    expect(corrections).toHaveLength(1);
    const c = corrections[0]!;
    expect(c.rule).toBe('watchdog:tool_unused');
    expect(c.body.startsWith('[watchdog:tool_unused]')).toBe(true);
    expect(c.source_ref).toMatch(/capability=foo/);
    expect(c.cycle).toBe(50);
    expect(c.resolved_at_ms).toBeNull();
    expect(c.resolved_at_cycle).toBeNull();
    expect(c.was).toBe('stated need; no usage in window');
    expect(c.now_is).toContain('foo');
  });

  it('does not re-write the same unresolved finding on a second pass', () => {
    const db = freshDb();
    addCapability(db, 'foo');
    addGoal(db, 'use the foo tool to do the thing');

    driftReview(db, { cycle: 50, at_ms: 1_000 });
    driftReview(db, { cycle: 60, at_ms: 2_000 });

    const corrections = readCorrections(db);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.cycle).toBe(50);
  });

  it('ages out when the underlying gap closes; audit row is preserved', () => {
    const db = freshDb();
    addCapability(db, 'foo');
    addGoal(db, 'use the foo tool to do the thing');

    driftReview(db, { cycle: 50, at_ms: 1_000 });
    let corrections = readCorrections(db);
    expect(corrections[0]!.resolved_at_ms).toBeNull();

    recordActUsage(db, 55, 'foo');
    driftReview(db, { cycle: 60, at_ms: 2_000 });

    corrections = readCorrections(db);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.resolved_at_ms).toBe(2_000);
    expect(corrections[0]!.resolved_at_cycle).toBe(60);
  });

  it('on recurrence after resolution, writes a FRESH audit row (preserves forensic history)', () => {
    const db = freshDb();
    addCapability(db, 'foo');
    addGoal(db, 'use the foo tool to do the thing');

    driftReview(db, { cycle: 50, at_ms: 1_000 });

    recordActUsage(db, 55, 'foo');
    driftReview(db, { cycle: 60, at_ms: 2_000 });

    // The act-row at cycle 55 falls outside the default 100-cycle window once
    // the current cycle is > 155. At cycle 160 the gap recurs.
    driftReview(db, { cycle: 160, at_ms: 3_000 });

    const corrections = readCorrections(db);
    expect(corrections).toHaveLength(2);
    expect(corrections[0]!.cycle).toBe(50);
    expect(corrections[0]!.resolved_at_cycle).toBe(60);
    expect(corrections[1]!.cycle).toBe(160);
    expect(corrections[1]!.resolved_at_ms).toBeNull();
  });

  it('END-TO-END — a finding written this pass reaches the next cycle prompt section', () => {
    // The whole point of Step 1: prove the pipe delivers. A finding produced
    // by driftReview must be readable by the ground-phase renderer on the
    // SAME database. Wires the slow-clock write to the next cycle's recall.
    const db = freshDb();
    addCapability(db, 'foo');
    addGoal(db, 'use the foo tool to do the thing');

    driftReview(db, { cycle: 50, at_ms: 1_000 });

    const rendered = renderWatchdogCorrections(db, 6, 1500);
    expect(rendered.split('\n')[0]).toBe(
      'corrections from last review (each cites the object that proves it):',
    );
    expect(rendered).toContain('[watchdog:tool_unused]');
    expect(rendered).toContain('foo');
    expect(rendered).toContain('proof: capability=foo');
  });

  it('END-TO-END — once a finding ages out, the next cycle prompt no longer shows it', () => {
    const db = freshDb();
    addCapability(db, 'foo');
    addGoal(db, 'use the foo tool to do the thing');

    driftReview(db, { cycle: 50, at_ms: 1_000 });
    expect(renderWatchdogCorrections(db, 6, 1500)).toContain('[watchdog:tool_unused]');

    // Tool used → next pass resolves the finding.
    recordActUsage(db, 55, 'foo');
    driftReview(db, { cycle: 60, at_ms: 2_000 });

    expect(renderWatchdogCorrections(db, 6, 1500)).toBe('');
  });
});

/* ============================ claim_vs_disk wiring ============================ */

function addPassedItem(
  db: Db,
  args: { description: string; completionCheck?: string },
): string {
  const id = randomUUID();
  const jobId = randomUUID();
  // Plan-job parent is required by the FK on plan_item.job_id.
  db.prepare(
    `INSERT INTO plan_job (id, opened_at_cycle, opened_at_ms, title, source, status, why, body)
     VALUES (?, 0, 0, 'test', 'operator', 'open', 'test', '')`,
  ).run(jobId);
  db.prepare(
    `INSERT INTO plan_item
       (id, job_id, ordinal, description, state, completion_check, source)
     VALUES (?, ?, 0, ?, 'passed', ?, 'operator')`,
  ).run(id, jobId, args.description, args.completionCheck ?? '{"hooks":[]}');
  return id;
}

describe('drift-review · claim_vs_disk (Step 2 wired into the Step-1 pipe)', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cvd-wired-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('END-TO-END — driftReview writes a watchdog:claim_vs_disk row → renders in next-cycle prompt', () => {
    const db = freshDb();
    const absent = join(tmpRoot, 'plan.md');
    const itemId = addPassedItem(db, {
      description: 'wrote the plan',
      completionCheck: JSON.stringify({
        hooks: [{ name: 'file_exists', args: { path: absent } }],
      }),
    });

    driftReview(db, { cycle: 50, at_ms: 1_000 });

    const rendered = renderWatchdogCorrections(db, 6, 1500);
    expect(rendered.split('\n')[0]).toBe(
      'corrections from last review (each cites the object that proves it):',
    );
    expect(rendered).toContain('[watchdog:claim_vs_disk]');
    expect(rendered).toContain(itemId);
    expect(rendered).toContain(`claimed_path=${absent}`);
    expect(rendered).toContain('status=absent');
  });

  it('AGE-OUT — when the file later appears non-empty, resolved_at_* flips and recall stops showing it', () => {
    const db = freshDb();
    const path = join(tmpRoot, 'late.md');
    addPassedItem(db, {
      description: 'wrote late.md',
      completionCheck: JSON.stringify({
        hooks: [{ name: 'file_exists', args: { path } }],
      }),
    });

    driftReview(db, { cycle: 50, at_ms: 1_000 });
    expect(renderWatchdogCorrections(db, 6, 1500)).toContain(
      '[watchdog:claim_vs_disk]',
    );

    // File appears with real content.
    writeFileSync(path, '# real');
    driftReview(db, { cycle: 60, at_ms: 2_000 });

    expect(renderWatchdogCorrections(db, 6, 1500)).toBe('');

    // Audit row is preserved with resolved_at_* set (forensic history).
    const row = db
      .prepare(
        `SELECT resolved_at_ms, resolved_at_cycle FROM memory_semantic_correction
         WHERE rule = 'watchdog:claim_vs_disk'`,
      )
      .get() as { resolved_at_ms: number; resolved_at_cycle: number };
    expect(row.resolved_at_ms).toBe(2_000);
    expect(row.resolved_at_cycle).toBe(60);
  });

  it('RECURRENCE — file appears then is deleted again → a fresh row is written', () => {
    const db = freshDb();
    const path = join(tmpRoot, 'flap.md');
    addPassedItem(db, {
      description: 'wrote flap.md',
      completionCheck: JSON.stringify({
        hooks: [{ name: 'file_exists', args: { path } }],
      }),
    });

    driftReview(db, { cycle: 50, at_ms: 1_000 });
    writeFileSync(path, '# real');
    driftReview(db, { cycle: 60, at_ms: 2_000 });
    // Confirm resolved.
    expect(renderWatchdogCorrections(db, 6, 1500)).toBe('');

    // File is deleted again — gap recurs.
    unlinkSync(path);
    driftReview(db, { cycle: 70, at_ms: 3_000 });

    const rows = db
      .prepare(
        `SELECT cycle, resolved_at_ms FROM memory_semantic_correction
         WHERE rule = 'watchdog:claim_vs_disk' ORDER BY cycle ASC`,
      )
      .all() as Array<{ cycle: number; resolved_at_ms: number | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.cycle).toBe(50);
    expect(rows[0]!.resolved_at_ms).toBe(2_000);
    expect(rows[1]!.cycle).toBe(70);
    expect(rows[1]!.resolved_at_ms).toBeNull();
    // And the recurrence renders in the next prompt.
    expect(renderWatchdogCorrections(db, 6, 1500)).toContain(
      '[watchdog:claim_vs_disk]',
    );
  });

  it('SKIP-NOTE — a passed item with a relative path and no pathRoot is SKIPPED, NOT a finding', () => {
    const db = freshDb();
    addPassedItem(db, {
      description: 'wrote the result to out/relative.md this cycle',
    });

    const result = driftReview(db, { cycle: 50, at_ms: 1_000 });
    // No claim_vs_disk finding (couldn't adjudicate).
    expect(
      result.findings.filter(
        (f) => f.kind === 'blind_spot' && f.watchdogKind === 'claim_vs_disk',
      ),
    ).toHaveLength(0);
    // A skip-note WAS recorded.
    expect(
      result.skipNotes.some((n) => n.reason === 'relative_path_no_root'),
    ).toBe(true);
    // And written to the trace table as a benign 'operator' entry.
    const traceRow = db
      .prepare(
        `SELECT body FROM trace
         WHERE kind = 'operator' AND body LIKE '%watchdog_skipped%'`,
      )
      .get() as { body: string } | undefined;
    expect(traceRow).toBeDefined();
    expect(traceRow!.body).toContain('relative_path_no_root');
  });

  it('SKIP-NOTE — driftReview never throws on a single bad item', () => {
    const db = freshDb();
    addPassedItem(db, {
      description: 'this item has garbage in completion_check',
      completionCheck: 'this is not valid json {',
    });
    // Even with garbage, the tick completes.
    expect(() => driftReview(db, { cycle: 50, at_ms: 1_000 })).not.toThrow();
  });

  it('PATH-ROOT — driftReview forwards pathRoot to the detector', () => {
    const db = freshDb();
    addPassedItem(db, {
      description: 'wrote the result to out/relative.md this cycle',
    });

    const result = driftReview(db, {
      cycle: 50,
      at_ms: 1_000,
      pathRoot: tmpRoot,
    });
    // With pathRoot the relative path is resolved and checked → finding fires.
    expect(
      result.findings.some(
        (f) => f.kind === 'blind_spot' && f.watchdogKind === 'claim_vs_disk',
      ),
    ).toBe(true);
    // No skip-note for this case (the path was resolvable).
    expect(
      result.skipNotes.some((n) => n.reason === 'relative_path_no_root'),
    ).toBe(false);
  });
});

/* ============================ Tier-2 gate detectors wiring ============================ */

describe('drift-review · Tier-2 gate detectors wired into the Step-1/2 pipe', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'gate-wired-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('END-TO-END — gate_content_unmet writes a correction → renders in next-cycle prompt', () => {
    const db = freshDb();
    const path = join(tmpRoot, 'spec.md');
    writeFileSync(path, 'no marker here');
    const itemId = addPassedItem(db, {
      description: 'spec',
      completionCheck: JSON.stringify({
        hooks: [{ name: 'content_contains', args: { path, needle: 'APPROVED' } }],
      }),
    });

    driftReview(db, { cycle: 50, at_ms: 1_000 });

    const rendered = renderWatchdogCorrections(db, 6, 1500);
    expect(rendered).toContain('[watchdog:gate_content_unmet]');
    expect(rendered).toContain(itemId);
    expect(rendered).toContain(`gate_path=${path}`);
    expect(rendered).toContain('status=not_matching');
  });

  it('END-TO-END — gate_minbytes_unmet writes a correction → renders in next-cycle prompt', () => {
    const db = freshDb();
    const path = join(tmpRoot, 'plan.md');
    writeFileSync(path, 'short');
    const itemId = addPassedItem(db, {
      description: 'plan',
      completionCheck: JSON.stringify({
        hooks: [{ name: 'file_exists', args: { path, minBytes: 500 } }],
      }),
    });

    driftReview(db, { cycle: 50, at_ms: 1_000 });

    const rendered = renderWatchdogCorrections(db, 6, 1500);
    expect(rendered).toContain('[watchdog:gate_minbytes_unmet]');
    expect(rendered).toContain(itemId);
    expect(rendered).toContain('required_bytes=500');
    expect(rendered).toContain('actual_bytes=5');
  });

  it('AGE-OUT — gate_content_unmet resolves when the file is updated to contain the needle', () => {
    const db = freshDb();
    const path = join(tmpRoot, 'spec.md');
    writeFileSync(path, 'pending');
    addPassedItem(db, {
      description: 'spec',
      completionCheck: JSON.stringify({
        hooks: [{ name: 'content_contains', args: { path, needle: 'APPROVED' } }],
      }),
    });

    driftReview(db, { cycle: 50, at_ms: 1_000 });
    expect(renderWatchdogCorrections(db, 6, 1500)).toContain(
      '[watchdog:gate_content_unmet]',
    );

    // File gains the required content.
    writeFileSync(path, 'pending\nAPPROVED\n');
    driftReview(db, { cycle: 60, at_ms: 2_000 });

    expect(renderWatchdogCorrections(db, 6, 1500)).toBe('');

    const row = db
      .prepare(
        `SELECT resolved_at_cycle FROM memory_semantic_correction
         WHERE rule = 'watchdog:gate_content_unmet'`,
      )
      .get() as { resolved_at_cycle: number };
    expect(row.resolved_at_cycle).toBe(60);
  });

  it('AGE-OUT — gate_minbytes_unmet resolves when the file grows past the threshold', () => {
    const db = freshDb();
    const path = join(tmpRoot, 'plan.md');
    writeFileSync(path, 'short');
    addPassedItem(db, {
      description: 'plan',
      completionCheck: JSON.stringify({
        hooks: [{ name: 'file_exists', args: { path, minBytes: 100 } }],
      }),
    });

    driftReview(db, { cycle: 50, at_ms: 1_000 });
    expect(renderWatchdogCorrections(db, 6, 1500)).toContain(
      '[watchdog:gate_minbytes_unmet]',
    );

    writeFileSync(path, 'a'.repeat(200));
    driftReview(db, { cycle: 60, at_ms: 2_000 });

    expect(renderWatchdogCorrections(db, 6, 1500)).toBe('');
  });

  it('RECURRENCE — content gate fixed then broken writes a fresh row', () => {
    const db = freshDb();
    const path = join(tmpRoot, 'spec.md');
    writeFileSync(path, 'pending');
    addPassedItem(db, {
      description: 'spec',
      completionCheck: JSON.stringify({
        hooks: [{ name: 'content_contains', args: { path, needle: 'OK' } }],
      }),
    });

    driftReview(db, { cycle: 50, at_ms: 1_000 });
    writeFileSync(path, 'OK now');
    driftReview(db, { cycle: 60, at_ms: 2_000 });
    expect(renderWatchdogCorrections(db, 6, 1500)).toBe('');

    // Regression — the marker is removed again.
    writeFileSync(path, 'pending again');
    driftReview(db, { cycle: 70, at_ms: 3_000 });

    const rows = db
      .prepare(
        `SELECT cycle, resolved_at_ms FROM memory_semantic_correction
         WHERE rule = 'watchdog:gate_content_unmet' ORDER BY cycle ASC`,
      )
      .all() as Array<{ cycle: number; resolved_at_ms: number | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.cycle).toBe(50);
    expect(rows[0]!.resolved_at_ms).toBe(2_000);
    expect(rows[1]!.cycle).toBe(70);
    expect(rows[1]!.resolved_at_ms).toBeNull();
  });

  it('NO DOUBLE EMIT — an absent file gives claim_vs_disk only, not a content gate finding', () => {
    const db = freshDb();
    const path = join(tmpRoot, 'never.md');
    addPassedItem(db, {
      description: 'work',
      completionCheck: JSON.stringify({
        hooks: [{ name: 'content_contains', args: { path, needle: 'X' } }],
      }),
    });

    const result = driftReview(db, { cycle: 50, at_ms: 1_000 });
    const kinds = result.findings
      .filter((f) => f.kind === 'blind_spot')
      .map((f) => f.watchdogKind);
    expect(kinds).toContain('claim_vs_disk');
    expect(kinds).not.toContain('gate_content_unmet');
  });
});
