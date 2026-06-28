import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { findGaps, findOpenQuestions, type WatchdogSkipNote } from './index.js';

function fresh() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE capability (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      source_kind TEXT NOT NULL, mcp_server_uri TEXT, api_config_json TEXT,
      role_sense INTEGER NOT NULL, role_action INTEGER NOT NULL,
      added_at_cycle INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, rejected_reason TEXT,
      CHECK (role_sense + role_action >= 1)
    );
    CREATE TABLE goal (
      id TEXT PRIMARY KEY, body TEXT NOT NULL, proposed_at_cycle INTEGER NOT NULL,
      parent_id TEXT, state TEXT NOT NULL, why TEXT NOT NULL
    );
    CREATE TABLE plan_item (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      description TEXT NOT NULL, state TEXT NOT NULL,
      iteration_count INTEGER NOT NULL DEFAULT 0,
      completion_check TEXT NOT NULL,
      passed_at_cycle INTEGER, deferred_at_cycle INTEGER,
      defer_reason TEXT, unblock_condition TEXT, unblock_test TEXT,
      source TEXT NOT NULL DEFAULT 'operator', blocked_by TEXT
    );
    CREATE TABLE trace (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle INTEGER NOT NULL, at_ms INTEGER NOT NULL,
      kind TEXT NOT NULL, phase TEXT, body TEXT NOT NULL
    );
  `);
  return db;
}

function addCap(db: Database.Database, name: string): void {
  db.prepare(
    `INSERT INTO capability (id, name, source_kind, role_sense, role_action, added_at_cycle, enabled)
     VALUES (?, ?, 'manifest', 0, 1, 0, 1)`,
  ).run(randomUUID(), name);
}

function addGoal(db: Database.Database, body: string): void {
  db.prepare(
    `INSERT INTO goal (id, body, proposed_at_cycle, state, why)
     VALUES (?, ?, 0, 'active', 'test')`,
  ).run(randomUUID(), body);
}

function addAct(db: Database.Database, cycle: number, summary: string): void {
  db.prepare(
    `INSERT INTO trace (cycle, at_ms, kind, phase, body) VALUES (?, 0, 'phase', 'act', ?)`,
  ).run(cycle, JSON.stringify({ output_summary: summary }));
}

describe('findGaps (T215 / T225 / intent §12)', () => {
  it('reports an unused tool that appears in a goal body', () => {
    const db = fresh();
    addCap(db, 'send-email');
    addGoal(db, 'I need to send-email to the stakeholder weekly.');
    // No act entries for send-email.
    const findings = findGaps({ db, currentCycle: 50 });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('tool_unused');
    expect(findings[0]?.summary).toMatch(/send-email/);
  });

  it('does not report when the tool was used in the window', () => {
    const db = fresh();
    addCap(db, 'send-email');
    addGoal(db, 'I need to send-email.');
    addAct(db, 30, 'action=send-email;result=ok');
    expect(findGaps({ db, currentCycle: 50 })).toHaveLength(0);
  });

  it('does not report when the tool is NOT mentioned anywhere', () => {
    const db = fresh();
    addCap(db, 'unrelated-tool');
    addGoal(db, 'totally different goal');
    expect(findGaps({ db, currentCycle: 50 })).toHaveLength(0);
  });

  it('respects the window — old usage outside the window still triggers', () => {
    const db = fresh();
    addCap(db, 'send-email');
    addGoal(db, 'use send-email please');
    addAct(db, 1, 'action=send-email;result=ok'); // very old
    // Window of 10 cycles: usage was at cycle 1; current cycle 100 → outside window.
    expect(findGaps({ db, currentCycle: 100, windowCycles: 10 })).toHaveLength(1);
  });

  it('returns empty when no capabilities exist', () => {
    const db = fresh();
    addGoal(db, 'some need');
    expect(findGaps({ db, currentCycle: 50 })).toEqual([]);
  });
});

/* =============================== claim_vs_disk =============================== */

function addPlanItem(
  db: Database.Database,
  args: {
    description: string;
    state?: 'open' | 'passed' | 'deferred';
    completion_check?: string;
  },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO plan_item
       (id, job_id, ordinal, description, state, completion_check, source)
     VALUES (?, 'job', 0, ?, ?, ?, 'operator')`,
  ).run(
    id,
    args.description,
    args.state ?? 'passed',
    args.completion_check ?? '{"hooks":[]}',
  );
  return id;
}

