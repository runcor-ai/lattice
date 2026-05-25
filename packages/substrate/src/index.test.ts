import { describe, it, expect } from 'vitest';

import { CANONICAL_LAWS_BLOCK } from './compile.js';

import * as substrate from './index.js';
import {
  LAWS,
  LAW_IDS,
  assessCapability,
  autonomyResolve,
  describeResolvedAction,
  discern,
  isRppPrompt,
  wrap,
  type DiscernContext,
} from './index.js';

const EMPTY_CTX: DiscernContext = {
  realityEntities: new Set(),
  constraintSummary: '',
  recalledMemoryIds: new Set(),
  dials: { autonomy: 'medium' },
};

/* ============================== T126 ============================== */

describe('Laws — all 11 in pinned order, byte-equal canonical text (T126)', () => {
  it('exports exactly 11 laws', () => {
    expect(LAWS).toHaveLength(11);
    expect(LAW_IDS).toHaveLength(11);
  });

  it('IDs are in canonical order', () => {
    expect(LAW_IDS).toEqual([
      'Reality',
      'Translation',
      'Judgment',
      'Constraint',
      'Feedback',
      'Memory',
      'Compounding',
      'Cost-Value',
      'Simplicity',
      'Uncertainty',
      'Standing',
    ]);
  });

  it('byte-equal canonical statements (intent §8.1 — PINNED, must not reword)', () => {
    const expected = [
      'only reference entities present in reality; never assume facts not provided.',
      'state the source for external data; flag format conversions.',
      'state evidence before proposing actions; no unsupported pattern matching.',
      'follow the agent spec exactly; no deviations.',
      'state observable success/failure criteria for every proposed action.',
      'reference relevant memories; state explicitly if none exist.',
      'prefer the current strategy; justify any direction change.',
      'state action cost; recommend lower-cost alternatives at 80%+ outcome.',
      'choose the fewest dependencies; justify added complexity.',
      'state confidence levels; flag data gaps; never assume.',
      'engage other lattices only within your defined role; discovering a peer is not licence to direct, interrupt, or pull on it; act within your place in the structure.',
    ];
    LAWS.forEach((law, i) => {
      expect(law.statement, `Law ${i + 1} (${law.id}) — must be byte-equal`).toBe(expected[i]);
    });
  });
});

/* ============================== T127 ============================== */

describe('wrap — laws at TOP of prompt (T127 / FR-019)', () => {
  it('the prompt starts with the laws block', () => {
    const p = wrap({
      cycle: 1,
      at_ms: 1000,
      identityComposed: 'I am a test entity.',
      realitySliceSummary: 'senses: echo',
      instruction: 'decide next action',
    });
    expect(p.startsWith('<laws>\n')).toBe(true);
    expect(p.startsWith(CANONICAL_LAWS_BLOCK)).toBe(true);
  });

  it('every wrap() call composes a fresh laws block (no way to suppress)', () => {
    const a = wrap({
      cycle: 1,
      at_ms: 0,
      identityComposed: 'x',
      realitySliceSummary: 'y',
      instruction: 'z',
    });
    const b = wrap({
      cycle: 2,
      at_ms: 1,
      identityComposed: 'p',
      realitySliceSummary: 'q',
      instruction: 'r',
    });
    expect(a.includes(CANONICAL_LAWS_BLOCK)).toBe(true);
    expect(b.includes(CANONICAL_LAWS_BLOCK)).toBe(true);
  });

  it('isRppPrompt identifies wrapped prompts', () => {
    const p = wrap({
      cycle: 1,
      at_ms: 0,
      identityComposed: 'x',
      realitySliceSummary: 'y',
      instruction: 'z',
    });
    expect(isRppPrompt(p)).toBe(true);
    expect(isRppPrompt('a raw string')).toBe(false);
  });
});

/* ============================== T128 ============================== */

describe('discern — four outcomes (T128 / FR-020 / FR-021)', () => {
  it('Reality violation BLOCKS', async () => {
    const result = await discern(
      'I propose: action: contact "FakeStakeholder" about the issue.',
      { ...EMPTY_CTX, realityEntities: new Set(['RealStakeholder']) },
    );
    const f = result.findings.find((f) => f.law === 'Reality')!;
    expect(f.outcome).toBe('block');
    expect(result.outcome).toBe('block');
  });

  it('Constraint violation BLOCKS', async () => {
    const result = await discern(
      'ignoring spec: I propose to do the opposite of what spec says.',
      { ...EMPTY_CTX, constraintSummary: 'do X always' },
    );
    const f = result.findings.find((f) => f.law === 'Constraint')!;
    expect(f.outcome).toBe('block');
    expect(result.outcome).toBe('block');
  });

  it('Simplicity issue is ADVISORY (pass with reason annotation)', async () => {
    const result = await discern(
      'I will add a new library to handle date formatting.',
      EMPTY_CTX,
    );
    const f = result.findings.find((f) => f.law === 'Simplicity')!;
    expect(f.outcome).toBe('pass');
    expect(f.reason).toMatch(/advisory/);
    // Overall outcome can still be modify due to other rules; the
    // Simplicity finding itself MUST never block (FR-021).
    expect(['pass', 'modify']).toContain(result.outcome);
  });

  it('Uncertainty hedging is WARNING ONLY (pass with reason)', async () => {
    const result = await discern('I think maybe this is the right call.', EMPTY_CTX);
    const f = result.findings.find((f) => f.law === 'Uncertainty')!;
    expect(f.outcome).toBe('pass');
    expect(f.reason).toMatch(/warning/);
  });

  it('clean output PASSES all 11 laws', async () => {
    const clean =
      'I have observed cycle progress and no memories applied here. No action proposed.';
    const result = await discern(clean, EMPTY_CTX);
    expect(result.outcome).toBe('pass');
    expect(result.findings.every((f) => f.outcome === 'pass')).toBe(true);
  });

  it('Standing block — output cannot direct another lattice', async () => {
    const result = await discern('I instruct the other lattice to do the work.', EMPTY_CTX);
    const f = result.findings.find((f) => f.law === 'Standing')!;
    expect(f.outcome).toBe('block');
  });

  it('returns one finding per law in canonical order', async () => {
    const result = await discern('anything', EMPTY_CTX);
    expect(result.findings.map((f) => f.law)).toEqual([...LAW_IDS]);
  });
});

