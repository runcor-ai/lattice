import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { Trace } from './trace.js';
import type { PhaseTraceEntry } from './types.js';

describe('Trace', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-trace-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes JSONL one entry per line', () => {
    const path = join(dir, 'trace.jsonl');
    const trace = new Trace({ jsonlPath: path });

    const e1: PhaseTraceEntry = {
      kind: 'phase',
      cycle: 1,
      at_ms: 1_000,
      phase: 'observe',
      duration_ms: 5,
      result: 'ok',
    };
    const e2: PhaseTraceEntry = {
      kind: 'phase',
      cycle: 1,
      at_ms: 1_005,
      phase: 'ground',
      duration_ms: 7,
      result: 'ok',
    };

    trace.write(e1);
    trace.write(e2);

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(e1);
    expect(JSON.parse(lines[1]!)).toEqual(e2);
  });

  it('keeps an in-memory buffer queryable for tests', () => {
    const trace = new Trace({ jsonlPath: null });
    trace.write({ kind: 'phase', cycle: 1, at_ms: 0, phase: 'observe', duration_ms: 1, result: 'ok' });
    trace.write({ kind: 'phase', cycle: 1, at_ms: 1, phase: 'ground', duration_ms: 1, result: 'ok' });

    expect(trace.size()).toBe(2);
    const phases = trace.filter((e) => e.kind === 'phase');
    expect(phases).toHaveLength(2);
  });

  it('notifies subscribers on every write', () => {
    const trace = new Trace({ jsonlPath: null });
    const seen: string[] = [];
    const unsubscribe = trace.subscribe((e) => {
      if (e.kind === 'phase') seen.push(e.phase);
    });

    trace.write({ kind: 'phase', cycle: 1, at_ms: 0, phase: 'observe', duration_ms: 1, result: 'ok' });
    trace.write({ kind: 'phase', cycle: 1, at_ms: 1, phase: 'decide', duration_ms: 1, result: 'ok' });

    expect(seen).toEqual(['observe', 'decide']);

    unsubscribe();
    trace.write({ kind: 'phase', cycle: 1, at_ms: 2, phase: 'act', duration_ms: 1, result: 'ok' });
    expect(seen).toEqual(['observe', 'decide']);
  });

  it('survives a throwing subscriber', () => {
    const trace = new Trace({ jsonlPath: null });
    trace.subscribe(() => {
      throw new Error('boom');
    });
    expect(() =>
      trace.write({ kind: 'phase', cycle: 1, at_ms: 0, phase: 'observe', duration_ms: 1, result: 'ok' }),
    ).not.toThrow();
    expect(trace.size()).toBe(1);
  });
});