describe('findGaps · claim_vs_disk (Step 2 Tier-1 detector)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'watchdog-cvd-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('STRUCTURED — fires when completion_check.file_exists.path is absent', () => {
    const db = fresh();
    const absent = join(tmpRoot, 'does-not-exist.md');
    const itemId = addPlanItem(db, {
      description: 'produce the deliverable',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [{ name: 'file_exists', args: { path: absent } }],
      }),
    });

    const findings = findGaps({ db, currentCycle: 1 });
    const cvd = findings.filter((f) => f.kind === 'claim_vs_disk');
    expect(cvd).toHaveLength(1);
    expect(cvd[0]!.evidence).toContain(`item_id=${itemId}`);
    expect(cvd[0]!.evidence).toContain(`claimed_path=${absent}`);
    expect(cvd[0]!.evidence).toContain('status=absent');
  });

  it('STRUCTURED — fires when the claimed file exists but is empty', () => {
    const db = fresh();
    const empty = join(tmpRoot, 'empty.md');
    writeFileSync(empty, '');
    addPlanItem(db, {
      description: 'produce the deliverable',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [{ name: 'file_exists', args: { path: empty } }],
      }),
    });

    const findings = findGaps({ db, currentCycle: 1 });
    const cvd = findings.filter((f) => f.kind === 'claim_vs_disk');
    expect(cvd).toHaveLength(1);
    expect(cvd[0]!.evidence).toContain('status=empty');
  });

  it('STRUCTURED — does NOT fire when a non-empty file exists at the claimed path', () => {
    const db = fresh();
    const good = join(tmpRoot, 'good.md');
    writeFileSync(good, '# Done\n\nReal content.');
    addPlanItem(db, {
      description: 'produce the deliverable',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [{ name: 'file_exists', args: { path: good } }],
      }),
    });

    const findings = findGaps({ db, currentCycle: 1 });
    expect(findings.filter((f) => f.kind === 'claim_vs_disk')).toHaveLength(0);
  });

  it('FREE-TEXT — fires on an absolute path in description (verb+locative claim)', () => {
    const db = fresh();
    const absent = join(tmpRoot, 'sub', 'plan.md');
    addPlanItem(db, {
      description: `Wrote the plan at ${absent} — task complete.`,
      state: 'passed',
    });

    const findings = findGaps({ db, currentCycle: 1 });
    const cvd = findings.filter((f) => f.kind === 'claim_vs_disk');
    expect(cvd).toHaveLength(1);
    expect(cvd[0]!.evidence).toContain(`claimed_path=${absent}`);
  });

  it('FREE-TEXT — does NOT fire on a path mention without a creation verb (tool invocation)', () => {
    // Regression: run-1 false positive. "Run node <path>" should NOT be
    // treated as a claim that the script is a produced deliverable. The
    // verb-gate distinguishes claim ("wrote X to Y") from reference
    // ("Run X" / "see Y" / "check Z").
    const db = fresh();
    const path = join(tmpRoot, 'gate.mjs');
    addPlanItem(db, {
      description: `Run node ${path} phase1-requirements until exit 0; capture the run.`,
      state: 'passed',
    });

    const findings = findGaps({ db, currentCycle: 1 });
    expect(findings.filter((f) => f.kind === 'claim_vs_disk')).toHaveLength(0);
  });

  it('FREE-TEXT — does NOT fire on a path mention with a non-creation verb', () => {
    const db = fresh();
    const path = join(tmpRoot, 'spec.md');
    addPlanItem(db, {
      description: `See ${path} for the specification details.`,
      state: 'passed',
    });
    expect(
      findGaps({ db, currentCycle: 1 }).filter((f) => f.kind === 'claim_vs_disk'),
    ).toHaveLength(0);
  });

  it('FREE-TEXT — does NOT match URLs (https://… is not a file claim)', () => {
    const db = fresh();
    addPlanItem(db, {
      description:
        'Documented at https://example.com/spec/v1.html — see linked spec.',
      state: 'passed',
    });

    const findings = findGaps({ db, currentCycle: 1 });
    expect(findings.filter((f) => f.kind === 'claim_vs_disk')).toHaveLength(0);
  });

  it('FREE-TEXT — does NOT match bare filenames with no slash (too ambiguous)', () => {
    const db = fresh();
    addPlanItem(db, {
      description:
        'Updated package.json and added README.md to the project root.',
      state: 'passed',
    });

    // No slash → not a claim. Conservatism: miss is preferred to false positive.
    const findings = findGaps({ db, currentCycle: 1 });
    expect(findings.filter((f) => f.kind === 'claim_vs_disk')).toHaveLength(0);
  });

  it('FREE-TEXT — resolves a relative path against pathRoot when provided', () => {
    const db = fresh();
    addPlanItem(db, {
      description: 'wrote the report to ./out/report.md this cycle',
      state: 'passed',
    });

    const findings = findGaps({ db, currentCycle: 1, pathRoot: tmpRoot });
    const cvd = findings.filter((f) => f.kind === 'claim_vs_disk');
    expect(cvd).toHaveLength(1);
    expect(cvd[0]!.evidence).toContain(join(tmpRoot, 'out/report.md'));
  });

  it('FREE-TEXT — relative path with NO pathRoot is SKIPPED and onSkip is called', () => {
    const db = fresh();
    addPlanItem(db, {
      description: 'wrote the report to out/report.md this cycle',
      state: 'passed',
    });

    const skips: WatchdogSkipNote[] = [];
    const findings = findGaps({
      db,
      currentCycle: 1,
      onSkip: (n) => skips.push(n),
    });
    expect(findings.filter((f) => f.kind === 'claim_vs_disk')).toHaveLength(0);
    expect(skips.some((s) => s.reason === 'relative_path_no_root')).toBe(true);
    expect(skips[0]!.detail).toContain('out/report.md');
  });

  it('SCOPE — open and deferred items are NOT considered claims', () => {
    const db = fresh();
    const absent = join(tmpRoot, 'no.md');
    addPlanItem(db, {
      description: 'claim the deliverable',
      state: 'open',
      completion_check: JSON.stringify({
        hooks: [{ name: 'file_exists', args: { path: absent } }],
      }),
    });
    addPlanItem(db, {
      description: 'parked work',
      state: 'deferred',
      completion_check: JSON.stringify({
        hooks: [{ name: 'file_exists', args: { path: absent } }],
      }),
    });

    expect(
      findGaps({ db, currentCycle: 1 }).filter((f) => f.kind === 'claim_vs_disk'),
    ).toHaveLength(0);
  });

  it('NEVER THROWS — a malformed completion_check JSON is skipped with a note', () => {
    const db = fresh();
    addPlanItem(db, {
      description: 'work item',
      state: 'passed',
      completion_check: 'this is not JSON {',
    });

    const skips: WatchdogSkipNote[] = [];
    // Should not throw even though the JSON is garbage.
    const findings = findGaps({
      db,
      currentCycle: 1,
      onSkip: (n) => skips.push(n),
    });
    expect(findings.filter((f) => f.kind === 'claim_vs_disk')).toHaveLength(0);
    expect(
      skips.some((s) => s.reason === 'malformed_completion_check'),
    ).toBe(true);
  });
});

