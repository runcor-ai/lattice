import { default as DatabaseCtor } from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import type { Db } from './db.js';
import {
  NO_PROGRESS_ESCALATE,
  NO_PROGRESS_THRESHOLD,
  awaitingOperator,
  clearHeldSignals,
  dominantRecentAction,
  openJobItemSignature,
  recordProgress,
} from './no-progress.js';
import { JobsService } from '@runcor/jobs';

import { migrate } from './migrations.js';
import { act } from './phases/act.js';
import type { CycleContext, DecideOutput } from './types.js';

const Database = DatabaseCtor;

function progressDb(): Db {
  const db = new Database(':memory:') as unknown as Db;
  db.exec(`
    CREATE TABLE plan_job (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE plan_item (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE progress_state (id TEXT PRIMARY KEY, no_progress_cycles INTEGER NOT NULL DEFAULT 0, last_signature TEXT NOT NULL DEFAULT '');
    CREATE TABLE recent_action (cycle INTEGER NOT NULL, action_name TEXT NOT NULL, input_hash TEXT NOT NULL);
  `);
  return db;
}

describe('no-progress signature + counter (Item 15)', () => {
  it('signature is empty with no open jobs, non-empty with open items', () => {
    const db = progressDb();
    expect(openJobItemSignature(db)).toBe('');
    db.prepare("INSERT INTO plan_job VALUES ('j','open')").run();
    db.prepare("INSERT INTO plan_item VALUES ('i1','j','open')").run();
    expect(openJobItemSignature(db)).not.toBe('');
  });

  it('counter climbs while item state is unchanged, resets when an item moves', () => {
    const db = progressDb();
    db.prepare("INSERT INTO plan_job VALUES ('j','open')").run();
    db.prepare("INSERT INTO plan_item VALUES ('i1','j','open')").run();
    expect(recordProgress(db)).toBe(0);
    expect(recordProgress(db)).toBe(1);
    expect(recordProgress(db)).toBe(2);
    db.prepare("UPDATE plan_item SET state='passed' WHERE id='i1'").run();
    expect(recordProgress(db)).toBe(0); // an item moved → progress
    expect(recordProgress(db)).toBe(1);
  });

  it('re-writing the plan (no item moves) does NOT count as progress', () => {
    const db = progressDb();
    db.prepare("INSERT INTO plan_job VALUES ('j','open')").run();
    db.prepare("INSERT INTO plan_item VALUES ('i1','j','open')").run();
    recordProgress(db); // 0
    expect(recordProgress(db)).toBe(1);
    expect(recordProgress(db)).toBe(2);
    expect(recordProgress(db)).toBe(3); // keeps climbing toward the threshold
  });

  it('Finding #7: appending checklist items does NOT reset; only a closure does', () => {
    const db = progressDb();
    db.prepare("INSERT INTO plan_job VALUES ('j','open')").run();
    db.prepare("INSERT INTO plan_item VALUES ('i1','j','open')").run();
    recordProgress(db); // 0
    expect(recordProgress(db)).toBe(1);
    db.prepare("INSERT INTO plan_item VALUES ('i2','j','open')").run(); // entity grows its own checklist
    expect(recordProgress(db)).toBe(2); // append is not progress — keeps climbing (was the bug)
    db.prepare("INSERT INTO plan_item VALUES ('i3','j','open')").run();
    expect(recordProgress(db)).toBe(3);
    db.prepare("UPDATE plan_item SET state='passed' WHERE id='i2'").run(); // a real closure
    expect(recordProgress(db)).toBe(0); // resets cleanly on genuine progress
    expect(recordProgress(db)).toBe(1); // and climbs again after
  });

  it('Finding #7: deferring/blocking an item is being stuck, not progress', () => {
    const db = progressDb();
    db.prepare("INSERT INTO plan_job VALUES ('j','open')").run();
    db.prepare("INSERT INTO plan_item VALUES ('i1','j','open')").run();
    recordProgress(db); // 0
    expect(recordProgress(db)).toBe(1);
    db.prepare("UPDATE plan_item SET state='deferred' WHERE id='i1'").run();
    expect(recordProgress(db)).toBe(2); // deferred is not a closure — still climbing
  });

  it('a new open job (open-job set changed) counts as progress', () => {
    const db = progressDb();
    db.prepare("INSERT INTO plan_job VALUES ('j1','open')").run();
    db.prepare("INSERT INTO plan_item VALUES ('i1','j1','open')").run();
    recordProgress(db); // 0
    expect(recordProgress(db)).toBe(1);
    db.prepare("INSERT INTO plan_job VALUES ('j2','open')").run(); // a second job opens
    expect(recordProgress(db)).toBe(0); // open-job set changed → progress
  });

  it('no open jobs resets the counter', () => {
    const db = progressDb();
    db.prepare("INSERT INTO plan_job VALUES ('j','open')").run();
    db.prepare("INSERT INTO plan_item VALUES ('i1','j','open')").run();
    recordProgress(db); recordProgress(db);
    db.prepare("UPDATE plan_job SET status='closed_full' WHERE id='j'").run();
    expect(recordProgress(db)).toBe(0);
  });

  it('dominantRecentAction returns the most frequent', () => {
    const db = progressDb();
    for (let i = 0; i < 5; i++) db.prepare('INSERT INTO recent_action VALUES (?,?,?)').run(i, 'workspace', 'h' + i);
    db.prepare("INSERT INTO recent_action VALUES (9,'read','h9')").run();
    expect(dominantRecentAction(db)).toBe('workspace');
  });
});

