import type { ClosureResult } from '@runcor/jobs';
import type { AutonomyLevel } from '@runcor/substrate';
import type { TraceEntry } from '@runcor/trace';
import { describe, it, expect } from 'vitest';

import { autoAttemptJobClose } from './write.js';

/**
 * Item 2/3 — unit coverage for the per-job auto-close helper, including
 * the fault-injection path (Item 3): when close() throws, the failure is
 * traced as `auto-close-error` and the helper does NOT rethrow, so the
 * cycle continues.
 */
function harness(autonomy: AutonomyLevel = 'high') {
  const entries: TraceEntry[] = [];
  const ctx = {
    cycle: 7,
    at_ms: 1234,
    autonomy,
    trace: { write: (e: TraceEntry) => entries.push(e) },
  };
  return { entries, ctx };
}

describe('autoAttemptJobClose (Item 2/3)', () => {
  it('Item 3: a throwing close() is traced as auto-close-error and does NOT rethrow', () => {
    const { entries, ctx } = harness();
    const jobs = {
      close(): ClosureResult {
        throw new Error('boom: corrupted job row');
      },
    };

    // Must not throw — one bad job cannot break the cycle.
    expect(() => autoAttemptJobClose(jobs, 'job-1', ctx)).not.toThrow();

    expect(entries).toHaveLength(1);
    const e = entries[0] as { kind: string; rule: string; memory_id: string; now: string };
    expect(e.kind).toBe('subconscious');
    expect(e.rule).toBe('auto-close-error');
    expect(e.memory_id).toBe('job-1');
    expect(e.now).toContain('boom');
  });

  it('closed_full emits a job trace; medium carries the escalation note', () => {
    const { entries, ctx } = harness('medium');
    const jobs = {
      close(): ClosureResult {
        return { result: 'closed', mode: 'full', job: { status: 'closed_full' } as never, escalated: true };
      },
    };
    autoAttemptJobClose(jobs, 'job-2', ctx);
    const e = entries[0] as { kind: string; event: string; job_id: string; detail: string };
    expect(e.kind).toBe('job');
    expect(e.event).toBe('closed_full');
    expect(e.job_id).toBe('job-2');
    expect(e.detail).toContain('operator confirmation requested');
  });

  it('pending_operator emits an observed subconscious trace (no job close)', () => {
    const { entries, ctx } = harness('low');
    const jobs = {
      close(): ClosureResult {
        return { result: 'pending_operator', mode: 'full', reason: 'autonomy=low: 1 passed, 0 deferred' };
      },
    };
    autoAttemptJobClose(jobs, 'job-3', ctx);
    const e = entries[0] as { kind: string; rule: string };
    expect(e.kind).toBe('subconscious');
    expect(e.rule).toBe('auto-attempt-job-close (observed, pending_operator)');
  });

  it('not_ready (items still open) is silent — no trace', () => {
    const { entries, ctx } = harness();
    const jobs = {
      close(): ClosureResult {
        return { result: 'not_ready', reason: '2 item(s) still open' };
      },
    };
    autoAttemptJobClose(jobs, 'job-4', ctx);
    expect(entries).toHaveLength(0);
  });
});
