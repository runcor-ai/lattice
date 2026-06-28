import { default as DatabaseCtor } from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import type { Db } from '../db.js';
import { act } from './act.js';
import type { CycleContext, DecideOutput } from '../types.js';

/**
 * Coverage for the close-job-item silent-`blocked` fix (run-2 stall).
 *
 * Background: JobsService.attemptCheck returns outcome:'blocked' when an
 * item's blocked_by chain hasn't cleared yet — no hook runs, no iteration
 * consumed, the close just doesn't transition the item. The capability
 * surfaces that as out.data with result:'ok'. Without the fix in act.ts,
 * the cycle records actResult='ok' and the next cycle's recent-actions
 * memory tells the architect "close-job-item: ok" — masking the silent
 * stall observed in abc-architect-run-2 where the architect picked
 * transitively-blocked items 5 cycles in a row (c33, c45, c49, c50, c51).
 *
 * The fix downgrades non-'passed' outcomes to actResult='failed' so the
 * write-phase memory clock surfaces the real outcome+reason to the next
 * cycle's ground prompt, where the architect can read it and reroute.
 */

const Database = DatabaseCtor;

function freshDb(): Db {
  const db = new Database(':memory:') as unknown as Db;
  db.exec(`CREATE TABLE recent_action (cycle INTEGER NOT NULL, action_name TEXT NOT NULL, input_hash TEXT NOT NULL);`);
  return db;
}

/** Capability stub that returns whatever fixedResult we want — driven per-test. */
function makeCloseStub(fixedResult: { itemId: string; outcome: string; reason?: string }) {
  return {
    name: 'close-job-item',
    description: 'test stub for close-job-item',
    role: { sense: false, action: true },
    readOnly: false,
    destructive: false,
    concurrencySafe: false,
    isEnabled: () => true,
    canInvoke: () => ({ allow: true }),
    invoke: async () => fixedResult,
  };
}

function makeCtx(
  db: Db,
  cycle: number,
  actions: ReadonlyArray<unknown>,
  traces: Array<Record<string, unknown>>,
): CycleContext {
  return {
    cycle,
    at_ms: cycle,
    abortSignal: new AbortController().signal,
    autonomy: 'medium',
    actions,
    memory: { dbHandle: () => db },
    trace: { write: (e: Record<string, unknown>) => traces.push(e) },
  } as unknown as CycleContext;
}

function prevWith(action: string | null, input: Record<string, unknown>): DecideOutput {
  return { chosenAction: action, chosenInput: input } as unknown as DecideOutput;
}

describe('act — close-job-item silent-blocked surfacing (run-2 stall fix)', () => {
  it('outcome=blocked → actResult=failed with itemId-short + reason in actFailedReason', async () => {
    const db = freshDb();
    const stub = makeCloseStub({
      itemId: 'ad8e0d01-49ad-4379-83d9-8980406e6ec1',
      outcome: 'blocked',
      reason: 'blocked until "Judge plan.md" passes',
    });
    const r = await act(makeCtx(db, 1, [stub], []), prevWith('close-job-item', { itemId: 'ad8e0d01' }));
    expect(r.actResult).toBe('failed');
    expect(r.actFailedReason).toBe(
      'close-job-item ad8e0d01 → blocked: blocked until "Judge plan.md" passes',
    );
  });

  it('outcome=blocked does NOT call recordAction (persistence-law window stays honest)', async () => {
    const db = freshDb();
    const stub = makeCloseStub({
      itemId: 'ad8e0d01-49ad-4379-83d9-8980406e6ec1',
      outcome: 'blocked',
      reason: 'blocker open',
    });
    await act(makeCtx(db, 1, [stub], []), prevWith('close-job-item', { itemId: 'ad8e0d01' }));
    const n = (db.prepare('SELECT COUNT(*) AS n FROM recent_action').get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('outcome=failed_iterating is also surfaced as failed (covers the broader non-passed family)', async () => {
    const db = freshDb();
    const stub = makeCloseStub({
      itemId: 'fb93009e-7205-45d6-b959-263f598fa941',
      outcome: 'failed_iterating',
      reason: 'file_exists: /tmp/missing.md does not exist',
    });
    const r = await act(makeCtx(db, 1, [stub], []), prevWith('close-job-item', { itemId: 'fb93009e' }));
    expect(r.actResult).toBe('failed');
    expect(r.actFailedReason).toMatch(/close-job-item fb93009e → failed_iterating:/);
  });

  it('outcome=passed → actResult=ok and recordAction IS called', async () => {
    const db = freshDb();
    const stub = makeCloseStub({
      itemId: '690c9443-006b-427b-9d95-d39c5f8c84ee',
      outcome: 'passed',
    });
    const r = await act(makeCtx(db, 1, [stub], []), prevWith('close-job-item', { itemId: '690c9443' }));
    expect(r.actResult).toBe('ok');
    const n = (db.prepare('SELECT COUNT(*) AS n FROM recent_action').get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('outcome with no reason → renders "(no reason)" in actFailedReason', async () => {
    const db = freshDb();
    const stub = makeCloseStub({
      itemId: '11111111-2222-3333-4444-555555555555',
      outcome: 'blocked',
      // reason intentionally omitted
    });
    const r = await act(makeCtx(db, 1, [stub], []), prevWith('close-job-item', { itemId: '11111111' }));
    expect(r.actResult).toBe('failed');
    expect(r.actFailedReason).toBe('close-job-item 11111111 → blocked: (no reason)');
  });

  it('non-close-job-item action with outcome:"blocked" in data is NOT downgraded (scoping)', async () => {
    // Other actions don't carry passed/blocked semantics. Even if a
    // capability happens to return { outcome: 'blocked' }, the fix is
    // narrowly scoped to close-job-item — generalizing would misclassify
    // legitimate ok results that incidentally contain that field name.
    const db = freshDb();
    const probe = {
      name: 'unrelated-action',
      description: 'probe that happens to use outcome key',
      role: { sense: false, action: true },
      readOnly: false,
      destructive: false,
      concurrencySafe: true,
      isEnabled: () => true,
      canInvoke: () => ({ allow: true }),
      invoke: async () => ({ outcome: 'blocked', detail: 'something else' }),
    };
    const r = await act(makeCtx(db, 1, [probe], []), prevWith('unrelated-action', {}));
    expect(r.actResult).toBe('ok');
  });
});