/* ---- act-phase enforcement ---- */

const probe = {
  name: 'probe',
  description: 'p',
  role: { sense: false, action: true },
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  isEnabled: () => true,
  canInvoke: () => ({ allow: true }),
  invoke: async () => ({ ok: true }),
};
const other = { ...probe, name: 'other' };

function makeCtx(db: Db, traces: Array<Record<string, unknown>>): CycleContext {
  return {
    cycle: 1,
    at_ms: 1,
    abortSignal: new AbortController().signal,
    autonomy: 'medium',
    actions: [probe, other],
    memory: { dbHandle: () => db },
    trace: { write: (e: Record<string, unknown>) => traces.push(e) },
  } as unknown as CycleContext;
}
function prevWith(action: string): DecideOutput {
  return { chosenAction: action, chosenInput: {} } as unknown as DecideOutput;
}
function stalledDb(cycles: number): Db {
  const db = progressDb();
  db.prepare("INSERT INTO progress_state VALUES ('self',?,'sig')").run(cycles);
  for (let i = 0; i < 5; i++) db.prepare('INSERT INTO recent_action VALUES (?,?,?)').run(i, 'probe', 'h' + i);
  return db;
}

describe('act phase enforces no-progress (Item 15)', () => {
  it('blocks the dominant action once stalled >= threshold', async () => {
    const db = stalledDb(NO_PROGRESS_THRESHOLD);
    const traces: Array<Record<string, unknown>> = [];
    const r = await act(makeCtx(db, traces), prevWith('probe'));
    expect(r.actResult).toBe('failed');
    expect(r.actFailedReason).toMatch(/No-progress/);
    expect(traces.some((t) => t.kind === 'substrate' && t.law === 'no-progress' && t.outcome === 'block')).toBe(true);
  });

  it('does NOT block a different (non-dominant) action — lets the lattice escape', async () => {
    const db = stalledDb(NO_PROGRESS_THRESHOLD);
    const r = await act(makeCtx(db, []), prevWith('other'));
    expect(r.actResult).toBe('ok');
  });

  it('does not block below threshold', async () => {
    const db = stalledDb(NO_PROGRESS_THRESHOLD - 1);
    const r = await act(makeCtx(db, []), prevWith('probe'));
    expect(r.actResult).toBe('ok');
  });

  it('also escalates at 2N', async () => {
    const db = stalledDb(NO_PROGRESS_ESCALATE);
    const traces: Array<Record<string, unknown>> = [];
    await act(makeCtx(db, traces), prevWith('probe'));
    expect(traces.some((t) => t.law === 'no-progress' && t.outcome === 'escalate')).toBe(true);
  });

  it('gap E: at ESCALATE the open job item is auto-DEFERRED (circuit-breaker parks instead of nudging)', async () => {
    const db = new Database(':memory:') as unknown as Db;
    migrate(db);
    const jobs = new JobsService(db);
    const job = jobs.openJob({ title: 'stuck', source: 'test', why: 'reproduce a stall', cycle: 1, at_ms: 1 });
    const item = jobs.addItem(job.id, {
      description: 'a deliverable that can never pass its gate',
      spec: { hooks: [{ name: 'file_exists', args: { path: 'Z:/never/exists.md' } }] },
    });
    // a sustained stall: the no-progress counter has reached the escalation threshold
    db.prepare("INSERT INTO progress_state (id, no_progress_cycles, last_signature) VALUES ('self', ?, 'p0:j1')").run(
      NO_PROGRESS_ESCALATE,
    );
    db.prepare('INSERT INTO recent_action VALUES (1,?,?)').run('probe', 'h1');

    const traces: Array<Record<string, unknown>> = [];
    const r = await act(makeCtx(db, traces), prevWith('probe'));

    expect(r.actResult).toBe('failed');
    expect(r.actFailedReason).toMatch(/circuit-breaker/);
    expect(traces.some((t) => t.law === 'no-progress' && t.outcome === 'escalate')).toBe(true);
    // the teeth: the open item is now DEFERRED (parked), not left open to spin on
    expect(jobs.checklist.getItem(item.id)?.state).toBe('deferred');
  });

  it('read-cap (#16): a re-read of an already-held signal is blocked (catches near-repeats persistence misses); new signal allowed; commit resets', async () => {
    const db = new Database(':memory:') as unknown as Db;
    migrate(db);
    const traces: Array<Record<string, unknown>> = [];
    const ctx = makeCtx(db, traces); // actions [probe, other], both readOnly:true
    // NOTE: vary a NON-path input (maxBytes) so inputHash differs each call — this defeats
    // the Persistence law, isolating the read-cap (which keys on action|path).
    const read = (p: string, n: number) => ({ chosenAction: 'probe', chosenInput: { path: p, maxBytes: n } }) as unknown as DecideOutput;

    expect((await act(ctx, read('signal/a.md', 1000))).actResult).toBe('ok'); // first read — recorded
    const r = await act(ctx, read('signal/a.md', 2000)); // near-repeat (diff maxBytes) — persistence misses, read-cap catches
    expect(r.actResult).toBe('failed');
    expect(r.actFailedReason).toMatch(/Read-cap/);
    expect(traces.some((t) => t.law === 'read-cap' && t.outcome === 'block')).toBe(true);
    expect((await act(ctx, read('signal/b.md', 1000))).actResult).toBe('ok'); // genuinely NEW signal — allowed
    clearHeldSignals(db); // a genuine commit (item close) frees the cap
    expect((await act(ctx, read('signal/a.md', 3000))).actResult).toBe('ok'); // re-read allowed again after commit
  });
});

