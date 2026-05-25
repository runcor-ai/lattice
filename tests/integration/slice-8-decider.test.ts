import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEchoSense, makeNoopAction } from '@runcor/capabilities';
import { isValidR } from '@runcor/decider';
import { DialecticDecider } from '@runcor/dialectic';
import { StubBackend } from '@runcor/engine';
import { Lattice } from '@runcor/runtime';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Slice 8 — decider integration with the live cycle.
 *
 * Default: SingleModelDecider. With dialecticDepth=1: DialecticDecider.
 * Both produce a parser-validated R++ output that the judge phase
 * evaluates via the substrate.
 */
describe('Slice 8 — decider wired into the cycle', () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-slice8-'));
    sqlitePath = join(dir, 'entity.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('cycle uses SingleModelDecider by default and parses R++', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'slice-8 default' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    expect(lattice.decider.name).toBe('single-model');
    const r = await lattice.runOnce();
    expect(r.outcome).toBe('completed');
    lattice.close();
  });

  it('dialecticDepth=1 switches to DialecticDecider; produces 3 internal calls per cycle', async () => {
    let callCount = 0;
    const engine = new StubBackend({
      responder: () => {
        callCount += 1;
        return 'TARGET { output: "x" }';
      },
    });
    const lattice = new Lattice({
      identity: { composed_body: 'slice-8 dialectic' },
      engine,
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
      dialecticDepth: 1,
    });
    expect(lattice.decider.name).toBe('dialectic');
    await lattice.runOnce();
    expect(callCount).toBe(3); // Player + Coach + Judge
    lattice.close();
  });

  it('a decider explicitly injected via opts.decider takes precedence', async () => {
    const { parse } = await import('@runcor/rpp-parser');
    const lattice = new Lattice({
      identity: { composed_body: 'slice-8 inject' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
      decider: {
        name: 'test-decider',
        async decide() {
          return {
            output: parse('TARGET { output: "injected" }'),
            usage: { input: 0, output: 0 },
            reasoning: 'injected-test',
          };
        },
      },
    });
    expect(lattice.decider.name).toBe('test-decider');
    await lattice.runOnce();
    lattice.close();
  });

  it('a decider that returns invalid R++ surfaces as a failed cycle', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'slice-8 fail' },
      engine: new StubBackend({ responder: () => 'this is not r++' }),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    const r = await lattice.runOnce();
    expect(r.outcome).toBe('failed');
    expect(r.failedAt).toBe('decide');
    expect(r.failedReason).toMatch(/parse/);
    lattice.close();
  });
});

/* ============================== T167 ============================== */

describe('R++ everywhere — engine signature is RppPrompt-typed (T167)', () => {
  it('isValidR returns true for the default stub backend output', async () => {
    const engine = new StubBackend();
    const r = await engine.call({
      prompt: 'TARGET { output: "noop" }\n' as never,
    });
    const { parse } = await import('@runcor/rpp-parser');
    const parsed = parse(r.text);
    expect(isValidR(parsed)).toBe(true);
  });
});
