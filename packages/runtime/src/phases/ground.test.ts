import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderTasksBlock } from './ground.js';
import type { TasksView } from '../types.js';

/**
 * Tests for the open-tasks gate-line rendering matrix. The whole point
 * of this rewrite is that an item's closeability is legible REGARDLESS
 * of hook tier — costly-gated items must not render NOT MET when they
 * are reachable, and operator items must never render "close this" to
 * the architect.
 *
 * The bug being closed (run-3 phase-3 stall): cheap-gated ord=1 with a
 * stale file rendered "gate OK — close this item" while reachable
 * step_acknowledged ord=8 rendered "gate NOT MET — costly gate".
 * Six wrong picks, then the no-progress circuit-breaker fired.
 *
 * Tests are pure — they construct a TasksView fake and assert the
 * rendered lines. The renderer does no fs I/O of its own; it consumes
 * the gate field as already computed by summarizeGate.
 */

type Item = {
  id: string;
  description: string;
  iteration_count: number;
  gate: {
    passed: boolean;
    reason: string;
    deferred: boolean;
    kind: 'cheap_pass' | 'cheap_pass_costly_pending' | 'cheap_fail' | 'costly_only' | 'unknown_hook';
    costlyHook?: string;
  };
  blockedBy: { ordinal: number } | null;
  source: string;
};

function fakeTasks(items: Item[]): TasksView {
  return {
    listOpenJobs: () => [{ id: 'job-1', title: 'test', why: 'test job', body: '' }],
    listOpenItems: () => items,
  };
}

const baseItem = (overrides: Partial<Item>): Item => ({
  id: 'item-fixed-id-for-snapshotting-abcd1234',
  description: 'a test item',
  iteration_count: 0,
  gate: { passed: true, reason: 'ok', deferred: false, kind: 'cheap_pass' },
  blockedBy: null,
  source: 'plan_step',
  ...overrides,
});

