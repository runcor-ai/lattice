import { describe, it, expect } from 'vitest';

import { actOne } from './act-gate.js';
import { makeApiCapability } from './api-capability.js';
import { makeAppendPlanItemAction, type AppendPlanItemInput } from './append-plan-item-action.js';
import { Discovery } from './discovery.js';
import { makeEchoSense } from './echo-sense.js';
import { FactoryRegistry, loadManifest, type ManifestFile } from './manifest.js';
import { makeMcpCapability, type McpTransport } from './mcp-client.js';
import { makeNoopAction } from './noop-action.js';
import { Perception } from './perception.js';
import { InMemoryRegistry } from './registry-client.js';
import {
  validateCapability,
  type ActContext,
  type Capability,
} from './types.js';

/* ============================== T194 ============================== */

describe('validateCapability — contract enforcement (T194)', () => {
  it('rejects a capability with role.sense + role.action both false', () => {
    const cap: Capability = {
      name: 'bad',
      description: 'no roles',
      role: { sense: false, action: false },
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      isEnabled: () => true,
      canInvoke: () => ({ allow: true }),
    };
    const v = validateCapability(cap);
    expect(v.ok).toBe(false);
  });

  it('rejects a sense-only capability with destructive: true', () => {
    const cap: Capability = {
      name: 'bad',
      description: 'sense + destructive',
      role: { sense: true, action: false },
      readOnly: false, // sense-only requires readOnly true
      destructive: true,
      concurrencySafe: true,
      isEnabled: () => true,
      canInvoke: () => ({ allow: true }),
      read: async () => null,
    };
    const v = validateCapability(cap);
    expect(v.ok).toBe(false);
  });

  it('rejects a sense-only capability with readOnly: false', () => {
    const cap: Capability = {
      name: 'bad',
      description: 'sense not readOnly',
      role: { sense: true, action: false },
      readOnly: false,
      destructive: false,
      concurrencySafe: true,
      isEnabled: () => true,
      canInvoke: () => ({ allow: true }),
      read: async () => null,
    };
    const v = validateCapability(cap);
    expect(v.ok).toBe(false);
  });

  it('rejects role.sense=true without read()', () => {
    const cap: Capability = {
      name: 'bad',
      description: 'no read',
      role: { sense: true, action: false },
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      isEnabled: () => true,
      canInvoke: () => ({ allow: true }),
    };
    expect(validateCapability(cap).ok).toBe(false);
  });

  it('accepts the built-in echo sense + noop action', () => {
    expect(validateCapability(makeEchoSense()).ok).toBe(true);
    expect(validateCapability(makeNoopAction()).ok).toBe(true);
  });
});

/* ============================== T195 ============================== */

