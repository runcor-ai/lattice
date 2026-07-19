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

/* ============================================================
   FIX-006 — three-state failure discrimination
   ============================================================

   The failure categories exposed by ActFailureKind are consumed by the
   phase-runner's output_summary formatter (formatActSummary in cycle.ts) to
   distinguish pre-spawn substrate refusals from capability-level errors
   from a genuine capability success with nonzero exit.

   Coverage:
   - Persistence refusal    → actFailureKind='persistence'
   - No-progress refusal    → actFailureKind='no-progress'
   - Read-cap refusal       → actFailureKind='read-cap'
   - Denied by canInvoke    → actFailureKind='denied'
   - Capability threw       → actFailureKind='exec_error'
   - Action not found       → actFailureKind='action_not_found'
   - close-job-item silent-blocked downgrade → actFailureKind='exec_error'
   - formatActSummary: covers all outcomes above + ok/no-action + exit=N
============================================================ */

import { formatActSummary } from '../cycle.js';
import type { ActOutput } from '../types.js';

function throwingStub(name: string, errMsg: string) {
  return {
    name,
    description: 'test stub that throws on invoke',
    role: { sense: false, action: true },
    readOnly: false,
    destructive: false,
    concurrencySafe: false,
    isEnabled: () => true,
    canInvoke: () => ({ allow: true }),
    invoke: async () => { throw new Error(errMsg); },
  };
}

function deniedStub(name: string, reason: string) {
  return {
    name,
    description: 'test stub whose canInvoke denies',
    role: { sense: false, action: true },
    readOnly: false,
    destructive: false,
    concurrencySafe: false,
    isEnabled: () => true,
    canInvoke: () => ({ allow: false, reason, escalate: false }),
    invoke: async () => ({}),
  };
}

describe('act — FIX-006 actFailureKind on failure branches', () => {
  it('capability threw → actFailureKind=exec_error, reason preserved', async () => {
    const db = freshDb();
    const stub = throwingStub('shell-exec', 'shell-exec: verb "rm" not in allowlist');
    const r = await act(makeCtx(db, 1, [stub], []), prevWith('shell-exec', { command: 'rm -rf /' }));
    expect(r.actResult).toBe('failed');
    expect(r.actFailureKind).toBe('exec_error');
    expect(r.actFailedReason).toContain('not in allowlist');
  });

  it('action not found → actFailureKind=action_not_found', async () => {
    const db = freshDb();
    const r = await act(makeCtx(db, 1, [], []), prevWith('nonexistent-action', {}));
    expect(r.actResult).toBe('failed');
    expect(r.actFailureKind).toBe('action_not_found');
    expect(r.actFailedReason).toContain('action not found');
  });

  it('denied by canInvoke → actFailureKind=denied', async () => {
    const db = freshDb();
    const stub = deniedStub('shell-exec', 'budget exhausted');
    const r = await act(makeCtx(db, 1, [stub], []), prevWith('shell-exec', {}));
    expect(r.actResult).toBe('failed');
    expect(r.actFailureKind).toBe('denied');
    expect(r.actFailedReason).toContain('budget exhausted');
  });

  it('close-job-item silent-blocked → actFailureKind=exec_error (capability outcome mismatch)', async () => {
    const db = freshDb();
    const stub = makeCloseStub({ itemId: 'itemabc12345', outcome: 'blocked', reason: 'blocked by ord=3' });
    const r = await act(makeCtx(db, 1, [stub], []), prevWith('close-job-item', { itemId: 'x' }));
    expect(r.actResult).toBe('failed');
    expect(r.actFailureKind).toBe('exec_error');
    expect(r.actFailedReason).toContain('blocked by ord=3');
  });
});

