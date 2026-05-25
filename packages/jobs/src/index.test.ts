import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import { Checklist, PassByAssertionError } from './checklist.js';
import { builtinRegistry, serializeSpec } from './completion-check.js';
import { validateDeferral } from './deferral.js';
import { JobsService } from './service.js';
import type { CompletionCheckSpec, UnblockTestSpec } from './types.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE plan_job (
      id TEXT PRIMARY KEY, opened_at_cycle INTEGER NOT NULL, opened_at_ms INTEGER NOT NULL,
      title TEXT NOT NULL, source TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','closed_full','closed_partial')),
      closed_at_cycle INTEGER, closed_at_ms INTEGER, why TEXT NOT NULL
    );
    CREATE TABLE plan_item (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES plan_job(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, description TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open','passed','deferred')),
      iteration_count INTEGER NOT NULL DEFAULT 0,
      completion_check TEXT NOT NULL,
      passed_at_cycle INTEGER, deferred_at_cycle INTEGER,
      defer_reason TEXT, unblock_condition TEXT, unblock_test TEXT
    );
  `);
  return db;
}

function spec(hookName: string, args: Record<string, unknown> = {}): CompletionCheckSpec {
  return { hooks: [{ name: hookName, args }] };
}

/* ============================== T178 ============================== */

describe('Checklist — pass-by-assertion is rejected (T178 / FR-034)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('directly calling markPassed without the assertedCheckRun flag throws', () => {
    const c = new Checklist(db);
    const job = c.openJob({
      title: 't', source: 'test', why: 'because', cycle: 1, at_ms: 1,
    });
    const item = c.addItem(job.id, { description: 'i', completion_check: '{"hooks":[]}' });
    expect(() => c.markPassed(item.id, 1, false)).toThrow(PassByAssertionError);
  });

  it('JobsService.markPassed always throws — only attemptCheck/recordJudgement may pass', () => {
    const svc = new JobsService(freshDb());
    const job = svc.openJob({ title: 't', source: 'test', why: 'y', cycle: 1, at_ms: 1 });
    const item = svc.addItem(job.id, { description: 'i', spec: spec('always_pass') });
    expect(() => svc.markPassed(item.id)).toThrow(PassByAssertionError);
  });

  it('a job opens with status=open and items default to state=open', () => {
    const svc = new JobsService(freshDb());
    const job = svc.openJob({ title: 't', source: 'test', why: 'y', cycle: 1, at_ms: 1 });
    expect(job.status).toBe('open');
    const item = svc.addItem(job.id, { description: 'i', spec: spec('always_pass') });
    expect(item.state).toBe('open');
    expect(item.iteration_count).toBe(0);
  });
});

/* ============================== T179 + T183a ============================== */

describe('Iteration & cap (T179 / T183a / FR-035 / analyze C4)', () => {
  it('failing check increments iteration_count; item stays open', () => {
    const svc = new JobsService(freshDb());
    const job = svc.openJob({ title: 't', source: 's', why: 'y', cycle: 1, at_ms: 1 });
    const item = svc.addItem(job.id, { description: 'i', spec: spec('always_fail') });
    const r = svc.attemptCheck(item.id, { cycle: 1 });
    expect(r.outcome).toBe('failed_iterating');
    expect(r.item.iteration_count).toBe(1);
    expect(r.item.state).toBe('open');
  });

  it('a passing hook marks the item passed', () => {
    const svc = new JobsService(freshDb());
    const job = svc.openJob({ title: 't', source: 's', why: 'y', cycle: 1, at_ms: 1 });
    const item = svc.addItem(job.id, { description: 'i', spec: spec('always_pass') });
    const r = svc.attemptCheck(item.id, { cycle: 1 });
    expect(r.outcome).toBe('passed');
    expect(r.item.state).toBe('passed');
    expect(r.item.passed_at_cycle).toBe(1);
  });

  it('after iteration_cap failures, attemptCheck returns iteration_cap_exceeded', () => {
    const svc = new JobsService(freshDb());
    const job = svc.openJob({ title: 't', source: 's', why: 'y', cycle: 1, at_ms: 1 });
    // Use a tight cap=2.
    const checkSpec: CompletionCheckSpec = { hooks: [{ name: 'always_fail' }], iterationCap: 2 };
    const item = svc.addItem(job.id, {
      description: 'i',
      spec: checkSpec,
    });
    svc.attemptCheck(item.id, { cycle: 1 });
    svc.attemptCheck(item.id, { cycle: 2 });
    const r3 = svc.attemptCheck(item.id, { cycle: 3 });
    expect(r3.outcome).toBe('iteration_cap_exceeded');
  });

  it('judgement_required is returned when all hooks pass AND a judgement spec exists', () => {
    const svc = new JobsService(freshDb());
    const job = svc.openJob({ title: 't', source: 's', why: 'y', cycle: 1, at_ms: 1 });
    const checkSpec: CompletionCheckSpec = {
      hooks: [{ name: 'always_pass' }],
      judgement: { criterion: 'is the spec coherent?' },
    };
    const item = svc.addItem(job.id, { description: 'i', spec: checkSpec });
    const r = svc.attemptCheck(item.id, { cycle: 1 });
    expect(r.outcome).toBe('judgement_required');
    expect(r.criterion).toBe('is the spec coherent?');
    // Item is still open until recordJudgement is called.
    expect(svc.checklist.getItem(item.id)?.state).toBe('open');
  });

  it('recordJudgement(passed=true) marks the item passed', () => {
    const svc = new JobsService(freshDb());
    const job = svc.openJob({ title: 't', source: 's', why: 'y', cycle: 1, at_ms: 1 });
    const item = svc.addItem(job.id, {
      description: 'i',
      spec: { hooks: [{ name: 'always_pass' }], judgement: { criterion: 'x' } },
    });
    svc.attemptCheck(item.id, { cycle: 1 });
    svc.recordJudgement(item.id, { passed: true }, 1);
    expect(svc.checklist.getItem(item.id)?.state).toBe('passed');
  });
});

/* ============================== T180 ============================== */

describe('Deferral validation (T180 / FR-036)', () => {
  it('rejects "this was hard"', () => {
    const r = validateDeferral({
      itemId: 'x',
      reason: 'this was hard for me',
      unblockCondition: 'something',
      unblockTest: '{}',
    });
    expect(r.admit).toBe(false);
  });

  it('rejects "I judged it unnecessary"', () => {
    const r = validateDeferral({
      itemId: 'x',
      reason: 'I judged it unnecessary',
      unblockCondition: 'x',
      unblockTest: '{}',
    });
    expect(r.admit).toBe(false);
  });

  it('accepts an externally-grounded reason with hint + condition + test', () => {
    const r = validateDeferral({
      itemId: 'x',
      reason: 'waiting on stakeholder X to provide the budget figure',
      unblockCondition: 'budget figure provided',
      unblockTest: JSON.stringify({ kind: 'sense_data_contains', sense: 'inbox', needle: 'budget' }),
    });
    expect(r.admit).toBe(true);
  });

  it('rejects empty reason / condition / test', () => {
    expect(
      validateDeferral({ itemId: 'x', reason: '', unblockCondition: 'a', unblockTest: '{}' }).admit,
    ).toBe(false);
    expect(
      validateDeferral({ itemId: 'x', reason: 'a real long enough reason text', unblockCondition: '', unblockTest: '{}' }).admit,
    ).toBe(false);
    expect(
      validateDeferral({ itemId: 'x', reason: 'a real long enough reason text', unblockCondition: 'a', unblockTest: '' }).admit,
    ).toBe(false);
  });
});

/* ============================== T181 ============================== */

describe('Partial close (T181 / FR-037)', () => {
  it('3 passed + 1 deferred → closed_partial; deferred items persist', () => {
    const svc = new JobsService(freshDb());
    const job = svc.openJob({ title: 'compose plan', source: 'op', why: 'because', cycle: 1, at_ms: 1 });
    const items = [
      svc.addItem(job.id, { description: 'a', spec: spec('always_pass') }),
      svc.addItem(job.id, { description: 'b', spec: spec('always_pass') }),
      svc.addItem(job.id, { description: 'c', spec: spec('always_pass') }),
      svc.addItem(job.id, { description: 'd', spec: spec('always_fail') }),
    ];
    // Pass three.
    for (const i of items.slice(0, 3)) svc.attemptCheck(i.id, { cycle: 1 });
    // Defer the fourth with a valid reason.
    const deferred = svc.defer(
      {
        itemId: items[3]!.id,
        reason: 'waiting for stakeholder to clarify the requirement',
        unblockCondition: 'requirement clarified',
        unblockTest: JSON.stringify({ kind: 'sense_present', sense: 'inbox' }),
      },
      { cycle: 1 },
    );
    expect(deferred.admit).toBe(true);

    const r = svc.close({ jobId: job.id, cycle: 2, at_ms: 2, autonomy: 'high' });
    expect(r.result).toBe('closed');
    if (r.result === 'closed') {
      expect(r.mode).toBe('partial');
      expect(r.job.status).toBe('closed_partial');
    }

    // Deferred item is still in the DB.
    const stillDeferred = svc.checklist.getItem(items[3]!.id)!;
    expect(stillDeferred.state).toBe('deferred');
    expect(stillDeferred.defer_reason).toMatch(/stakeholder/);
  });

  it('a job with open items cannot close', () => {
    const svc = new JobsService(freshDb());
    const job = svc.openJob({ title: 't', source: 's', why: 'y', cycle: 1, at_ms: 1 });
    svc.addItem(job.id, { description: 'a', spec: spec('always_pass') });
    const r = svc.close({ jobId: job.id, cycle: 2, at_ms: 2, autonomy: 'high' });
    expect(r.result).toBe('not_ready');
  });
});

/* ============================== T182 ============================== */

describe('Unblock flow (T182 / FR-038)', () => {
  it('deferred item with sense_data_contains test becomes unblockable when sense data matches', () => {
    const svc = new JobsService(freshDb());
    const job = svc.openJob({ title: 't', source: 's', why: 'y', cycle: 1, at_ms: 1 });
    const item = svc.addItem(job.id, { description: 'a', spec: spec('always_pass') });
    const test: UnblockTestSpec = {
      kind: 'sense_data_contains',
      sense: 'inbox',
      needle: 'budget figure',
    };
    svc.defer(
      {
        itemId: item.id,
        reason: 'waiting on stakeholder for the budget figure',
        unblockCondition: 'budget figure arrived in inbox',
        unblockTest: JSON.stringify(test),
      },
      { cycle: 1 },
    );

    // Perception with NO matching data → not unblocked
    const r1 = svc.detectUnblocked({
      cycle: 2,
      senses: { inbox: { result: 'ok', data: 'hello world' } },
    });
    expect(r1).toHaveLength(0);

    // Perception WITH matching data → unblocked
    const r2 = svc.detectUnblocked({
      cycle: 2,
      senses: { inbox: { result: 'ok', data: 'final budget figure is 100k' } },
    });
    expect(r2).toHaveLength(1);
    expect(r2[0]?.item.id).toBe(item.id);

    // The item is still 'deferred' until the caller explicitly unblocks it.
    expect(svc.checklist.getItem(item.id)?.state).toBe('deferred');
    svc.unblockItem(item.id);
    expect(svc.checklist.getItem(item.id)?.state).toBe('open');
  });

  it('cycle_after test fires when perception.cycle exceeds the threshold', () => {
    const svc = new JobsService(freshDb());
    const job = svc.openJob({ title: 't', source: 's', why: 'y', cycle: 1, at_ms: 1 });
    const item = svc.addItem(job.id, { description: 'a', spec: spec('always_pass') });
    svc.defer(
      {
        itemId: item.id,
        reason: 'waiting for a few cycles to elapse',
        unblockCondition: 'cycle > 5',
        unblockTest: JSON.stringify({ kind: 'cycle_after', cycle: 5 }),
      },
      { cycle: 1 },
    );
    expect(svc.detectUnblocked({ cycle: 3, senses: {} })).toHaveLength(0);
    expect(svc.detectUnblocked({ cycle: 6, senses: {} })).toHaveLength(1);
  });
});

/* ============================== T183 ============================== */

describe('Autonomy-gated sign-off (T183 / FR-039)', () => {
  it('autonomy=high closes the job immediately', () => {
    const svc = new JobsService(freshDb());
    const job = svc.openJob({ title: 't', source: 's', why: 'y', cycle: 1, at_ms: 1 });
    const item = svc.addItem(job.id, { description: 'a', spec: spec('always_pass') });
    svc.attemptCheck(item.id, { cycle: 1 });
    const r = svc.close({ jobId: job.id, cycle: 2, at_ms: 2, autonomy: 'high' });
    expect(r.result).toBe('closed');
  });

  it('autonomy=low without operatorApproved returns pending_operator', () => {
    const svc = new JobsService(freshDb());
    const job = svc.openJob({ title: 't', source: 's', why: 'y', cycle: 1, at_ms: 1 });
    const item = svc.addItem(job.id, { description: 'a', spec: spec('always_pass') });
    svc.attemptCheck(item.id, { cycle: 1 });
    const r = svc.close({ jobId: job.id, cycle: 2, at_ms: 2, autonomy: 'low' });
    expect(r.result).toBe('pending_operator');
  });

  it('autonomy=low with operatorApproved closes', () => {
    const svc = new JobsService(freshDb());
    const job = svc.openJob({ title: 't', source: 's', why: 'y', cycle: 1, at_ms: 1 });
    const item = svc.addItem(job.id, { description: 'a', spec: spec('always_pass') });
    svc.attemptCheck(item.id, { cycle: 1 });
    const r = svc.close({
      jobId: job.id,
      cycle: 2,
      at_ms: 2,
      autonomy: 'low',
      operatorApproved: true,
    });
    expect(r.result).toBe('closed');
  });
});

describe('built-in registry has expected hooks', () => {
  it('always_pass / always_fail / description_contains', () => {
    const r = builtinRegistry();
    expect(r.get('always_pass')).toBeDefined();
    expect(r.get('always_fail')).toBeDefined();
    expect(r.get('description_contains')).toBeDefined();
  });
});

describe('completion-check serialization round-trip', () => {
  it('serializeSpec → parseSpec preserves the structure', () => {
    const spec: CompletionCheckSpec = {
      hooks: [{ name: 'always_pass' }, { name: 'description_contains', args: { needle: 'x' } }],
      judgement: { criterion: 'fits user intent' },
      iterationCap: 7,
    };
    const s = serializeSpec(spec);
    const back = JSON.parse(s) as CompletionCheckSpec;
    expect(back.hooks).toHaveLength(2);
    expect(back.judgement?.criterion).toBe('fits user intent');
    expect(back.iterationCap).toBe(7);
  });
});
