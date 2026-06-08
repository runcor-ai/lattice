import type { TraceRow } from '@runcor/bridge-shared';
import { describe, it, expect } from 'vitest';


import { deriveFrames, deriveFrameMap, itemsAfter } from './frameModel.js';

let nextId = 1;
function row(partial: Partial<TraceRow> & { cycle: number; kind: TraceRow['kind'] }): TraceRow {
  return { id: nextId++, at_ms: partial.cycle * 1000, ...partial } as TraceRow;
}

/** Eight ordinary phase rows for one cycle, with the given decided action + act result. */
function cyclePhases(cycle: number, action: string, actResult: 'ok' | 'failed' = 'ok'): TraceRow[] {
  return [
    row({ cycle, kind: 'phase', phase: 'observe', result: 'ok', output_summary: 'senses=2' }),
    row({ cycle, kind: 'phase', phase: 'ground', result: 'ok', output_summary: 'prompt_bytes=900' }),
    row({ cycle, kind: 'phase', phase: 'recall', result: 'ok', output_summary: 'memories=3' }),
    row({ cycle, kind: 'phase', phase: 'decide', result: 'ok', output_summary: `action=${action};blocks=1`, duration_ms: 50 }),
    row({ cycle, kind: 'phase', phase: 'act', result: actResult, output_summary: `result=${actResult}` }),
    row({ cycle, kind: 'phase', phase: 'judge', result: 'ok', output_summary: 'judgement=pass' }),
    row({ cycle, kind: 'phase', phase: 'write', result: 'ok', output_summary: 'writes=1' }),
    row({ cycle, kind: 'phase', phase: 'pulse', result: 'ok', output_summary: 'continue=true' }),
  ];
}

describe('deriveFrames — basic per-cycle shape', () => {
  it('produces one frame per cycle with all eight phase slices', () => {
    const rows = [...cyclePhases(1, 'fs-read-content'), ...cyclePhases(2, 'fs-write')];
    const frames = deriveFrames(rows);
    expect(frames.map((f) => f.cycle)).toEqual([1, 2]);
    expect(frames[0].phases.map((p) => p.phase)).toEqual([
      'observe', 'ground', 'recall', 'decide', 'act', 'judge', 'write', 'pulse',
    ]);
    expect(frames[0].phases.every((p) => p.status === 'ok')).toBe(true);
    expect(frames[0].components.decide.action).toBe('fs-read-content');
    expect(frames[0].components.dispatch.action).toBe('fs-read-content');
    expect(frames[0].components.dispatch.result).toBe('ok');
    expect(frames[0].components.senses.count).toBe(2);
    expect(frames[0].components.memory.writes).toBe(1);
  });

  it('a missing phase renders as skipped, not active', () => {
    const rows = cyclePhases(1, 'noop').filter((r) => r.phase !== 'judge');
    const frame = deriveFrames(rows)[0];
    expect(frame.phases.find((p) => p.phase === 'judge')!.status).toBe('skipped');
  });
});

describe('deriveFrames — state transitions are distinct (SC-002)', () => {
  it('an item pass yields item-passed + gate-pass transitions and flips the item', () => {
    const rows = [
      ...cyclePhases(1, 'fs-write'),
      row({ cycle: 1, kind: 'subconscious', rule: 'auto-attempt-deterministic', memory_id: 'item-abc', now: 'item item-abc… passed: write readme' }),
    ];
    const frame = deriveFrames(rows)[0];
    expect(frame.transitions.map((t) => t.kind).sort()).toEqual(['gate-pass', 'item-passed']);
    const item = frame.components.items.find((i) => i.id === 'item-abc');
    expect(item?.state).toBe('passed');
    expect(item?.changedThisCycle).toBe(true);
  });

  it('a substrate block sets dispatch.blockedBy and emits substrate-fired', () => {
    const rows = [
      ...cyclePhases(1, 'workspace', 'failed'),
      row({ cycle: 1, kind: 'substrate', phase: 'act', law: 'no-progress', outcome: 'block', reason: 'stalled' }),
    ];
    const frame = deriveFrames(rows)[0];
    expect(frame.components.dispatch.blockedBy).toBe('no-progress');
    expect(frame.components.dispatch.status).toBe('blocked');
    expect(frame.transitions.some((t) => t.kind === 'substrate-fired')).toBe(true);
  });

  it('a delegate-named action emits a delegation transition and sets delegate', () => {
    const rows = cyclePhases(1, 'claude-delegate');
    const frame = deriveFrames(rows, { delegateNames: new Set(['claude-delegate']) })[0];
    expect(frame.components.delegate).not.toBeNull();
    expect(frame.transitions.some((t) => t.kind === 'delegation')).toBe(true);
  });
});

describe('deriveFrames — the legibility bar (stuck-loop run, SC-001)', () => {
  it('a 56-cycle workspace loop shows repeated action, no item transitions, no delegations', () => {
    const rows: TraceRow[] = [];
    for (let c = 1; c <= 56; c++) {
      rows.push(...cyclePhases(c, 'workspace', 'failed'));
      // The substrate keeps blocking the same stalled action.
      rows.push(row({ cycle: c, kind: 'substrate', phase: 'act', law: 'persistence', outcome: 'block', reason: 'identical inputs' }));
    }
    const frames = deriveFrames(rows, { delegateNames: new Set(['claude-delegate']) });

    expect(frames).toHaveLength(56);
    // Same dominant action every cycle.
    expect(frames.every((f) => f.components.dispatch.action === 'workspace')).toBe(true);
    // No item ever moved.
    expect(frames.every((f) => f.components.items.length === 0)).toBe(true);
    expect(frames.every((f) => !f.transitions.some((t) => t.kind === 'item-passed'))).toBe(true);
    // Never delegated.
    expect(frames.every((f) => f.components.delegate === null)).toBe(true);
    // Every cycle was blocked.
    expect(frames.every((f) => f.components.dispatch.status === 'blocked')).toBe(true);
  });
});

describe('deriveFrames — checkpoint reconstruction', () => {
  it('initialItems carries item state into a later window', () => {
    const passed = [
      { id: 'item-x', label: 'done', state: 'passed' as const, changedThisCycle: false },
    ];
    const frames = deriveFrames(cyclePhases(40, 'noop'), { initialItems: passed });
    expect(frames[0].components.items.find((i) => i.id === 'item-x')?.state).toBe('passed');
    // And it is NOT flagged as changed this cycle (it changed in an earlier window).
    expect(frames[0].components.items.find((i) => i.id === 'item-x')?.changedThisCycle).toBe(false);
  });

  it('itemsAfter snapshots end-of-window item state with flags cleared', () => {
    const rows = [
      ...cyclePhases(1, 'fs-write'),
      row({ cycle: 1, kind: 'subconscious', rule: 'auto-attempt-deterministic', memory_id: 'item-1', now: 'passed' }),
    ];
    const snap = itemsAfter(deriveFrames(rows));
    expect(snap).toEqual([{ id: 'item-1', label: 'passed', state: 'passed', changedThisCycle: false }]);
  });
});

describe('deriveFrameMap', () => {
  it('indexes frames by cycle', () => {
    const map = deriveFrameMap([...cyclePhases(5, 'noop'), ...cyclePhases(6, 'noop')]);
    expect([...map.keys()].sort((a, b) => a - b)).toEqual([5, 6]);
    expect(map.get(5)!.cycle).toBe(5);
  });
});