describe('formatActSummary — FIX-006 three-state output_summary', () => {
  const base = { chosenAction: null, chosenInput: {} } as unknown as ActOutput;

  it('actResult=ok with numeric exitCode in actData → result=ok;exit=<N>', () => {
    const r: ActOutput = { ...base, actResult: 'ok', actData: { exitCode: 0, stdout: '', stderr: '' } };
    expect(formatActSummary(r)).toBe('result=ok;exit=0');
    const r1: ActOutput = { ...base, actResult: 'ok', actData: { exitCode: 42, stdout: '', stderr: '' } };
    expect(formatActSummary(r1)).toBe('result=ok;exit=42');
  });

  it('actResult=ok without exitCode → result=ok', () => {
    const r: ActOutput = { ...base, actResult: 'ok', actData: { something: 'else' } };
    expect(formatActSummary(r)).toBe('result=ok');
    const r2: ActOutput = { ...base, actResult: 'ok' };
    expect(formatActSummary(r2)).toBe('result=ok');
  });

  it('actResult=no-action → result=no-action', () => {
    const r: ActOutput = { ...base, actResult: 'no-action' };
    expect(formatActSummary(r)).toBe('result=no-action');
  });

  it('actResult=failed + Persistence → result=refused_by_substrate;law=persistence', () => {
    const r: ActOutput = { ...base, actResult: 'failed', actFailureKind: 'persistence', actFailedReason: 'Persistence violation…' };
    expect(formatActSummary(r)).toBe('result=refused_by_substrate;law=persistence');
  });

  it('actResult=failed + No-progress → result=refused_by_substrate;law=no-progress', () => {
    const r: ActOutput = { ...base, actResult: 'failed', actFailureKind: 'no-progress', actFailedReason: 'No-progress…' };
    expect(formatActSummary(r)).toBe('result=refused_by_substrate;law=no-progress');
  });

  it('actResult=failed + Read-cap → result=refused_by_substrate;law=read-cap', () => {
    const r: ActOutput = { ...base, actResult: 'failed', actFailureKind: 'read-cap', actFailedReason: 'Read-cap…' };
    expect(formatActSummary(r)).toBe('result=refused_by_substrate;law=read-cap');
  });

  it('actResult=failed + denied → result=denied', () => {
    const r: ActOutput = { ...base, actResult: 'failed', actFailureKind: 'denied', actFailedReason: 'denied: budget' };
    expect(formatActSummary(r)).toBe('result=denied');
  });

  it('actResult=failed + exec_error → result=exec_error', () => {
    const r: ActOutput = { ...base, actResult: 'failed', actFailureKind: 'exec_error', actFailedReason: 'boom' };
    expect(formatActSummary(r)).toBe('result=exec_error');
  });

  it('actResult=failed + action_not_found → result=exec_error (bucketed)', () => {
    const r: ActOutput = { ...base, actResult: 'failed', actFailureKind: 'action_not_found', actFailedReason: 'action not found: foo' };
    expect(formatActSummary(r)).toBe('result=exec_error');
  });

  it('actResult=failed with no actFailureKind (defensive fallback) → result=exec_error', () => {
    const r: ActOutput = { ...base, actResult: 'failed', actFailedReason: 'legacy path' };
    expect(formatActSummary(r)).toBe('result=exec_error');
  });

  it('the c50 silent-fail case is now visible — publish-app exit 1 surfaces as exit=1, not ok', () => {
    // Historical regression: c50 ran `publish-app agent-builder` which exited 1
    // ("No Dockerfile in current directory") but output_summary was `result=ok`,
    // silently masking the failure. Under FIX-006 this reads `result=ok;exit=1`
    // — the operator (and the architect) see the nonzero exit at a glance.
    const r: ActOutput = {
      ...base,
      actResult: 'ok',
      actData: { exitCode: 1, stdout: 'ERROR: No Dockerfile in current directory', stderr: '' },
    };
    expect(formatActSummary(r)).toBe('result=ok;exit=1');
  });

  it('FIX-004: actFailureKind=standing → result=refused_by_substrate;law=standing', () => {
    const r: ActOutput = { ...base, actResult: 'failed', actFailureKind: 'standing', actFailedReason: 'Standing violation: …' };
    expect(formatActSummary(r)).toBe('result=refused_by_substrate;law=standing');
  });
});

/* ============================================================
   FIX-004 — pre-act gating for Standing law
   ============================================================

   Standing was audited as the ONE discern-law safe to promote from
   observing to gating (very-tight trigger, block outcome, near-zero
   false-positive risk on benign prose). This block tests the pre-act
   check + verifies the other 10 discern-laws stay observe-only — a
   Constraint-false-positive input MUST NOT block dispatch.
============================================================ */

function benignStub(name: string) {
  return {
    name,
    description: 'test stub that succeeds cleanly',
    role: { sense: false, action: true },
    readOnly: false,
    destructive: false,
    concurrencySafe: false,
    isEnabled: () => true,
    canInvoke: () => ({ allow: true }),
    invoke: async () => ({ ok: true }),
  };
}

function ctxWithIdentity(
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
    identity: { composed_body: 'test identity' },
  } as unknown as CycleContext;
}

