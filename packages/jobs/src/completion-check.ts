import { existsSync, readFileSync, statSync } from 'node:fs';

import { runShellCommand } from '@runcor/capabilities';

import type { CheckOutcome, CompletionCheckSpec, DeterministicHook, Item } from './types.js';

/**
 * Completion check runner (spec FR-034 + FR-035).
 *
 * Per Principle XIII: each item carries a layered check.
 *   1. Deterministic hooks first (cheap, flat).
 *   2. If all hooks pass: optional judgement pass (LLM via decider).
 *   3. Only when both layers pass: item is `passed`.
 *
 * Hooks are registered by name in a `CheckRegistry`. The item's
 * completion_check column is JSON describing which hooks to run +
 * their arguments. This decouples "what to check" (data, in the DB)
 * from "how to check it" (code, in the registry).
 */

export type HookResult = boolean | { passed: boolean; reason?: string };

export interface HookFn {
  /**
   * Deterministic, no LLM judgement (Principle V). May be async: Item 7
   * adds command/HTTP gates that are inherently asynchronous.
   */
  (args: Readonly<Record<string, unknown>>, ctx: HookContext): HookResult | Promise<HookResult>;
}

export interface HookContext {
  readonly item: Item;
  readonly cycle: number;
}

export interface HookRegistration {
  readonly fn: HookFn;
  /**
   * Item 7 tiered execution — when true the hook does real I/O (spawns a
   * command, makes an HTTP call) and is too expensive to run on the
   * every-cycle subconscious sweep. Costly hooks are SKIPPED in `auto`
   * mode and only evaluated on an explicit close attempt (`lattice`
   * mode). Cheap hooks (file reads, string checks) run in both.
   */
  readonly costly: boolean;
}

export class CheckRegistry {
  private readonly hooks = new Map<string, HookRegistration>();

  register(name: string, fn: HookFn, opts: { costly?: boolean } = {}): this {
    this.hooks.set(name, { fn, costly: opts.costly ?? false });
    return this;
  }

  get(name: string): HookRegistration | undefined {
    return this.hooks.get(name);
  }
}