/* ---- Finding 1: awaiting-operator rest state ---- */

function sourceDb(): Db {
  const db = new Database(':memory:') as unknown as Db;
  db.exec(`
    CREATE TABLE plan_job (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE plan_item (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, state TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'operator');
    CREATE TABLE progress_state (id TEXT PRIMARY KEY, no_progress_cycles INTEGER NOT NULL DEFAULT 0, last_signature TEXT NOT NULL DEFAULT '');
    CREATE TABLE recent_action (cycle INTEGER NOT NULL, action_name TEXT NOT NULL, input_hash TEXT NOT NULL);
  `);
  return db;
}

describe('awaitingOperator predicate (halt rest state)', () => {
  it('false when nothing open; true only when EVERY open item is source=operator', () => {
    const db = sourceDb();
    expect(awaitingOperator(db)).toBe(false); // no jobs/items
    db.prepare("INSERT INTO plan_job VALUES ('j','open')").run();
    db.prepare("INSERT INTO plan_item VALUES ('op','j','open','operator')").run();
    expect(awaitingOperator(db)).toBe(true); // only an operator item open
    db.prepare("INSERT INTO plan_item VALUES ('w','j','open','plan_step')").run();
    expect(awaitingOperator(db)).toBe(false); // a non-operator item is open → NOT resting (genuine stall guarded)
    db.prepare("UPDATE plan_item SET state='passed' WHERE id='w'").run();
    expect(awaitingOperator(db)).toBe(true); // back to only operator open
    db.prepare("UPDATE plan_job SET status='closed_full' WHERE id='j'").run();
    expect(awaitingOperator(db)).toBe(false); // job closed → nothing open
  });

  it('recordProgress stays 0 across >= THRESHOLD cycles while awaiting operator; re-arms once real work opens', () => {
    const db = sourceDb();
    db.prepare("INSERT INTO plan_job VALUES ('j','open')").run();
    db.prepare("INSERT INTO plan_item VALUES ('op','j','open','operator')").run();
    for (let i = 0; i < NO_PROGRESS_THRESHOLD + 3; i += 1) {
      expect(recordProgress(db)).toBe(0); // resting → never climbs (breaker can't fire)
    }
    db.prepare("INSERT INTO plan_item VALUES ('w','j','open','plan_step')").run(); // real work appears → no longer resting
    expect(recordProgress(db)).toBe(1); // counter climbs again — breaker re-armed
    expect(recordProgress(db)).toBe(2);
  });
});