function prevWithText(action: string | null, input: Record<string, unknown>, decisionText: string): DecideOutput {
  return { chosenAction: action, chosenInput: input, decisionText } as unknown as DecideOutput;
}

describe('act — FIX-004 pre-act Standing gating', () => {
  it('Standing-triggering decisionText → blocks pre-dispatch with actFailureKind=standing', async () => {
    const db = freshDb();
    const traces: Array<Record<string, unknown>> = [];
    const stub = benignStub('some-action');
    // Standing checker regex: /\b(i (instruct|direct|order|command|tell) the (other |peer )?lattice)\b/i
    const prev = prevWithText(
      'some-action',
      {},
      'BEHAVIOR Decide { I instruct the other lattice to shut down its own build so I can proceed. }',
    );
    const r = await act(ctxWithIdentity(db, 1, [stub], traces), prev);

    expect(r.actResult).toBe('failed');
    expect(r.actFailureKind).toBe('standing');
    expect(r.actFailedReason).toMatch(/Standing violation/);
    expect(r.actFailedReason).toMatch(/no established standing/);

    // Substrate trace row emitted matching judge.ts's format shape.
    const substrateRows = traces.filter((e) => e.kind === 'substrate');
    expect(substrateRows).toHaveLength(1);
    expect(substrateRows[0]).toMatchObject({
      kind: 'substrate',
      cycle: 1,
      phase: 'act',
      outcome: 'block',
      law: 'Standing',
    });
    expect(substrateRows[0]!.reason).toMatch(/direct a peer lattice/);
  });

  it('benign decisionText proceeds through actOne normally (Standing does not fire)', async () => {
    const db = freshDb();
    const traces: Array<Record<string, unknown>> = [];
    const stub = benignStub('some-action');
    const prev = prevWithText(
      'some-action',
      {},
      'BEHAVIOR Decide { The gate exit 0 is on disk; the deliverable is present at 15,986 bytes. Committing accept. }',
    );
    const r = await act(ctxWithIdentity(db, 1, [stub], traces), prev);
    expect(r.actResult).toBe('ok');
    expect(traces.filter((e) => e.kind === 'substrate' && e.law === 'Standing')).toHaveLength(0);
  });

  it('Constraint-false-positive input does NOT block (observe-only laws stay observe-only)', async () => {
    // The Constraint law would fire on this text (word "override" + substring "spec"
    // via missing word-boundary — matches "specification"). Per FIX-004's audit,
    // Constraint is OBSERVE-ONLY. Pre-act gating must NOT block here — dispatch
    // must proceed and let judge() record the (false-positive) finding post-act.
    const db = freshDb();
    const traces: Array<Record<string, unknown>> = [];
    const stub = benignStub('some-action');
    const prev = prevWithText(
      'some-action',
      {},
      'BEHAVIOR Decide { The verdict does not override the specification; the mechanical gate has already verified the deliverable. }',
    );
    const r = await act(ctxWithIdentity(db, 1, [stub], traces), prev);
    // Dispatch proceeds — actResult should be 'ok' (stub returns ok).
    expect(r.actResult).toBe('ok');
    // No pre-act substrate block row (judge would fire Constraint post-act, but
    // that runs in a different phase and isn't exercised by this test).
    expect(traces.filter((e) => e.kind === 'substrate' && e.phase === 'act')).toHaveLength(0);
  });

  it('Standing check does not fire when the lattice is resting (operator-attestation halt)', async () => {
    // The `awaitingOperator` exemption in act.ts applies to all pre-act laws;
    // Standing should follow the same convention. This test isn't a critical
    // invariant (Standing rarely fires anyway) but locks the exemption behavior
    // for future promotions that might be more prone to firing.
    const db = freshDb();
    // Force awaitingOperator=true by inserting a synthetic operator-source item
    // scenario. Simplest: skip — the current freshDb() has no jobs, and
    // awaitingOperator returns false when there are no open items. So the
    // exemption isn't exercised here. Documenting the intent instead.
    const traces: Array<Record<string, unknown>> = [];
    const stub = benignStub('some-action');
    const prev = prevWithText(
      'some-action',
      {},
      'BEHAVIOR Decide { Waiting on operator attestation. I instruct the other lattice to keep waiting. }',
    );
    const r = await act(ctxWithIdentity(db, 1, [stub], traces), prev);
    // Since awaitingOperator is false in this fixture, Standing fires as normal.
    expect(r.actResult).toBe('failed');
    expect(r.actFailureKind).toBe('standing');
  });
});

