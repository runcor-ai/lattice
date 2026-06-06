import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { builtinRegistry, runDeterministicHooks } from './completion-check.js';
import { PLAN_MIN_BYTES, planItemDescription, planItemGateSpec, planRelPath } from './plan-gate.js';
import type { Item } from './types.js';

function fakeItem(): Item {
  return {
    id: 'i', job_id: 'j', ordinal: 0, description: 'x', state: 'open', iteration_count: 0,
    completion_check: '{}', passed_at_cycle: null, deferred_at_cycle: null,
    defer_reason: null, unblock_condition: null, unblock_test: null, source: 'system', blocked_by: null,
  };
}

describe('plan gate builder (Item 4)', () => {
  it('planRelPath uses the .ai/notes/plans/<job>.md convention', () => {
    expect(planRelPath('job-123')).toBe('.ai/notes/plans/job-123.md');
  });

  it('gate spec is file_exists(minBytes) AND content_contains(checkbox)', () => {
    const spec = planItemGateSpec('/abs/plan.md');
    expect(spec.hooks.map((h) => h.name)).toEqual(['file_exists', 'content_contains']);
    expect(spec.hooks[0]!.args).toMatchObject({ path: '/abs/plan.md', minBytes: PLAN_MIN_BYTES });
    expect(spec.hooks[1]!.args).toMatchObject({ path: '/abs/plan.md', isRegex: true });
  });

  it('description names the path and the checkbox requirement', () => {
    const d = planItemDescription('.ai/notes/plans/x.md');
    expect(d).toContain('.ai/notes/plans/x.md');
    expect(d).toContain('- [ ]');
  });
});

describe('plan gate evaluation (Item 4)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plan-gate-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fails until a >=500-byte file WITH a checkbox exists, then passes', async () => {
    const p = join(dir, 'plan.md');
    const reg = builtinRegistry();
    const spec = planItemGateSpec(p);
    const ctx = { item: fakeItem(), cycle: 1 };

    // no file
    expect((await runDeterministicHooks(spec, reg, ctx)).result).toBe('failed');
    // checkbox present but too small (< 500 bytes) → fails on minBytes
    writeFileSync(p, '- [ ] x');
    expect((await runDeterministicHooks(spec, reg, ctx)).result).toBe('failed');
    // big enough but NO checkbox → fails on content
    writeFileSync(p, 'x'.repeat(600));
    expect((await runDeterministicHooks(spec, reg, ctx)).result).toBe('failed');
    // big AND has a checkbox → passes
    writeFileSync(p, `# Plan\n\n${'- [ ] a concrete step\n'.repeat(50)}`);
    expect((await runDeterministicHooks(spec, reg, ctx)).result).toBe('passed');
  });
});