describe('renderTasksBlock — closeability matrix', () => {
  it('Test 1 — reachable step_acknowledged renders a closeability signal ("ready"), not "NOT MET" or blank', () => {
    const out = renderTasksBlock(fakeTasks([
      baseItem({
        description: 'Phase 3 — delegate /phase3-architecture',
        gate: {
          passed: false,
          reason: 'costly gate — verified only on an explicit close-job-item attempt',
          deferred: true,
          kind: 'costly_only',
          costlyHook: 'step_acknowledged',
        },
      }),
    ]));
    expect(out).toMatch(/gate: ready — acknowledgement gate; close-job-item with a one-line justification to close/);
    // Critically: the pre-fix line "gate NOT MET — costly gate — verified only on …" must NOT appear.
    expect(out).not.toMatch(/gate NOT MET — costly gate/);
    // And the line must not be empty.
    expect(out).toMatch(/Phase 3/);
  });

  it('Test 2 — reachable command_exits_zero renders "costly" with the hook name; summarizer does NOT execute the command', () => {
    const out = renderTasksBlock(fakeTasks([
      baseItem({
        description: 'Run tests',
        gate: {
          passed: false,
          reason: 'costly gate — verified only on an explicit close-job-item attempt',
          deferred: true,
          kind: 'costly_only',
          costlyHook: 'command_exits_zero',
        },
      }),
    ]));
    expect(out).toMatch(/gate: costly — close-job-item will run command_exits_zero/);
    expect(out).not.toMatch(/gate NOT MET/);
  });

  it('Test 3 — reachable http_status_is renders "costly"; no fetch in the summarizer', () => {
    const out = renderTasksBlock(fakeTasks([
      baseItem({
        description: 'Service healthy',
        gate: {
          passed: false,
          reason: 'costly gate — verified only on an explicit close-job-item attempt',
          deferred: true,
          kind: 'costly_only',
          costlyHook: 'http_status_is',
        },
      }),
    ]));
    expect(out).toMatch(/gate: costly — close-job-item will run http_status_is/);
    expect(out).not.toMatch(/gate NOT MET/);
  });

  it('Test 4 — blocked step_acknowledged renders blocked, not "ready" (no closeability signal under a blocker)', () => {
    const out = renderTasksBlock(fakeTasks([
      baseItem({
        description: 'Phase 4 — depends on phase 3',
        blockedBy: { ordinal: 8 },
        gate: {
          passed: false,
          reason: 'costly gate — verified only on an explicit close-job-item attempt',
          deferred: true,
          kind: 'costly_only',
          costlyHook: 'step_acknowledged',
        },
      }),
    ]));
    expect(out).toMatch(/\(blocked by ord=8 open\)/);
    expect(out).not.toMatch(/gate: ready/);
    expect(out).not.toMatch(/gate: costly/);
    expect(out).not.toMatch(/gate OK/);
  });

  it('Test 5 — operator_attested item renders operator-only; never "close this" to the architect', () => {
    const out = renderTasksBlock(fakeTasks([
      baseItem({
        source: 'operator',
        description: 'Land the final done attestation',
        gate: {
          passed: false,
          reason: 'costly gate — verified only on an explicit close-job-item attempt',
          deferred: true,
          kind: 'costly_only',
          costlyHook: 'operator_attested',
        },
      }),
    ]));
    expect(out).toMatch(/awaiting operator attestation/);
    expect(out).toMatch(/closeable only by POST/);
    // The architect must NOT see any "close this" prompt on this item.
    expect(out).not.toMatch(/close this item via close-job-item/);
    // And the legacy NOT MET line is gone.
    expect(out).not.toMatch(/gate NOT MET/);
  });

  it('Test 6 — operator_attested item still renders operator-only EVEN when (semantically) all siblings would be passed', () => {
    // The renderer doesn't see sibling state — its uniformity is the point.
    // The operator_attested HOOK itself checks the all-siblings-passed
    // condition at attemptCheck time; the rendered prompt must never tempt
    // the architect into trying close, regardless of sibling state.
    const out = renderTasksBlock(fakeTasks([
      // Two siblings — irrelevant to the renderer, included to make the
      // intent of "all siblings hypothetically passed" visible.
      baseItem({ id: 'sibling-1', description: 'work 1 — done', gate: { passed: true, reason: 'gate satisfied — close this item via close-job-item', deferred: false, kind: 'cheap_pass' } }),
      baseItem({ id: 'sibling-2', description: 'work 2 — done', gate: { passed: true, reason: 'gate satisfied — close this item via close-job-item', deferred: false, kind: 'cheap_pass' } }),
      baseItem({
        id: 'attest-id',
        source: 'operator',
        description: 'Final operator attestation',
        gate: {
          passed: false,
          reason: 'costly gate — verified only on an explicit close-job-item attempt',
          deferred: true,
          kind: 'costly_only',
          costlyHook: 'operator_attested',
        },
      }),
    ]));
    // Render shape for the operator item — uniform with test 5.
    expect(out).toMatch(/Final operator attestation \(operator-attestation — closeable only by operator endpoint\)/);
    expect(out).toMatch(/gate: awaiting operator attestation — closeable only by POST \/api\/lattices\/:id\/items\/:item_id\/attest, not by architect/);
    // Critically: no architect-facing close-this signal on the operator item.
    // Per-line: the gate line under the operator item must not contain "close this item via close-job-item".
    const lines = out.split('\n');
    const attestIdx = lines.findIndex((l) => l.includes('attest-id'));
    expect(attestIdx).toBeGreaterThanOrEqual(0);
    const gateLine = lines[attestIdx + 1];
    expect(gateLine).toBeDefined();
    expect(gateLine).not.toMatch(/close this item via close-job-item/);
    expect(gateLine).toMatch(/awaiting operator attestation/);
  });

  it('Test 7 — cheap file_exists with file absent does NOT render "gate OK" — cheap-fail invariant', () => {
    // summarizeGate is what determines passed/kind based on the live fs;
    // here we simulate its output: kind='cheap_fail' with the specific reason.
    const out = renderTasksBlock(fakeTasks([
      baseItem({
        description: 'write the deliverable',
        gate: {
          passed: false,
          reason: 'file_exists: /tmp/missing.md not found',
          deferred: false,
          kind: 'cheap_fail',
        },
      }),
    ]));
    expect(out).toMatch(/gate NOT MET — file_exists: \/tmp\/missing\.md not found/);
    expect(out).not.toMatch(/gate OK/);
    expect(out).not.toMatch(/close this item via close-job-item/);
  });

  it('Test 8 — cheap file_exists with file present renders OK exactly as before (no regression)', () => {
    const out = renderTasksBlock(fakeTasks([
      baseItem({
        description: 'write the deliverable',
        gate: {
          passed: true,
          reason: 'gate satisfied — close this item via close-job-item',
          deferred: false,
          kind: 'cheap_pass',
        },
      }),
    ]));
    expect(out).toMatch(/gate OK — gate satisfied — close this item via close-job-item/);
  });

  it('Test 9 — cheap pass + costly pending shows both signals', () => {
    const out = renderTasksBlock(fakeTasks([
      baseItem({
        description: 'deliverable + post-close shell check',
        gate: {
          passed: true,
          reason: 'cheap gates satisfied — a costly gate is still verified on explicit close',
          deferred: true,
          kind: 'cheap_pass_costly_pending',
          costlyHook: 'command_exits_zero',
        },
      }),
    ]));
    expect(out).toMatch(/gate OK — cheap checks satisfied; close-job-item will run the costly command_exits_zero check/);
  });

  it('Test 10 — unknown hook still renders UNKNOWN (no regression on the error path)', () => {
    const out = renderTasksBlock(fakeTasks([
      baseItem({
        description: 'misspelled hook',
        gate: {
          passed: false,
          reason: 'unknown gate hook: file_existzz',
          deferred: false,
          kind: 'unknown_hook',
        },
      }),
    ]));
    expect(out).toMatch(/gate UNKNOWN — unknown gate hook: file_existzz/);
  });
});

/* ============================================================ */
/* Light integration with summarizeGate to confirm the live     */
/* gate-kind values map to the renderer's branches.             */
/* ============================================================ */

describe('renderTasksBlock + summarizeGate — end-to-end via a real gate evaluation', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ground-test-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('integration — a cheap_fail from summarizeGate flows through to NOT MET in the rendered prompt', async () => {
    const { builtinRegistry, summarizeGate, parseSpec } = await import('@runcor/jobs');
    const missing = join(dir, 'never-existed.md');
    const fakeIt = {
      id: 'x',
      job_id: 'j',
      ordinal: 1,
      description: 'd',
      state: 'open' as const,
      iteration_count: 0,
      completion_check: JSON.stringify({ hooks: [{ name: 'file_exists', args: { path: missing } }] }),
      passed_at_cycle: null,
      deferred_at_cycle: null,
      defer_reason: null,
      unblock_condition: null,
      unblock_test: null,
      source: 'plan_step',
      blocked_by: null,
    };
    const gate = summarizeGate(parseSpec(fakeIt.completion_check), builtinRegistry(), fakeIt, 1);
    expect(gate.kind).toBe('cheap_fail');
    const out = renderTasksBlock(fakeTasks([
      { id: fakeIt.id, description: fakeIt.description, iteration_count: 0, gate, blockedBy: null, source: 'plan_step' },
    ]));
    expect(out).toMatch(/gate NOT MET/);
    expect(out).toMatch(/never-existed\.md/);
  });
});