/* ============================== gate_content_unmet ============================== */

describe('findGaps · gate_content_unmet (Step 3 Tier-2 detector)', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'gate-cu-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('fires when the gate needle is not contained in the file (literal)', () => {
    const db = fresh();
    const path = join(tmpRoot, 'spec.md');
    writeFileSync(path, '# specification\n\nbody without the marker');
    addPlanItem(db, {
      description: 'spec',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [{ name: 'content_contains', args: { path, needle: '## Approved' } }],
      }),
    });
    const findings = findGaps({ db, currentCycle: 1 });
    const f = findings.filter((x) => x.kind === 'gate_content_unmet');
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toContain(`gate_path=${path}`);
    expect(f[0]!.evidence).toContain('isRegex=false');
    expect(f[0]!.evidence).toContain('status=not_matching');
    expect(f[0]!.evidence).toContain('needle=' + encodeURIComponent('## Approved'));
  });

  it('does NOT fire when the needle is present (literal)', () => {
    const db = fresh();
    const path = join(tmpRoot, 'spec.md');
    writeFileSync(path, '# specification\n\n## Approved\n\nbody');
    addPlanItem(db, {
      description: 'spec',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [{ name: 'content_contains', args: { path, needle: '## Approved' } }],
      }),
    });
    expect(
      findGaps({ db, currentCycle: 1 }).filter((f) => f.kind === 'gate_content_unmet'),
    ).toHaveLength(0);
  });

  it('honours isRegex — fires when regex does not match', () => {
    const db = fresh();
    const path = join(tmpRoot, 'spec.md');
    writeFileSync(path, '- [ ] open\n- [ ] also open\n');
    addPlanItem(db, {
      description: 'checklist',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [
          {
            name: 'content_contains',
            args: { path, needle: '^- \\[x\\]', isRegex: true },
          },
        ],
      }),
    });
    const f = findGaps({ db, currentCycle: 1 }).filter(
      (x) => x.kind === 'gate_content_unmet',
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toContain('isRegex=true');
  });

  it('honours isRegex — does NOT fire when regex matches', () => {
    const db = fresh();
    const path = join(tmpRoot, 'spec.md');
    writeFileSync(path, '- [x] done\n');
    addPlanItem(db, {
      description: 'checklist',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [
          {
            name: 'content_contains',
            args: { path, needle: '^- \\[x\\]', isRegex: true },
          },
        ],
      }),
    });
    expect(
      findGaps({ db, currentCycle: 1 }).filter((f) => f.kind === 'gate_content_unmet'),
    ).toHaveLength(0);
  });

  it('NO-DOUBLE-EMIT — when the file is absent, only claim_vs_disk fires (not gate_content_unmet)', () => {
    const db = fresh();
    const path = join(tmpRoot, 'never.md');
    addPlanItem(db, {
      description: 'work',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [{ name: 'content_contains', args: { path, needle: 'X' } }],
      }),
    });
    const findings = findGaps({ db, currentCycle: 1 });
    expect(findings.filter((f) => f.kind === 'gate_content_unmet')).toHaveLength(0);
    expect(findings.filter((f) => f.kind === 'claim_vs_disk')).toHaveLength(1);
  });

  it('NO-DOUBLE-EMIT — when the file is empty, only claim_vs_disk fires', () => {
    const db = fresh();
    const path = join(tmpRoot, 'empty.md');
    writeFileSync(path, '');
    addPlanItem(db, {
      description: 'work',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [{ name: 'content_contains', args: { path, needle: 'X' } }],
      }),
    });
    const findings = findGaps({ db, currentCycle: 1 });
    expect(findings.filter((f) => f.kind === 'gate_content_unmet')).toHaveLength(0);
    expect(findings.filter((f) => f.kind === 'claim_vs_disk')).toHaveLength(1);
  });

  it('SCOPE — does NOT fire on open or deferred items', () => {
    const db = fresh();
    const path = join(tmpRoot, 'a.md');
    writeFileSync(path, 'no marker');
    addPlanItem(db, {
      description: 'open work',
      state: 'open',
      completion_check: JSON.stringify({
        hooks: [{ name: 'content_contains', args: { path, needle: 'MARKER' } }],
      }),
    });
    addPlanItem(db, {
      description: 'parked',
      state: 'deferred',
      completion_check: JSON.stringify({
        hooks: [{ name: 'content_contains', args: { path, needle: 'MARKER' } }],
      }),
    });
    expect(
      findGaps({ db, currentCycle: 1 }).filter((f) => f.kind === 'gate_content_unmet'),
    ).toHaveLength(0);
  });

  it('SKIP-NOTE — relative gate path with no pathRoot is SKIPPED', () => {
    const db = fresh();
    addPlanItem(db, {
      description: 'work',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [{ name: 'content_contains', args: { path: 'rel/x.md', needle: 'X' } }],
      }),
    });
    const skips: WatchdogSkipNote[] = [];
    const findings = findGaps({
      db,
      currentCycle: 1,
      onSkip: (n) => skips.push(n),
    });
    expect(findings.filter((f) => f.kind === 'gate_content_unmet')).toHaveLength(0);
    expect(skips.some((s) => s.reason === 'relative_path_no_root')).toBe(true);
  });

  it('OUT OF SCOPE — command_exits_zero on a passed item produces no Tier-2 finding', () => {
    const db = fresh();
    addPlanItem(db, {
      description: 'cmd',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [
          {
            name: 'command_exits_zero',
            args: { command: 'npm test', cwd: '/abs' },
          },
        ],
      }),
    });
    const findings = findGaps({ db, currentCycle: 1 });
    // Event-not-state — out of scope for Tier-2. No finding.
    expect(findings.filter((f) => f.kind === 'gate_content_unmet')).toHaveLength(0);
    expect(findings.filter((f) => f.kind === 'gate_minbytes_unmet')).toHaveLength(0);
  });

  it('NEVER FALSE-FAILS — a malformed regex in the gate spec is SKIPPED, not fired as failed', () => {
    const db = fresh();
    const path = join(tmpRoot, 'spec.md');
    writeFileSync(path, 'content');
    addPlanItem(db, {
      description: 'spec',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [
          {
            name: 'content_contains',
            args: { path, needle: '[invalid(', isRegex: true },
          },
        ],
      }),
    });
    // Invalid regex spec — the watchdog cannot rule, so it must NOT fire
    // a "not matching" finding. That would be the watchdog inventing a
    // verdict on a spec it can't evaluate.
    expect(
      findGaps({ db, currentCycle: 1 }).filter((f) => f.kind === 'gate_content_unmet'),
    ).toHaveLength(0);
  });
});

