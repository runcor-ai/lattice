import { describe, it, expect } from 'vitest';

import { actOne } from './act-gate.js';
import { makeApiCapability } from './api-capability.js';
import { makeAppendPlanItemAction, type AppendPlanItemInput } from './append-plan-item-action.js';
import { REGISTERED_HOOK_NAMES } from './gate-hook-names.js';
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

describe('makeAppendPlanItemAction (Item 8) — gate-schema self-correcting validator', () => {
  const ctx: ActContext = {
    cycle: 1,
    lastReadAtMs: null,
    abortSignal: new AbortController().signal,
    budgetRemaining: 1000,
    autonomy: 'medium',
  };

  // Helper that captures what the append callback was actually given.
  // `probe` is a stable reference; `probe.received` reads the latest value.
  function makeCap() {
    const probe: { received: AppendPlanItemInput | null } = { received: null };
    const cap = makeAppendPlanItemAction({
      append: (input) => {
        probe.received = input;
        return { ok: true, itemId: 'item-1' };
      },
    });
    return { cap, probe };
  }

  // Run the validator and capture the rejection message — most tests assert on
  // the contents of the self-correcting error rather than just throw/no-throw.
  async function rejectionMessage(p: Promise<unknown>): Promise<string> {
    try {
      await p;
      return '';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /* ---------- Test 6: backward compat — object-form caller still works ---------- */

  it('Test 6: existing object-form caller works unchanged (backward compat)', async () => {
    const { cap, probe } = makeCap();
    const r = await cap.invoke(
      { jobId: 'job-1', description: 'do x', gate: { type: 'file_exists', args: { path: '/x' } }, blockedBy: 'b1' },
      ctx,
    );
    expect(r).toEqual({ ok: true, itemId: 'item-1' });
    expect(probe.received!.jobId).toBe('job-1');
    expect(probe.received!.gate.type).toBe('file_exists');
    expect(probe.received!.gate.args).toEqual({ path: '/x' });
  });

  /* ---------- Test 3: JSON-stringified gate form ---------- */

  it('Test 3: gate as a JSON-stringified object parses + validates', async () => {
    const { cap, probe } = makeCap();
    const r = await cap.invoke(
      {
        jobId: 'j',
        description: 'do x',
        gate: '{"type":"file_exists","args":{"path":"/abs/x","minBytes":500}}',
      } as unknown as AppendPlanItemInput,
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(probe.received!.gate.type).toBe('file_exists');
    expect(probe.received!.gate.args).toEqual({ path: '/abs/x', minBytes: 500 });
  });

  /* ---------- Test 4: flat-key form (the recommended path) ---------- */

  it('Test 4: gate_type + gate_args_json (flat keys) constructs and validates', async () => {
    const { cap, probe } = makeCap();
    const r = await cap.invoke(
      {
        jobId: 'j',
        description: 'do x',
        gate_type: 'content_contains',
        gate_args_json: '{"path":"/abs/x","needle":"OK"}',
      } as unknown as AppendPlanItemInput,
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(probe.received!.gate.type).toBe('content_contains');
    expect(probe.received!.gate.args).toEqual({ path: '/abs/x', needle: 'OK' });
  });

  /* ---------- Test 5: flat-key form with no-args gate ---------- */

  it('Test 5: flat-key form for step_acknowledged (no gate_args_json) constructs args: {}', async () => {
    const { cap, probe } = makeCap();
    const r = await cap.invoke(
      {
        jobId: 'j',
        description: 'do x',
        gate_type: 'step_acknowledged',
      } as unknown as AppendPlanItemInput,
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(probe.received!.gate.type).toBe('step_acknowledged');
    expect(probe.received!.gate.args).toEqual({});
  });

  /* ---------- Test 1: wrong-shaped gate (string with JS-literal syntax — the run-1 case) ---------- */

  it('Test 1: gate-as-string with unquoted-key JS-literal syntax → self-correcting error', async () => {
    const { cap } = makeCap();
    const msg = await rejectionMessage(
      cap.invoke(
        {
          jobId: 'j',
          description: 'do x',
          // This is exactly what R++ TOKENS produces when an architect writes
          // a nested `gate: { type: ..., args: ... }` in their R++ output:
          // the parser flattens it to a literal string with unquoted keys.
          gate: '{ type: "file_exists", args: { path: "/abs/x" } }',
        } as unknown as AppendPlanItemInput,
        ctx,
      ),
    );
    // Echoes received value
    expect(msg).toContain('gate as string');
    // Echoes ALL valid type values
    for (const t of REGISTERED_HOOK_NAMES) {
      expect(msg).toContain(t);
    }
    // Leads with flat-key form
    const flatIdx = msg.indexOf('RECOMMENDED form — flat keys');
    const jsonIdx = msg.indexOf('ALTERNATIVE form — gate as a JSON-stringified');
    expect(flatIdx).toBeGreaterThan(0);
    expect(jsonIdx).toBeGreaterThan(flatIdx); // flat-key appears BEFORE JSON-string
    // Detects the JS-literal-vs-JSON mistake specifically
    expect(msg).toContain('JavaScript object literal with unquoted keys');
    expect(msg).toContain('R++ parser');
    expect(msg).toContain('silently flattened');
  });

  /* ---------- Test 2: missing gate.type (object form) ---------- */

  it('Test 2: gate object without type → self-correcting error echoes valid types + both shapes', async () => {
    const { cap } = makeCap();
    const msg = await rejectionMessage(
      cap.invoke(
        { jobId: 'j', description: 'do x', gate: { args: { path: '/x' } } } as unknown as AppendPlanItemInput,
        ctx,
      ),
    );
    expect(msg).toContain('NO \'type\' key');
    for (const t of REGISTERED_HOOK_NAMES) {
      expect(msg).toContain(t);
    }
    expect(msg).toContain('RECOMMENDED form — flat keys');
    expect(msg).toContain('ALTERNATIVE form — gate as a JSON-stringified');
  });

  /* ---------- Test 7: malformed JSON in stringified gate → escaping-aware ---------- */

  it('Test 7: malformed JSON in gate-string (truncated) → error includes parse error + recommends flat-key form', async () => {
    const { cap } = makeCap();
    const msg = await rejectionMessage(
      cap.invoke(
        {
          jobId: 'j',
          description: 'do x',
          // Quoted-keys (so it's NOT the JS-object-literal branch) but truncated.
          gate: '{"type":"file_exists","args":{"path":"/x"',
        } as unknown as AppendPlanItemInput,
        ctx,
      ),
    );
    expect(msg).toContain('Parse error:');
    // General JSON-parse hint fires.
    expect(msg).toContain('JSON parse failed');
    // Always recommends the flat-key form for its smaller escaping surface.
    expect(msg).toContain('flat-key form');
    expect(msg).toContain('smaller escaping surface');
  });

  it('Test 7-escape: invalid \\-escape in JSON string → escaping-aware hint', async () => {
    const { cap } = makeCap();
    // Use a JSON string with an invalid backslash escape (\q is not a JSON
    // string-escape). Node's JSON.parse rejects it with a message that mentions
    // "Bad escaped character" / similar. The hint chain in the validator
    // either matches "unexpected token" or the backslash-specific branch.
    const msg = await rejectionMessage(
      cap.invoke(
        {
          jobId: 'j',
          description: 'do x',
          gate: '{"type":"file_exists","args":{"path":"a\\qb"}}',
        } as unknown as AppendPlanItemInput,
        ctx,
      ),
    );
    expect(msg).toContain('Parse error:');
    // Either the backslash-specific hint OR the general JSON-parse hint fires.
    const hasRecoveryHint =
      msg.includes('backslash') ||
      msg.includes('JSON parse failed') ||
      msg.includes('Unescaped');
    expect(hasRecoveryHint).toBe(true);
    expect(msg).toContain('flat-key form');
  });

  it('Test 7b: malformed gate_args_json (flat-key path) → same self-correcting shape', async () => {
    const { cap } = makeCap();
    const msg = await rejectionMessage(
      cap.invoke(
        {
          jobId: 'j',
          description: 'do x',
          gate_type: 'file_exists',
          gate_args_json: '{"path":', // truncated
        } as unknown as AppendPlanItemInput,
        ctx,
      ),
    );
    expect(msg).toContain('Parse error:');
    expect(msg).toContain('gate_args_json');
    for (const t of REGISTERED_HOOK_NAMES) {
      expect(msg).toContain(t);
    }
  });

  /* ---------- Test 8: action self-description completeness ---------- */

  it("Test 8: action.description contains every valid gate.type and both R++ shapes", () => {
    const cap = makeAppendPlanItemAction({ append: () => ({ ok: true }) });
    const d = cap.description;
    // Every registered hook name is in the description (incl. step_acknowledged
    // which the previous draft omitted)
    for (const t of REGISTERED_HOOK_NAMES) {
      expect(d).toContain(t);
    }
    // Leads with flat-key form
    expect(d).toContain('flat-key form');
    expect(d).toContain('gate_type');
    expect(d).toContain('gate_args_json');
    // Also mentions the JSON-string alternative
    expect(d).toContain('JSON-stringified');
    // And the explicit R++-flatten warning
    expect(d).toContain('R++');
    expect(d).toContain('nested');
  });

  /* ---------- Test 9: single-source-of-truth integrity ---------- */

  it('Test 9: REGISTERED_HOOK_NAMES matches the names actually registered in @runcor/jobs', async () => {
    // Importing @runcor/jobs here would create a circular test-side dep; instead
    // the @runcor/jobs module itself throws on load if the lists drift (see the
    // drift-guard block at the bottom of completion-check.ts). This test pins
    // REGISTERED_HOOK_NAMES to the expected set so a future addition is caught
    // here AND in the @runcor/jobs runtime guard.
    expect([...REGISTERED_HOOK_NAMES].sort()).toEqual([
      'always_fail',
      'always_pass',
      'command_exits_zero',
      'content_contains',
      'description_contains',
      'file_exists',
      'http_status_is',
      'operator_attested',
      'step_acknowledged',
    ]);
  });

  /* ---------- Test 10: replay run-1's actual cycle-7 R++ input ---------- */

  it('Test 10: run-1 cycle-7 architect input → produces a one-cycle-recoverable error message', async () => {
    // This is the exact gate value that R++ TOKENS produced when the architect
    // wrote `gate: { type: "file_exists", args: { path: "..." } }` as a nested
    // object — the parser flattened it to a literal string with unquoted keys.
    const { cap } = makeCap();
    const msg = await rejectionMessage(
      cap.invoke(
        {
          jobId: 'ABC remediation and migration',
          description: 'Operator brief written into workspace/: ...',
          gate: '{ type: "file_exists", args: { path: "/workspace/operator-brief.md" } }',
        } as unknown as AppendPlanItemInput,
        ctx,
      ),
    );
    // The error must contain everything the architect needs to recover in
    // ONE cycle: what was received, the silent-flattening explanation, the
    // valid types, and the flat-key shape leading the recommended path.
    expect(msg).toContain('gate as string');
    expect(msg).toContain('silently flattened');
    expect(msg).toContain('file_exists');
    expect(msg).toContain('gate_type');
    expect(msg).toContain('gate_args_json');
    // And the recommended shape comes first.
    expect(msg.indexOf('RECOMMENDED form')).toBeLessThan(msg.indexOf('ALTERNATIVE form'));
  });

  /* ---------- legacy required-field tests still pass ---------- */

  it('still throws when jobId is missing', async () => {
    const cap = makeAppendPlanItemAction({ append: () => ({ ok: true }) });
    await expect(
      cap.invoke(
        { description: 'x', gate: { type: 'file_exists' } } as unknown as AppendPlanItemInput,
        ctx,
      ),
    ).rejects.toThrow(/jobId/);
  });

  it('still throws when description is missing', async () => {
    const cap = makeAppendPlanItemAction({ append: () => ({ ok: true }) });
    await expect(
      cap.invoke(
        { jobId: 'j', gate: { type: 'file_exists' } } as unknown as AppendPlanItemInput,
        ctx,
      ),
    ).rejects.toThrow(/description/);
  });
});
