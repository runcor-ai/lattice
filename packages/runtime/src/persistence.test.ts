import { default as DatabaseCtor } from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import type { Db } from './db.js';
import { hashActionInput, isPersistenceViolation, PERSISTENCE_WINDOW, recordAction } from './persistence.js';
import { act } from './phases/act.js';
import type { CycleContext, DecideOutput } from './types.js';

const Database = DatabaseCtor;

function freshDb(): Db {
  const db = new Database(':memory:') as unknown as Db;
  db.exec(`CREATE TABLE recent_action (cycle INTEGER NOT NULL, action_name TEXT NOT NULL, input_hash TEXT NOT NULL);`);
  return db;
}

describe('hashActionInput', () => {
  it('is stable across key order', () => {
    expect(hashActionInput({ a: 1, b: 2 })).toBe(hashActionInput({ b: 2, a: 1 }));
  });
  it('differs for different inputs', () => {
    expect(hashActionInput({ path: '/a' })).not.toBe(hashActionInput({ path: '/b' }));
  });
});

describe('Persistence window (Item 6)', () => {
  let db: Db;
  beforeEach(() => { db = freshDb(); });

  it('same action + same inputs within the window → violation', () => {
    const h = hashActionInput({ cmd: 'ls' });
    recordAction(db, 'shell', h, 1);
    expect(isPersistenceViolation(db, 'shell', h, 2)).toBe(true);
  });

  it('same action + different inputs → no violation', () => {
    recordAction(db, 'shell', hashActionInput({ cmd: 'ls' }), 1);
    expect(isPersistenceViolation(db, 'shell', hashActionInput({ cmd: 'pwd' }), 2)).toBe(false);
  });

  it('same action + same inputs but OUTSIDE the window → no violation', () => {
    const h = hashActionInput({ cmd: 'ls' });
    recordAction(db, 'shell', h, 1);
    expect(isPersistenceViolation(db, 'shell', h, 1 + PERSISTENCE_WINDOW + 1)).toBe(false);
  });

  it('prunes aged-out entries on record', () => {
    recordAction(db, 'shell', hashActionInput({ cmd: 'ls' }), 1);
    recordAction(db, 'shell', hashActionInput({ cmd: 'pwd' }), 1 + PERSISTENCE_WINDOW + 5);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM recent_action').get() as { n: number }).n;
    expect(n).toBe(1);
  });
});

/* ---- act-phase integration ---- */

const probe = {
  name: 'probe',
  description: 'test probe action',
  role: { sense: false, action: true },
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  isEnabled: () => true,
  canInvoke: () => ({ allow: true }),
  invoke: async () => ({ probed: true }),
};

function makeCtx(db: Db, cycle: number, traces: Array<Record<string, unknown>>): CycleContext {
  return {
    cycle,
    at_ms: cycle,
    abortSignal: new AbortController().signal,
    autonomy: 'medium',
    actions: [probe],
    memory: { dbHandle: () => db },
    trace: { write: (e: Record<string, unknown>) => traces.push(e) },
  } as unknown as CycleContext;
}

function prevWith(action: string | null, input: Record<string, unknown>): DecideOutput {
  return { chosenAction: action, chosenInput: input } as unknown as DecideOutput;
}

describe('act phase enforces Persistence (Item 6)', () => {
  it('blocks an exact repeat within the window and emits a substrate trace', async () => {
    const db = freshDb();
    const r1 = await act(makeCtx(db, 1, []), prevWith('probe', { x: 1 }));
    expect(r1.actResult).toBe('ok');

    const traces: Array<Record<string, unknown>> = [];
    const r2 = await act(makeCtx(db, 2, traces), prevWith('probe', { x: 1 }));
    expect(r2.actResult).toBe('failed');
    expect(r2.actFailedReason).toMatch(/Persistence/);
    expect(
      traces.some((t) => t.kind === 'substrate' && t.law === 'persistence' && t.outcome === 'block'),
    ).toBe(true);
  });

  it('allows the same action with different inputs', async () => {
    const db = freshDb();
    await act(makeCtx(db, 1, []), prevWith('probe', { x: 1 }));
    const r = await act(makeCtx(db, 2, []), prevWith('probe', { x: 2 }));
    expect(r.actResult).toBe('ok');
  });

  it('allows the same action+inputs again once outside the window', async () => {
    const db = freshDb();
    await act(makeCtx(db, 1, []), prevWith('probe', { x: 1 }));
    const r = await act(makeCtx(db, 1 + PERSISTENCE_WINDOW + 1, []), prevWith('probe', { x: 1 }));
    expect(r.actResult).toBe('ok');
  });

  it('never blocks no-action (idle stays legal every cycle)', async () => {
    const db = freshDb();
    expect((await act(makeCtx(db, 1, []), prevWith(null, {}))).actResult).toBe('no-action');
    expect((await act(makeCtx(db, 2, []), prevWith(null, {}))).actResult).toBe('no-action');
  });
});