/* ============================== gate_minbytes_unmet ============================== */

describe('findGaps · gate_minbytes_unmet (Step 3 Tier-2 detector)', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'gate-mb-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('fires when the file is undersized', () => {
    const db = fresh();
    const path = join(tmpRoot, 'plan.md');
    writeFileSync(path, 'short'); // 5 bytes
    addPlanItem(db, {
      description: 'plan',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [{ name: 'file_exists', args: { path, minBytes: 100 } }],
      }),
    });
    const f = findGaps({ db, currentCycle: 1 }).filter(
      (x) => x.kind === 'gate_minbytes_unmet',
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toContain(`gate_path=${path}`);
    expect(f[0]!.evidence).toContain('required_bytes=100');
    expect(f[0]!.evidence).toContain('actual_bytes=5');
  });

  it('does NOT fire when the file meets minBytes', () => {
    const db = fresh();
    const path = join(tmpRoot, 'plan.md');
    writeFileSync(path, 'a'.repeat(150));
    addPlanItem(db, {
      description: 'plan',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [{ name: 'file_exists', args: { path, minBytes: 100 } }],
      }),
    });
    expect(
      findGaps({ db, currentCycle: 1 }).filter((f) => f.kind === 'gate_minbytes_unmet'),
    ).toHaveLength(0);
  });

  it('does NOT fire when minBytes is 0 / absent (no requirement to evaluate)', () => {
    const db = fresh();
    const path = join(tmpRoot, 'plan.md');
    writeFileSync(path, 'tiny');
    addPlanItem(db, {
      description: 'plan',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [{ name: 'file_exists', args: { path } }],
      }),
    });
    expect(
      findGaps({ db, currentCycle: 1 }).filter((f) => f.kind === 'gate_minbytes_unmet'),
    ).toHaveLength(0);
  });

  it('NO-DOUBLE-EMIT — when file is absent, only claim_vs_disk fires', () => {
    const db = fresh();
    const path = join(tmpRoot, 'never.md');
    addPlanItem(db, {
      description: 'work',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [{ name: 'file_exists', args: { path, minBytes: 100 } }],
      }),
    });
    const findings = findGaps({ db, currentCycle: 1 });
    expect(findings.filter((f) => f.kind === 'gate_minbytes_unmet')).toHaveLength(0);
    expect(findings.filter((f) => f.kind === 'claim_vs_disk')).toHaveLength(1);
  });

  it('NO-DOUBLE-EMIT — when file is empty, only claim_vs_disk fires', () => {
    const db = fresh();
    const path = join(tmpRoot, 'empty.md');
    writeFileSync(path, '');
    addPlanItem(db, {
      description: 'work',
      state: 'passed',
      completion_check: JSON.stringify({
        hooks: [{ name: 'file_exists', args: { path, minBytes: 100 } }],
      }),
    });
    const findings = findGaps({ db, currentCycle: 1 });
    expect(findings.filter((f) => f.kind === 'gate_minbytes_unmet')).toHaveLength(0);
    expect(findings.filter((f) => f.kind === 'claim_vs_disk')).toHaveLength(1);
  });

  it('SCOPE — open and deferred items are excluded', () => {
    const db = fresh();
    const path = join(tmpRoot, 'a.md');
    writeFileSync(path, 'x');
    addPlanItem(db, {
      description: 'work',
      state: 'open',
      completion_check: JSON.stringify({
        hooks: [{ name: 'file_exists', args: { path, minBytes: 100 } }],
      }),
    });
    expect(
      findGaps({ db, currentCycle: 1 }).filter((f) => f.kind === 'gate_minbytes_unmet'),
    ).toHaveLength(0);
  });
});