/** Built-in hooks slice 9 ships with. */
export function builtinRegistry(): CheckRegistry {
  return new CheckRegistry()
    .register('always_pass', () => true)
    .register('always_fail', () => ({ passed: false, reason: 'always_fail rule fired' }))
    .register('description_contains', (args, ctx) => {
      const needle = typeof args.needle === 'string' ? args.needle : '';
      return needle ? ctx.item.description.includes(needle) : false;
    })
    /**
     * `file_exists` — passes when an absolute file path exists, is a
     * regular file, and (optionally) is at least `minBytes` long. Use
     * this when the item's deliverable is a file the lattice writes:
     *   { name: "file_exists", args: { path: "C:/.../out/plan.md" } }
     *   { name: "file_exists", args: { path: "...", minBytes: 200 } }
     * Deterministic per Principle V — no LLM judgement.
     */
    .register('file_exists', (args) => {
      const path = typeof args.path === 'string' ? args.path : '';
      if (!path) return { passed: false, reason: 'file_exists: args.path (string) is required' };
      if (!existsSync(path)) return { passed: false, reason: `file_exists: not found: ${path}` };
      try {
        const st = statSync(path);
        if (!st.isFile()) return { passed: false, reason: `file_exists: not a regular file: ${path}` };
        const minBytes = typeof args.minBytes === 'number' ? args.minBytes : 0;
        if (st.size < minBytes) {
          return { passed: false, reason: `file_exists: ${path} is ${st.size} bytes, want >= ${minBytes}` };
        }
        return true;
      } catch (err) {
        return {
          passed: false,
          reason: `file_exists: stat failed for ${path}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    })
    /**
     * `content_contains` — passes when a file exists and contains a
     * substring, or matches a regex when `isRegex` is set. Use it to gate
     * on a file's CONTENT, not just its presence:
     *   { name: "content_contains", args: { path: "...", needle: "- [ ]" } }
     *   { name: "content_contains", args: { path: "...", needle: "^- \\[[ x]\\]", isRegex: true } }
     * Cheap (one file read) — runs in the subconscious sweep.
     */
    .register('content_contains', (args) => {
      const path = typeof args.path === 'string' ? args.path : '';
      const needle = typeof args.needle === 'string' ? args.needle : '';
      if (!path) return { passed: false, reason: 'content_contains: args.path (string) is required' };
      if (!needle) return { passed: false, reason: 'content_contains: args.needle (string) is required' };
      if (!existsSync(path)) return { passed: false, reason: `content_contains: not found: ${path}` };
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        return { passed: false, reason: `content_contains: read failed for ${path}: ${err instanceof Error ? err.message : String(err)}` };
      }
      const hit = args.isRegex === true ? new RegExp(needle, 'm').test(text) : text.includes(needle);
      return hit
        ? true
        : { passed: false, reason: `content_contains: ${path} does not ${args.isRegex === true ? 'match' : 'contain'} "${needle}"` };
    })
    /**
     * `step_acknowledged` — COSTLY. The gate for a plan step that declares
     * no machine-checkable definition-of-done: a prose checkbox like
     * "spot-check one category total" or "close item X" where there is no
     * deliverable file to stat. Tiered like the other costly gates — the
     * every-cycle subconscious sweep reports it deferred (never silently
     * auto-passes), and it is satisfied ONLY on an explicit close-job-item
     * attempt, where the lattice asserts the step is done and its `why` is
     * recorded in the trace.
     *
     * This replaces the old ceremonial `.step-N.done` marker fallback. That
     * marker was a content-free file that verified nothing about the
     * deliverable — pass-by-assertion wearing a `file_exists` costume — and
     * it deadlocked any job whose REAL deliverable gates were already
     * satisfied: a lattice that produced the deliverable but (rightly, or
     * via a poisoned summary) declined the ritual could never close. That
     * is the marker-chase loop observed across util28 / t29 / data-25. The
     * job's real deliverable items keep their own machine gates (file_exists,
     * command_exits_zero, …); ordering is still enforced by blocked_by. This
     * hook governs ONLY the prose scaffolding steps, and an explicit,
     * justified close is strictly more auditable than an empty marker file.
     */
    .register(
      'step_acknowledged',
      () => ({ passed: true, reason: 'step acknowledged via explicit close-job-item' }),
      { costly: true },
    )
    /**
     * `command_exits_zero` — COSTLY. Runs a command in the same sandbox
     * the `shell-exec` capability uses (allowlisted first-token verb,
     * cwd-jailed, timed out) and passes when it exits 0:
     *   { name: "command_exits_zero", args: { command: "npm test", cwd: "C:/.../proj" } }
     * Tiered: skipped in the auto sweep, evaluated only on an explicit
     * close attempt. Reuses the one sandboxed runner — no new exec path.
     */
    .register(
      'command_exits_zero',
      async (args) => {
        const command = typeof args.command === 'string' ? args.command : '';
        const cwd = typeof args.cwd === 'string' ? args.cwd : '';
        if (!command) return { passed: false, reason: 'command_exits_zero: args.command (string) is required' };
        if (!cwd) return { passed: false, reason: 'command_exits_zero: args.cwd (absolute path) is required' };
        try {
          const res = await runShellCommand({
            command,
            cwd,
            ...(Array.isArray(args.allowedVerbs) ? { allowedVerbs: args.allowedVerbs as string[] } : {}),
            ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
          });
          return res.exitCode === 0
            ? true
            : { passed: false, reason: `command_exits_zero: "${command}" exited ${res.exitCode}` };
        } catch (err) {
          return { passed: false, reason: `command_exits_zero: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
      { costly: true },
    )
    /**
     * `http_status_is` — COSTLY. Fetches a URL and passes when the
     * response status equals `status` (default 200):
     *   { name: "http_status_is", args: { url: "http://localhost:8080/health" } }
     *   { name: "http_status_is", args: { url: "...", status: 204 } }
     * Tiered like command_exits_zero — explicit-close only.
     */
    .register(
      'http_status_is',
      async (args) => {
        const url = typeof args.url === 'string' ? args.url : '';
        const want = typeof args.status === 'number' ? args.status : 200;
        if (!url) return { passed: false, reason: 'http_status_is: args.url (string) is required' };
        try {
          const res = await fetch(url, { method: typeof args.method === 'string' ? args.method : 'GET' });
          return res.status === want
            ? true
            : { passed: false, reason: `http_status_is: ${url} returned ${res.status}, want ${want}` };
        } catch (err) {
          return { passed: false, reason: `http_status_is: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
      { costly: true },
    );
}

export function parseSpec(serialized: string): CompletionCheckSpec {
  const obj = JSON.parse(serialized) as Partial<CompletionCheckSpec>;
  if (!obj || !Array.isArray(obj.hooks)) {
    throw new Error('invalid CompletionCheckSpec — missing hooks[]');
  }
  return {
    hooks: obj.hooks,
    ...(obj.judgement ? { judgement: obj.judgement } : {}),
    ...(obj.iterationCap !== undefined ? { iterationCap: obj.iterationCap } : {}),
  };
}

export function serializeSpec(spec: CompletionCheckSpec): string {
  return JSON.stringify(spec);
}

/**
 * Run the deterministic part of a check. Returns:
 *   - `passed` → all hooks passed; if a judgement pass exists, the
 *     caller should invoke the decider; otherwise the item is done.
 *   - `failed(reason)` → at least one hook failed. The item stays
 *     `open`; the caller increments iteration_count.
 *   - `judgement_required(criterion)` → all hooks passed AND a
 *     judgement pass is configured; the caller runs the decider.
 */
export async function runDeterministicHooks(
  spec: CompletionCheckSpec,
  registry: CheckRegistry,
  ctx: HookContext & { mode?: 'lattice' | 'auto' },
): Promise<CheckOutcome> {
  const mode = ctx.mode ?? 'lattice';
  for (const h of spec.hooks) {
    const reg = registry.get(h.name);
    if (!reg) {
      return { result: 'failed', reason: `unknown hook: ${h.name}` };
    }
    if (reg.costly && mode === 'auto') {
      // Item 7 tiered execution — the every-cycle sweep does not spawn
      // commands or make HTTP calls. The item stays open until the
      // lattice explicitly attempts close (lattice mode), which runs the
      // costly gate. Reported as failed so the item cannot auto-pass.
      return {
        result: 'failed',
        reason: `${h.name}: costly gate deferred to explicit close (not run in auto sweep)`,
      };
    }
    const out = await reg.fn(h.args ?? {}, { item: ctx.item, cycle: ctx.cycle });
    if (out === false || (typeof out === 'object' && !out.passed)) {
      const reason = typeof out === 'object' && out.reason ? out.reason : `${h.name} failed`;
      return { result: 'failed', reason };
    }
  }
  if (spec.judgement) {
    return { result: 'judgement_required', criterion: spec.judgement.criterion };
  }
  return { result: 'passed' };
}

export interface GateSummary {
  /**
   * True when every cheap deterministic hook currently passes. False when a
   * cheap hook fails, when the spec references an unknown hook, or when the
   * item is gated ONLY by costly hooks (those are verified on an explicit
   * close, so a pass cannot be asserted from the reality slice).
   */
  readonly passed: boolean;
  /** Human-readable verdict, suitable for the reality slice. Always set. */
  readonly reason: string;
  /** True when ≥1 costly hook was intentionally NOT executed here. */
  readonly deferred: boolean;
}

/**
 * summarizeGate — a SYNCHRONOUS, side-effect-light read of an item's gate,
 * for echoing ground truth next to each open item in the per-cycle reality
 * slice (runtime ground phase). It runs only the CHEAP hooks (file/content/
 * string — the same ones the auto sweep runs) and reports their live verdict
 * verbatim. Costly hooks (command_exits_zero / http_status_is) are NOT run
 * here — building the reality slice every cycle must not spawn processes or
 * make network calls — they are reported as "verified on explicit close".
 *
 * Why this exists: a lattice's self-authored situation summary can drift to
 * contradict ground truth and steer it onto a non-existent blocker (observed
 * twice in endurance runs — see docs/endurance-run-stuck-summary). Echoing
 * the gate's live reason beside each open item gives the model a machine-
 * checked signal that contradicts a poisoned narrative in BOTH directions:
 * "you believe you are blocked but the gate already passes — close it" and
 * "you believe this is done but here is the exact file/condition missing".
 */
export function summarizeGate(
  spec: CompletionCheckSpec,
  registry: CheckRegistry,
  item: Item,
  cycle: number,
): GateSummary {
  let sawCheap = false;
  let sawDeferred = false;
  for (const h of spec.hooks) {
    const reg = registry.get(h.name);
    if (!reg) {
      return { passed: false, reason: `unknown gate hook: ${h.name}`, deferred: false };
    }
    if (reg.costly) {
      sawDeferred = true;
      continue;
    }
    const out = reg.fn(h.args ?? {}, { item, cycle });
    // Cheap hooks are synchronous by contract; if one unexpectedly returns a
    // thenable we cannot await it while building the reality slice, so treat
    // it as deferred rather than blocking the cycle.
    const isThenable =
      out !== null && typeof out === 'object' && typeof (out as { then?: unknown }).then === 'function';
    if (isThenable) {
      sawDeferred = true;
      continue;
    }
    sawCheap = true;
    const res = out as boolean | { passed: boolean; reason?: string };
    if (res === false || (typeof res === 'object' && !res.passed)) {
      const reason = typeof res === 'object' && res.reason ? res.reason : `${h.name} failed`;
      return { passed: false, reason, deferred: sawDeferred };
    }
  }
  if (!sawCheap) {
    return sawDeferred
      ? {
          passed: false,
          reason: 'costly gate — verified only on an explicit close-job-item attempt',
          deferred: true,
        }
      : { passed: true, reason: 'no deterministic gate', deferred: false };
  }
  return {
    passed: true,
    reason: sawDeferred
      ? 'cheap gates satisfied — a costly gate is still verified on explicit close'
      : 'gate satisfied — close this item via close-job-item',
    deferred: sawDeferred,
  };
}

export function defaultIterationCap(spec: CompletionCheckSpec): number {
  return spec.iterationCap ?? 5;
}

/** Item 8 — is `name` part of the built-in gate vocabulary the lattice
 * may author? Used to reject invalid gate types on lattice-appended items. */
export function isKnownHook(name: string): boolean {
  return builtinRegistry().get(name) !== undefined;
}

export type { DeterministicHook };
