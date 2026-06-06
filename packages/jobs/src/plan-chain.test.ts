import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { default as DatabaseCtor } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parsePlanSteps } from './plan-chain.js';
import { planItemGateSpec, planRelPath } from './plan-gate.js';
import { JobsService } from './service.js';

const Database = DatabaseCtor;

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

describe('parsePlanSteps (Item 5)', () => {
  it('parses checkbox lines and ignores non-checkbox text', () => {
    const steps = parsePlanSteps('# Heading\nintro prose\n- [ ] first\n- [x] second\nmore prose');
    expect(steps.map((s) => s.description)).toEqual(['first', 'second']);
    expect(steps.every((s) => s.gate === null)).toBe(true);
  });

  it('parses an inline gate with numeric coercion', () => {
    const [step] = parsePlanSteps('- [ ] build it {{gate:file_exists path=out/x.ts, minBytes=50}}');
    expect(step!.description).toBe('build it');
    expect(step!.gate).toEqual({ name: 'file_exists', args: { path: 'out/x.ts', minBytes: 50 } });
  });

  it('keeps spaces inside a comma-delimited arg value', () => {
    const [step] = parsePlanSteps('- [ ] tests pass {{gate:command_exits_zero command=npm test, cwd=.}}');
    expect(step!.gate).toEqual({ name: 'command_exits_zero', args: { command: 'npm test', cwd: '.' } });
  });

  it('parses manual_review with no args', () => {
    const [step] = parsePlanSteps('- [ ] design review {{gate:manual_review}}');
    expect(step!.gate).toEqual({ name: 'manual_review', args: {} });
  });
});

describe('onPlanFileReady chaining + ordering (Item 5)', () => {
  let dir: string;
  let jobs: JobsService;
  let jobId: string;
  let planPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plan-chain-'));
    jobs = new JobsService(freshDb());
    const job = jobs.openJob({ title: 't', source: 'operator', why: 'because', cycle: 1, at_ms: 1 });
    jobId = job.id;
    planPath = join(dir, planRelPath(jobId)); // <dir>/.ai/notes/plans/<jobId>.md
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function addPlanGate() {
    return jobs.addItem(jobId, {
      description: 'Draft checklist plan',
      spec: planItemGateSpec(planPath),
      source: 'system',
    });
  }

  function writePlan(body: string) {
    mkdirSync(dirname(planPath), { recursive: true });
    // pad past the 500-byte gate minimum
    writeFileSync(planPath, body + '\n' + 'x'.repeat(600));
  }

  it('chains one ordered plan_step per checkbox when the gate passes', async () => {
    const gate = addPlanGate();
    writePlan('- [ ] step one {{gate:file_exists path=out/one.txt}}\n- [ ] step two {{gate:file_exists path=out/two.txt}}\n- [ ] step three');

    const r = await jobs.attemptCheck(gate.id, { cycle: 2 });
    expect(r.outcome).toBe('passed');

    const steps = jobs.checklist.items(jobId).filter((i) => i.source === 'plan_step');
    expect(steps).toHaveLength(3);
    // chained: 1 unblocked, 2 blocked by 1, 3 blocked by 2
    expect(steps[0]!.blocked_by).toBeNull();
    expect(steps[1]!.blocked_by).toBe(steps[0]!.id);
    expect(steps[2]!.blocked_by).toBe(steps[1]!.id);
    // the no-gate step got a marker fallback
    expect(steps[2]!.description).toContain('create marker');
  });

  it('enforces order — a later step is blocked until the earlier one passes', async () => {
    const gate = addPlanGate();
    writePlan('- [ ] step one {{gate:file_exists path=out/one.txt}}\n- [ ] step two {{gate:file_exists path=out/two.txt}}');
    await jobs.attemptCheck(gate.id, { cycle: 2 });
    const [s1, s2] = jobs.checklist.items(jobId).filter((i) => i.source === 'plan_step');

    // step two is blocked while step one is open
    expect((await jobs.attemptCheck(s2!.id, { cycle: 3 })).outcome).toBe('blocked');

    // satisfy step one's deliverable → it passes
    mkdirSync(join(dir, 'out'), { recursive: true });
    writeFileSync(join(dir, 'out', 'one.txt'), 'done');
    expect((await jobs.attemptCheck(s1!.id, { cycle: 4 })).outcome).toBe('passed');

    // step two is now unblocked but its own deliverable is missing → fails (not blocked)
    expect((await jobs.attemptCheck(s2!.id, { cycle: 5 })).outcome).toBe('failed_iterating');

    // satisfy step two → passes
    writeFileSync(join(dir, 'out', 'two.txt'), 'done');
    expect((await jobs.attemptCheck(s2!.id, { cycle: 6 })).outcome).toBe('passed');
  });

  it('is idempotent — passing the gate again does not re-chain', async () => {
    const gate = addPlanGate();
    writePlan('- [ ] only step {{gate:file_exists path=out/x.txt}}');
    await jobs.attemptCheck(gate.id, { cycle: 2 });
    await jobs.attemptCheck(gate.id, { cycle: 3 });
    expect(jobs.checklist.items(jobId).filter((i) => i.source === 'plan_step')).toHaveLength(1);
  });

  it('resolves relative gate paths under the workspace root', async () => {
    const gate = addPlanGate();
    writePlan('- [ ] make it {{gate:file_exists path=out/deliver.txt}}');
    await jobs.attemptCheck(gate.id, { cycle: 2 });
    const [step] = jobs.checklist.items(jobId).filter((i) => i.source === 'plan_step');
    const spec = JSON.parse(step!.completion_check) as { hooks: Array<{ args?: { path?: string } }> };
    expect(spec.hooks[0]!.args!.path).toBe(join(dir, 'out', 'deliver.txt'));
  });
});