/* =============================== Tier-3 frame_order =============================== */

function freshWithJob(): Database.Database {
  const db = fresh();
  db.exec(`
    CREATE TABLE plan_job (
      id              TEXT PRIMARY KEY,
      opened_at_cycle INTEGER NOT NULL DEFAULT 0,
      opened_at_ms    INTEGER NOT NULL DEFAULT 0,
      title           TEXT NOT NULL DEFAULT 'job',
      source          TEXT NOT NULL DEFAULT 'operator',
      status          TEXT NOT NULL DEFAULT 'open',
      closed_at_cycle INTEGER,
      closed_at_ms    INTEGER,
      why             TEXT NOT NULL DEFAULT 'test',
      body            TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

function addJob(db: Database.Database, body: string, status: string = 'open'): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO plan_job (id, status, body) VALUES (?, ?, ?)`,
  ).run(id, status, body);
  return id;
}

function addPassedDeliverable(
  db: Database.Database,
  args: { jobId: string; description: string; passedAtCycle: number; ordinal?: number },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO plan_item
       (id, job_id, ordinal, description, state, completion_check, source, passed_at_cycle)
     VALUES (?, ?, ?, ?, 'passed', '{"hooks":[]}', 'operator', ?)`,
  ).run(id, args.jobId, args.ordinal ?? 0, args.description, args.passedAtCycle);
  return id;
}

describe('findOpenQuestions · frame_order (Step 4 Tier-3 detector)', () => {
  it('NUMBERED LIST — fires when produced order diverges from job body sequence', () => {
    const db = freshWithJob();
    const jobId = addJob(
      db,
      `
# Job — Build a thing

## Expected sequence
1. Requirements gathering
2. Architecture sketch
3. Implementation
4. Tests
`,
    );
    addPassedDeliverable(db, { jobId, description: 'Requirements gathering done', passedAtCycle: 1 });
    // Out of order: implementation BEFORE architecture
    addPassedDeliverable(db, { jobId, description: 'Implementation work shipped', passedAtCycle: 2 });
    addPassedDeliverable(db, { jobId, description: 'Architecture sketch produced', passedAtCycle: 3 });

    const qs = findOpenQuestions({ db });
    expect(qs).toHaveLength(1);
    expect(qs[0]!.kind).toBe('frame_order');
    expect(qs[0]!.watchdogPosition).toContain('Architecture sketch');
    expect(qs[0]!.latticePosition).toContain('Implementation');
    expect(qs[0]!.watchdogPosition).toMatch(/position 2/);
    expect(qs[0]!.noObjectReason.length).toBeGreaterThan(0);
  });

  it('NUMBERED LIST — does NOT fire when produced order matches expected', () => {
    const db = freshWithJob();
    const jobId = addJob(
      db,
      `
1. Requirements gathering
2. Architecture sketch
3. Implementation
`,
    );
    addPassedDeliverable(db, { jobId, description: 'Requirements gathered', passedAtCycle: 1 });
    addPassedDeliverable(db, { jobId, description: 'Architecture sketch finished', passedAtCycle: 2 });
    addPassedDeliverable(db, { jobId, description: 'Implementation complete', passedAtCycle: 3 });

    expect(findOpenQuestions({ db })).toHaveLength(0);
  });

  it('STEP-PREFIX — fires when Step N: format diverges from produced', () => {
    const db = freshWithJob();
    const jobId = addJob(
      db,
      `
Plan:

Step 1: Requirements gathering
Step 2: Architecture sketch
Step 3: Implementation
`,
    );
    addPassedDeliverable(db, { jobId, description: 'Requirements gathered', passedAtCycle: 1 });
    // Conservative token-overlap: produced label must share zero significant
    // tokens with expected[1] = "Architecture sketch" for a divergence to
    // surface. Use a label whose tokens are disjoint from {architecture, sketch}.
    addPassedDeliverable(db, { jobId, description: 'Implementation code began', passedAtCycle: 2 });

    const qs = findOpenQuestions({ db });
    expect(qs).toHaveLength(1);
    expect(qs[0]!.watchdogPosition).toContain('Architecture');
    expect(qs[0]!.latticePosition).toContain('Implementation');
  });

  it('ARROW CHAIN — fires when A → B → C order diverges from produced', () => {
    const db = freshWithJob();
    const jobId = addJob(
      db,
      'pipeline: requirements -> architecture -> implementation -> tests',
    );
    addPassedDeliverable(db, { jobId, description: 'requirements doc', passedAtCycle: 1 });
    addPassedDeliverable(db, { jobId, description: 'tests written first', passedAtCycle: 2 });

    const qs = findOpenQuestions({ db });
    expect(qs).toHaveLength(1);
    expect(qs[0]!.watchdogPosition).toContain('architecture');
    expect(qs[0]!.latticePosition).toContain('tests');
  });

  it('NO SEQUENCE — emits nothing when job body has no parseable ordered list', () => {
    // The actual run-1 shape: bulleted lists, prose, no numbered/Step/arrow chain
    const db = freshWithJob();
    const jobId = addJob(
      db,
      `
# Job

## Required artifacts

- Feature table
- Vulnerabilities table
- Migration plan

## Done-condition

- All phases gate-passed
- App hosted
`,
    );
    addPassedDeliverable(db, { jobId, description: 'Migration plan complete', passedAtCycle: 1 });
    addPassedDeliverable(db, { jobId, description: 'Feature table delivered', passedAtCycle: 2 });

    expect(findOpenQuestions({ db })).toHaveLength(0);
  });

  it('STRICT — numbered list with a gap (1, 2, 4) is rejected', () => {
    const db = freshWithJob();
    const jobId = addJob(
      db,
      `
1. Alpha
2. Beta
4. Delta
`,
    );
    addPassedDeliverable(db, { jobId, description: 'Beta done', passedAtCycle: 1 });
    addPassedDeliverable(db, { jobId, description: 'Alpha done', passedAtCycle: 2 });

    // Sequence parser returns [Alpha, Beta] as the longest valid run.
    // Compared to produced [Beta, Alpha], position 0 diverges.
    const qs = findOpenQuestions({ db });
    expect(qs).toHaveLength(1);
    expect(qs[0]!.watchdogPosition).toContain('Alpha');
    expect(qs[0]!.latticePosition).toContain('Beta');
  });

  it('STRICT — arrow chain with only 2 tokens does NOT count as a chain', () => {
    const db = freshWithJob();
    const jobId = addJob(db, 'flow: A -> B');
    addPassedDeliverable(db, { jobId, description: 'B done first', passedAtCycle: 1 });
    addPassedDeliverable(db, { jobId, description: 'A done second', passedAtCycle: 2 });

    expect(findOpenQuestions({ db })).toHaveLength(0);
  });

  it('NO LENGTH SURFACES — produced shorter than expected → no finding', () => {
    const db = freshWithJob();
    const jobId = addJob(
      db,
      `
1. Requirements
2. Architecture
3. Implementation
4. Tests
`,
    );
    addPassedDeliverable(db, { jobId, description: 'Requirements done', passedAtCycle: 1 });
    addPassedDeliverable(db, { jobId, description: 'Architecture done', passedAtCycle: 2 });

    // Produced is shorter than expected; both match as far as produced goes.
    // Incomplete progress is NOT a divergence.
    expect(findOpenQuestions({ db })).toHaveLength(0);
  });

  it('NO LENGTH SURFACES — produced longer than expected (additions) → no finding', () => {
    const db = freshWithJob();
    const jobId = addJob(db, '1. Alpha\n2. Beta');
    addPassedDeliverable(db, { jobId, description: 'Alpha done', passedAtCycle: 1 });
    addPassedDeliverable(db, { jobId, description: 'Beta done', passedAtCycle: 2 });
    addPassedDeliverable(db, { jobId, description: 'Extra delivery beyond spec', passedAtCycle: 3 });

    expect(findOpenQuestions({ db })).toHaveLength(0);
  });

  it('TOKEN-OVERLAP — shares ≥1 significant token → no surface (under-fires by design)', () => {
    const db = freshWithJob();
    const jobId = addJob(db, '1. Architecture document\n2. Implementation code');
    // Produced labels differ in surface form but share a topic word with expected.
    addPassedDeliverable(db, { jobId, description: 'Wrote the architecture sketch', passedAtCycle: 1 });
    addPassedDeliverable(db, { jobId, description: 'Started implementation', passedAtCycle: 2 });

    expect(findOpenQuestions({ db })).toHaveLength(0);
  });

  it('EXCLUDES plan_step items from the produced sequence', () => {
    const db = freshWithJob();
    const jobId = addJob(db, '1. Alpha\n2. Beta');
    // plan_step items are administrative scaffolding, not deliverables.
    db.prepare(
      `INSERT INTO plan_item
        (id, job_id, ordinal, description, state, completion_check, source, passed_at_cycle)
       VALUES (?, ?, 0, 'Step 1 — draft checklist', 'passed',
               '{"hooks":[{"name":"step_acknowledged","args":{}}]}', 'plan_step', 1)`,
    ).run(randomUUID(), jobId);
    addPassedDeliverable(db, { jobId, description: 'Beta done', passedAtCycle: 2 });
    addPassedDeliverable(db, { jobId, description: 'Alpha done', passedAtCycle: 3 });

    // produced sequence (excluding plan_step) = [Beta, Alpha]
    // expected = [Alpha, Beta]
    // First divergence at position 0.
    const qs = findOpenQuestions({ db });
    expect(qs).toHaveLength(1);
    expect(qs[0]!.watchdogPosition).toContain('Alpha');
    expect(qs[0]!.latticePosition).toContain('Beta');
  });

  it('EXCLUDES non-open jobs — only active jobs are evaluated', () => {
    const db = freshWithJob();
    const jobId = addJob(db, '1. Alpha\n2. Beta', 'closed_full');
    addPassedDeliverable(db, { jobId, description: 'Beta done', passedAtCycle: 1 });
    addPassedDeliverable(db, { jobId, description: 'Alpha done', passedAtCycle: 2 });

    expect(findOpenQuestions({ db })).toHaveLength(0);
  });
});