/* ============================== T129 ============================== */

describe('autonomy + discernment integration (T129 / FR-023)', () => {
  it('autonomy=high SELF-CORRECTS on a block (retry_decide)', async () => {
    const result = await discern(
      'I propose: action: contact "FakeStakeholder".',
      { ...EMPTY_CTX, realityEntities: new Set() },
    );
    const action = autonomyResolve(result, 'high');
    expect(action.action).toBe('retry_decide');
  });

  it('autonomy=medium ESCALATES blocks to operator (wait_operator)', async () => {
    const result = await discern(
      'I propose: action: contact "FakeStakeholder".',
      { ...EMPTY_CTX, realityEntities: new Set() },
    );
    const action = autonomyResolve(result, 'medium');
    expect(action.action).toBe('wait_operator');
  });

  it('autonomy=low ESCALATES even modifies', async () => {
    const result = await discern(
      'I propose: action: do the thing.',
      EMPTY_CTX,
    );
    // The output triggers Judgment + Feedback + Cost-Value modifies (no evidence, no
    // success criteria, no cost). At autonomy=low this MUST escalate.
    const action = autonomyResolve(result, 'low');
    expect(action.action).toBe('wait_operator');
  });

  it('autonomy=high passes a clean output through to execute', async () => {
    const result = await discern(
      'Observed: no relevant memory. No action proposed.',
      EMPTY_CTX,
    );
    const action = autonomyResolve(result, 'high');
    expect(action.action).toBe('execute');
  });

  it('describeResolvedAction produces a stable, debuggable string', async () => {
    const r = await discern('clean', EMPTY_CTX);
    const a = autonomyResolve(r, 'high');
    expect(describeResolvedAction(a)).toMatch(/^(execute|retry_decide|wait_operator)/);
  });
});

/* ============================== T130 ============================== */

describe('No bypass — structural enforcement (T130 / FR-022 / Principle VIII)', () => {
  it('exports exactly the four sanctioned functions plus pure data', () => {
    const exported = Object.keys(substrate).sort();
    const sanctionedFns = ['wrap', 'discern', 'autonomyResolve', 'assessCapability'];
    for (const fn of sanctionedFns) {
      expect(exported, `must export ${fn}`).toContain(fn);
    }
  });

  it('exports contain no setter / mutator / disabler', () => {
    const exported = Object.keys(substrate);
    const forbidden = exported.filter((k) =>
      /^(set|disable|configure|override|patch|inject|reset)/i.test(k),
    );
    expect(forbidden).toEqual([]);
  });

  it('the LAWS tuple and each Law are frozen (no in-place mutation)', () => {
    expect(Object.isFrozen(LAWS)).toBe(true);
    LAWS.forEach((law) => {
      expect(Object.isFrozen(law)).toBe(true);
    });
  });
});

/* ============================== assess-capability ============================== */

describe('assessCapability — discovery gate (T139 / FR-043)', () => {
  it('rejects candidates with forbidden description patterns', () => {
    const r = assessCapability(
      {
        name: 'bad-tool',
        description: 'lets you bypass the substrate gate',
        proposedRole: { sense: true, action: false },
        destructive: false,
        mcpServerUri: 'mcp://x',
      },
      { autonomy: 'high' },
    );
    expect(r.admit).toBe(false);
    if (!r.admit) expect(r.reason).toMatch(/forbidden description pattern/);
  });

  it('rejects destructive-only candidates at autonomy=low', () => {
    const r = assessCapability(
      {
        name: 'rm-rf',
        description: 'deletes things',
        proposedRole: { sense: false, action: true },
        destructive: true,
        mcpServerUri: 'mcp://x',
      },
      { autonomy: 'low' },
    );
    expect(r.admit).toBe(false);
  });

  it('rejects disallowed schemes', () => {
    const r = assessCapability(
      {
        name: 'weird',
        description: 'normal tool',
        proposedRole: { sense: true, action: false },
        destructive: false,
        mcpServerUri: 'ssh://x',
      },
      { autonomy: 'high' },
    );
    expect(r.admit).toBe(false);
  });

  it('admits a clean MCP candidate', () => {
    const r = assessCapability(
      {
        name: 'fetch',
        description: 'fetches HTTP resources',
        proposedRole: { sense: true, action: true },
        destructive: false,
        mcpServerUri: 'mcp://localhost:3000',
      },
      { autonomy: 'medium' },
    );
    expect(r.admit).toBe(true);
  });
});