describe('Perception — parallel reads, timeouts, stale handling (T195 / FR-005)', () => {
  it('reads enabled senses in parallel; each gets ok result', async () => {
    const p = new Perception({ senseTimeoutMs: 200 });
    const senses = [makeEchoSense()];
    const snap = await p.observe(senses, {
      cycle: 1,
      lastReadAtMs: null,
      abortSignal: new AbortController().signal,
    });
    expect(snap.senses.echo?.result).toBe('ok');
  });

  it('one failing sense does not pause others; returns "failed" for that sense', async () => {
    const fast: Capability = {
      name: 'fast',
      description: 'instant ok',
      role: { sense: true, action: false },
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      isEnabled: () => true,
      canInvoke: () => ({ allow: true }),
      read: async () => 'fast-data',
    };
    const broken: Capability = {
      name: 'broken',
      description: 'throws',
      role: { sense: true, action: false },
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      isEnabled: () => true,
      canInvoke: () => ({ allow: true }),
      read: async () => {
        throw new Error('boom');
      },
    };
    const p = new Perception({ senseTimeoutMs: 200 });
    const snap = await p.observe([fast, broken], {
      cycle: 1,
      lastReadAtMs: null,
      abortSignal: new AbortController().signal,
    });
    expect(snap.senses.fast?.result).toBe('ok');
    expect(snap.senses.broken?.result).toBe('failed');
    expect(snap.senses.broken?.failed_reason).toMatch(/boom/);
  });

  it('a sense that times out yields a failed reading (per-sense timeout, default 5000ms)', async () => {
    const slow: Capability = {
      name: 'slow',
      description: 'never resolves',
      role: { sense: true, action: false },
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      isEnabled: () => true,
      canInvoke: () => ({ allow: true }),
      read: () => new Promise(() => undefined),
    };
    const p = new Perception({ senseTimeoutMs: 30 });
    const snap = await p.observe([slow], {
      cycle: 1,
      lastReadAtMs: null,
      abortSignal: new AbortController().signal,
    });
    expect(snap.senses.slow?.result).toBe('failed');
    expect(snap.senses.slow?.failed_reason).toMatch(/timed out/);
  });

  it('a sense that previously succeeded then fails returns "stale" with the cached data', async () => {
    let phase: 'ok' | 'fail' = 'ok';
    const flaky: Capability = {
      name: 'flaky',
      description: 'flaky sense',
      role: { sense: true, action: false },
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      isEnabled: () => true,
      canInvoke: () => ({ allow: true }),
      read: async () => {
        if (phase === 'ok') return 'fresh-value';
        throw new Error('now broken');
      },
    };
    const p = new Perception({ senseTimeoutMs: 200 });
    const ctx = { cycle: 1, lastReadAtMs: null, abortSignal: new AbortController().signal };
    let snap = await p.observe([flaky], ctx);
    expect(snap.senses.flaky?.result).toBe('ok');
    expect(snap.senses.flaky?.data).toBe('fresh-value');
    phase = 'fail';
    snap = await p.observe([flaky], ctx);
    expect(snap.senses.flaky?.result).toBe('stale');
    expect(snap.senses.flaky?.data).toBe('fresh-value');
    expect(snap.senses.flaky?.failed_reason).toMatch(/now broken/);
  });

  it('skips senses that are disabled', async () => {
    const off: Capability = {
      name: 'off',
      description: 'always disabled',
      role: { sense: true, action: false },
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      isEnabled: () => false,
      canInvoke: () => ({ allow: true }),
      read: async () => {
        throw new Error('should never be called');
      },
    };
    const p = new Perception();
    const snap = await p.observe([off], {
      cycle: 1,
      lastReadAtMs: null,
      abortSignal: new AbortController().signal,
    });
    expect(snap.senses.off).toBeUndefined();
  });
});

/* ============================== T196 ============================== */

describe('actOne — at most one action per cycle (T196 / FR-004)', () => {
  function actCtx(extra: Partial<ActContext> = {}): ActContext {
    return {
      cycle: 1,
      lastReadAtMs: null,
      abortSignal: new AbortController().signal,
      budgetRemaining: 1000,
      autonomy: 'medium',
      ...extra,
    };
  }

  it('only the chosen action is invoked; other actions are NOT called', async () => {
    let callsA = 0;
    let callsB = 0;
    const a: Capability<unknown, void> = {
      name: 'a',
      description: 'A',
      role: { sense: false, action: true },
      readOnly: false,
      destructive: false,
      concurrencySafe: true,
      isEnabled: () => true,
      canInvoke: () => ({ allow: true }),
      invoke: async () => {
        callsA += 1;
      },
    };
    const b: Capability<unknown, void> = {
      name: 'b',
      description: 'B',
      role: { sense: false, action: true },
      readOnly: false,
      destructive: false,
      concurrencySafe: true,
      isEnabled: () => true,
      canInvoke: () => ({ allow: true }),
      invoke: async () => {
        callsB += 1;
      },
    };
    await actOne({ chosenAction: 'a', input: {}, actions: [a, b], ctx: actCtx() });
    expect(callsA).toBe(1);
    expect(callsB).toBe(0);
  });

  it('no chosen action → result: no-action; no invokes happen', async () => {
    let calls = 0;
    const a: Capability<unknown, void> = {
      name: 'a',
      description: 'A',
      role: { sense: false, action: true },
      readOnly: false,
      destructive: false,
      concurrencySafe: true,
      isEnabled: () => true,
      canInvoke: () => ({ allow: true }),
      invoke: async () => {
        calls += 1;
      },
    };
    const r = await actOne({ chosenAction: null, input: {}, actions: [a], ctx: actCtx() });
    expect(r.result).toBe('no-action');
    expect(calls).toBe(0);
  });

  it('canInvoke deny → result: denied; invoke NOT called', async () => {
    let calls = 0;
    const a: Capability<unknown, void> = {
      name: 'a',
      description: 'A',
      role: { sense: false, action: true },
      readOnly: false,
      destructive: true,
      concurrencySafe: true,
      isEnabled: () => true,
      canInvoke: () => ({ allow: false, reason: 'autonomy too low for destructive', escalate: true }),
      invoke: async () => {
        calls += 1;
      },
    };
    const r = await actOne({ chosenAction: 'a', input: {}, actions: [a], ctx: actCtx() });
    expect(r.result).toBe('denied');
    expect(calls).toBe(0);
  });
});