describe('act phase: resting is exempt from ALL no-progress consequences', () => {
  function restingDb(noProgress: number): Db {
    const db = new Database(':memory:') as unknown as Db;
    migrate(db);
    const jobs = new JobsService(db);
    const job = jobs.openJob({ title: 'done', source: 'operator', why: 'awaiting attest', cycle: 1, at_ms: 1 });
    // one operator item, no non-operator siblings → blocked_by null is allowed
    jobs.addItem(job.id, {
      description: 'operator sign-off',
      spec: { hooks: [{ name: 'operator_attested', args: {} }] },
      source: 'operator',
      blocked_by: null,
    });
    db.prepare("INSERT INTO progress_state (id, no_progress_cycles, last_signature) VALUES ('self', ?, 'p0:j1')").run(noProgress);
    return db;
  }

  it('repeated identical action is NOT persistence-blocked while resting', async () => {
    const db = restingDb(0);
    const ctx = makeCtx(db, []);
    expect((await act(ctx, prevWith('probe'))).actResult).toBe('ok'); // records probe|{}
    expect((await act(ctx, prevWith('probe'))).actResult).toBe('ok'); // resting → exact repeat NOT blocked
  });

  it('THRESHOLD block does NOT fire while resting', async () => {
    const db = restingDb(NO_PROGRESS_THRESHOLD);
    const r = await act(makeCtx(db, []), prevWith('probe'));
    expect(r.actResult).toBe('ok');
  });

  it('ESCALATE does NOT park or defer the operator item while resting', async () => {
    const db = restingDb(NO_PROGRESS_ESCALATE);
    const jobs = new JobsService(db);
    const opItem = jobs.checklist.items(jobs.checklist.listOpen()[0]!.id)[0]!;
    const r = await act(makeCtx(db, []), prevWith('probe'));
    expect(r.actResult).toBe('ok'); // not parked
    expect(jobs.checklist.getItem(opItem.id)?.state).toBe('open'); // operator item NOT deferred
  });

  it('precision: once a non-operator item is open, the breakers fire again', async () => {
    const db = restingDb(0);
    const jobs = new JobsService(db);
    const jid = jobs.checklist.listOpen()[0]!.id;
    jobs.addItem(jid, {
      description: 'real work',
      spec: { hooks: [{ name: 'file_exists', args: { path: 'Z:/no.md' } }] },
      source: 'plan_step',
    });
    const ctx = makeCtx(db, []);
    expect((await act(ctx, prevWith('probe'))).actResult).toBe('ok'); // records probe|{}
    const r = await act(ctx, prevWith('probe')); // exact repeat, NOT resting → persistence fires
    expect(r.actResult).toBe('failed');
    expect(r.actFailedReason).toMatch(/Persistence/);
  });
});
