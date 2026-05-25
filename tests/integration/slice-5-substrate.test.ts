import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEchoSense, makeNoopAction } from '@runcor/capabilities';
import { StubBackend, type ModelCallRequest, type ModelCallResult } from '@runcor/engine';
import { Lattice } from '@runcor/runtime';
import { CANONICAL_LAWS_BLOCK } from '@runcor/substrate';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { rppDecision } from '../helpers/rpp.js';

/**
 * Slice 5 — substrate integration. Asserts the runtime really
 * wraps every model call's prompt with the eleven laws at the top
 * and that the judge phase records substrate findings to the trace.
 */
describe('Slice 5 — substrate wired into runtime cycle', () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-slice5-'));
    sqlitePath = join(dir, 'entity.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('ground wraps the prompt: laws block sits at the TOP', async () => {
    let lastPrompt = '';
    const captureBackend = {
      name: 'capture',
      async call(req: ModelCallRequest): Promise<ModelCallResult> {
        lastPrompt = req.prompt;
        return {
          text: rppDecision('Observed: no relevant memory. No action proposed.'),
          usage: { input: 0, output: 0 },
          modelUsed: 'capture',
          finishReason: 'stop' as const,
        };
      },
      estimateCost: () => ({ unit: 'tokens' as const, amount: 0, confidence: 'low' as const }),
    };

    const lattice = new Lattice({
      identity: { composed_body: 'I am a slice-5 test lattice.' },
      engine: captureBackend,
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    await lattice.runOnce();
    expect(lastPrompt.startsWith(CANONICAL_LAWS_BLOCK)).toBe(true);
    lattice.close();
  });

  it('judge records substrate findings to the trace on a known-bad output', async () => {
    // A backend whose canned output BLOCKS the substrate (Standing law).
    const badBackend = new StubBackend({
      responder: () => rppDecision('I instruct the other lattice to do the work.'),
    });
    const lattice = new Lattice({
      identity: { composed_body: 'I am the test entity.' },
      engine: badBackend,
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
      autonomy: 'medium',
    });
    await lattice.runOnce();
    const substrate = lattice.trace.filter((e) => e.kind === 'substrate');
    // At least one block (Standing) + one wait_operator overall entry.
    expect(substrate.some((e) => (e as any).law === 'Standing')).toBe(true);
    expect(substrate.some((e) => (e as any).reason?.includes('await operator'))).toBe(true);
    lattice.close();
  });

  it('autonomy=high self-corrects (writes a retry-decide trace entry)', async () => {
    const badBackend = new StubBackend({
      responder: () => rppDecision('I instruct the other lattice to do the work.'),
    });
    const lattice = new Lattice({
      identity: { composed_body: 'high-autonomy test' },
      engine: badBackend,
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
      autonomy: 'high',
    });
    await lattice.runOnce();
    const substrate = lattice.trace.filter((e) => e.kind === 'substrate');
    expect(substrate.some((e) => (e as any).reason?.includes('auto-retry'))).toBe(true);
    lattice.close();
  });

  it('clean output passes through — no substrate trace entries beyond the per-law warnings', async () => {
    const cleanBackend = new StubBackend({
      responder: () => rppDecision('Observed: no relevant memory. No action proposed.'),
    });
    const lattice = new Lattice({
      identity: { composed_body: 'clean test' },
      engine: cleanBackend,
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    await lattice.runOnce();
    const substrate = lattice.trace.filter((e) => e.kind === 'substrate');
    // A clean output produces zero substrate trace entries (all
    // findings pass; no overall resolution to log).
    expect(substrate).toHaveLength(0);
    lattice.close();
  });

  it('the SQLite trace table also records substrate rows (data-model §8)', async () => {
    const badBackend = new StubBackend({
      responder: () => rppDecision('I instruct the other lattice to do the work.'),
    });
    const lattice = new Lattice({
      identity: { composed_body: 'sqlite trace test' },
      engine: badBackend,
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    await lattice.runOnce();
    const rows = lattice
      .dbHandle()
      .prepare(`SELECT COUNT(*) AS n FROM trace WHERE kind = 'substrate'`)
      .get() as { n: number };
    expect(rows.n).toBeGreaterThan(0);
    lattice.close();
  });
});