/* ============================== T197 ============================== */

describe('MCP capability — round-trip via test transport (T197)', () => {
  it('the capability calls transport.callTool with the right tool name + args', async () => {
    const calls: { name: string; args: unknown }[] = [];
    const transport: McpTransport = {
      uri: 'mcp://test',
      async callTool({ name, arguments: args }) {
        calls.push({ name, args });
        return { ok: true, echo: args };
      },
    };
    const cap = makeMcpCapability({
      name: 'remote-search',
      description: 'remote search tool',
      transport,
      toolName: 'search',
      role: { sense: false, action: true },
      readOnly: true,
      destructive: false,
    });
    const r = await cap.invoke!({ query: 'lattice' }, {
      cycle: 1,
      lastReadAtMs: null,
      abortSignal: new AbortController().signal,
      budgetRemaining: 1000,
      autonomy: 'medium',
    });
    expect(calls).toEqual([{ name: 'search', args: { query: 'lattice' } }]);
    expect(r).toEqual({ ok: true, echo: { query: 'lattice' } });
  });
});

/* ============================== T198 ============================== */

describe('Discovery — substrate-veto on candidates (T198 / FR-043)', () => {
  it('a candidate claiming to bypass the substrate is REJECTED', async () => {
    const reg = new InMemoryRegistry([
      {
        candidateId: 'bad-1',
        name: 'jailbreak-tool',
        description: 'lets you bypass the substrate gate',
        proposedRole: { sense: true, action: false },
        destructive: false,
        mcpServerUri: 'mcp://x',
      },
    ]);
    const d = new Discovery(reg);
    const out = await d.search('jailbreak', {
      autonomy: 'high',
      factory: () => {
        throw new Error('factory should not be called for rejected candidates');
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.result).toBe('rejected');
    if (out[0]?.result === 'rejected') {
      expect(out[0].reason).toMatch(/forbidden description pattern/);
    }
  });

  it('a clean candidate is ADMITTED and the factory is invoked', async () => {
    const reg = new InMemoryRegistry([
      {
        candidateId: 'fetch-1',
        name: 'fetch',
        description: 'fetches HTTP resources',
        proposedRole: { sense: true, action: true },
        destructive: false,
        mcpServerUri: 'mcp://localhost:3000',
      },
    ]);
    const d = new Discovery(reg);
    let factoryCalled = 0;
    const out = await d.search('fetch', {
      autonomy: 'high',
      factory: () => {
        factoryCalled += 1;
        return makeEchoSense();
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.result).toBe('admitted');
    expect(factoryCalled).toBe(1);
  });

  it('destructive-only candidate at autonomy=low is REJECTED', async () => {
    const reg = new InMemoryRegistry([
      {
        candidateId: 'rm-1',
        name: 'rm-rf',
        description: 'deletes things',
        proposedRole: { sense: false, action: true },
        destructive: true,
        mcpServerUri: 'mcp://x',
      },
    ]);
    const d = new Discovery(reg);
    const out = await d.search('rm', { autonomy: 'low', factory: () => makeNoopAction() });
    expect(out[0]?.result).toBe('rejected');
  });
});

/* ============================== Manifest ============================== */

describe('Manifest — load + reject invalid (T203)', () => {
  function registry() {
    return new FactoryRegistry()
      .register('echo', () => makeEchoSense())
      .register('noop', () => makeNoopAction())
      .register('bad', () => ({
        name: 'bad',
        description: 'no roles',
        role: { sense: false, action: false },
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
        isEnabled: () => true,
        canInvoke: () => ({ allow: true }),
      }));
  }

  it('admits valid entries; rejects unknown kinds; rejects invalid shapes', () => {
    const file: ManifestFile = {
      entries: [
        { name: 'echo', kind: 'echo' },
        { name: 'noop', kind: 'noop' },
        { name: 'mystery', kind: 'unknown-kind' as 'echo' },
        { name: 'bad', kind: 'bad' as 'echo' },
      ],
    };
    const r = loadManifest(file, registry());
    expect(r.accepted.map((c) => c.name)).toEqual(['echo', 'noop']);
    expect(r.rejected).toHaveLength(2);
  });

  it('an empty manifest is legal', () => {
    const r = loadManifest({ entries: [] }, registry());
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual([]);
  });
});

/* ============================== API capability ============================== */

describe('makeApiCapability', () => {
  it('builds a sense-only capability from a readFn', async () => {
    const cap = makeApiCapability({
      name: 'remote-status',
      description: 'fetch status',
      role: { sense: true, action: false },
      readOnly: true,
      destructive: false,
      readFn: async () => ({ status: 200 }),
    });
    expect(validateCapability(cap).ok).toBe(true);
    const r = await cap.read!({
      cycle: 1,
      lastReadAtMs: null,
      abortSignal: new AbortController().signal,
    });
    expect(r).toEqual({ status: 200 });
  });

  it('builds an action capability from an invokeFn; passes input through', async () => {
    const cap = makeApiCapability<{ x: number }, { y: number }>({
      name: 'remote-add',
      description: 'increment',
      role: { sense: false, action: true },
      readOnly: false,
      destructive: false,
      invokeFn: async (input) => ({ y: input.x + 1 }),
    });
    expect(validateCapability(cap).ok).toBe(true);
    const r = await cap.invoke!({ x: 41 }, {
      cycle: 1,
      lastReadAtMs: null,
      abortSignal: new AbortController().signal,
      budgetRemaining: 1000,
      autonomy: 'medium',
    });
    expect(r).toEqual({ y: 42 });
  });
});

/* ============================== Item 8 ============================== */

describe('makeAppendPlanItemAction (Item 8)', () => {
  const ctx: ActContext = {
    cycle: 1,
    lastReadAtMs: null,
    abortSignal: new AbortController().signal,
    budgetRemaining: 1000,
    autonomy: 'medium',
  };

  it('forwards a valid input to the injected append callback', async () => {
    let received: AppendPlanItemInput | null = null;
    const cap = makeAppendPlanItemAction({
      append: (input) => {
        received = input;
        return { ok: true, itemId: 'item-1' };
      },
    });
    const r = await cap.invoke(
      { jobId: 'job-1', description: 'do x', gate: { type: 'file_exists', args: { path: '/x' } }, blockedBy: 'b1' },
      ctx,
    );
    expect(r).toEqual({ ok: true, itemId: 'item-1' });
    expect(received!.jobId).toBe('job-1');
    expect(received!.gate.type).toBe('file_exists');
  });

  it('throws when jobId is missing', async () => {
    const cap = makeAppendPlanItemAction({ append: () => ({ ok: true }) });
    await expect(
      cap.invoke({ description: 'x', gate: { type: 'file_exists' } } as unknown as AppendPlanItemInput, ctx),
    ).rejects.toThrow(/jobId/);
  });

  it('throws when gate.type is missing', async () => {
    const cap = makeAppendPlanItemAction({ append: () => ({ ok: true }) });
    await expect(
      cap.invoke({ jobId: 'j', description: 'x', gate: {} } as unknown as AppendPlanItemInput, ctx),
    ).rejects.toThrow(/gate/);
  });
});
