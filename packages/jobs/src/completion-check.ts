import { existsSync, readFileSync, statSync } from 'node:fs';

import { REGISTERED_HOOK_NAMES, runShellCommand } from '@runcor/capabilities';

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
  /**
   * Optional sqlite handle. Most hooks ignore this; the `operator_attested`
   * hook requires it to check the operator_attestation table and to verify
   * the all-other-items-passed completeness condition. attemptCheck (in
   * service.ts) supplies it; callers running runDeterministicHooks outside
   * a JobsService context may omit it, in which case operator_attested
   * fails with an explanatory reason.
   */
  readonly db?: import('better-sqlite3').Database;
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

  /** Iterator of registered hook names — used by the drift guard below. */
  names(): IterableIterator<string> {
    return this.hooks.keys();
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
    )
    /**
     * `operator_attested` — TERMINAL. The only satisfier for a true
     * operator sign-off. Bound to the lattice's own state, not to any
     * file on disk:
     *
     *   1. A row must exist in `operator_attestation` for `ctx.item.id`.
     *      The only writer is the bridge endpoint
     *      `POST /api/lattices/:id/items/:item_id/attest`. The architect
     *      tool surface has no manifest action that inserts here
     *      (verified by jobs/source-immutability.test.ts's table-write
     *      scan). No file at any path can satisfy this hook — it does
     *      not read the filesystem.
     *
     *   2. Every OTHER item on the same job must be in state='passed'.
     *      Open items mean the work is incomplete; deferred items
     *      ALSO mean the work is incomplete. A deferred item is
     *      unfinished work that the lattice paused, not work that has
     *      been excluded from the contract. Without the deferred-check,
     *      run-3's failure mode would survive in a new shape: the
     *      no-progress circuit-breaker defers everything, then the
     *      operator endpoint flips the attestation, and a partial job
     *      gets a "complete" sign-off. Refusing on deferred items
     *      closes that laundering path.
     *
     * Cosly:true — never auto-passes during the every-cycle sweep; only
     * evaluates on an explicit close attempt (mode='operator' from the
     * bridge endpoint).
     */
    .register(
      'operator_attested',
      (_args, ctx) => {
        if (!ctx.db) {
          return { passed: false, reason: 'operator_attested: db handle unavailable (hook requires JobsService.attemptCheck context)' };
        }
        const attest = ctx.db
          .prepare('SELECT item_id FROM operator_attestation WHERE item_id = ?')
          .get(ctx.item.id) as { item_id: string } | undefined;
        if (!attest) {
          return { passed: false, reason: 'operator_attested: no attestation recorded — operator has not called POST /attest' };
        }
        const siblings = ctx.db
          .prepare(
            `SELECT state, COUNT(*) AS n
             FROM plan_item
             WHERE job_id = ? AND id != ?
             GROUP BY state`,
          )
          .all(ctx.item.job_id, ctx.item.id) as Array<{ state: string; n: number }>;
        const counts = { open: 0, deferred: 0, passed: 0 };
        for (const r of siblings) {
          if (r.state === 'open') counts.open = r.n;
          else if (r.state === 'deferred') counts.deferred = r.n;
          else if (r.state === 'passed') counts.passed = r.n;
        }
        if (counts.open > 0 || counts.deferred > 0) {
          const parts: string[] = [];
          if (counts.open > 0) parts.push(`${counts.open} items still open`);
          if (counts.deferred > 0) parts.push(`${counts.deferred} items deferred (incomplete)`);
          return {
            passed: false,
            reason: `operator_attested: job not complete — ${parts.join(', ')}; refuse to attest a partial job`,
          };
        }
        return true;
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
  ctx: HookContext & { mode?: 'lattice' | 'auto' | 'operator' },
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
    const out = await reg.fn(h.args ?? {}, { item: ctx.item, cycle: ctx.cycle, ...(ctx.db ? { db: ctx.db } : {}) });
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
  /**
   * Categorisation of the gate's state, used by the prompt renderer
   * (ground.ts:renderTasksBlock) to choose the right line shape. Five
   * categories cover the full matrix — the renderer never has to inspect
   * the spec or registry itself:
   *   - 'cheap_pass'                — all cheap hooks pass, no costly hook in the spec
   *   - 'cheap_pass_costly_pending' — cheap pass + a costly hook will run on explicit close
   *   - 'cheap_fail'                — at least one cheap hook failed (reason carries which)
   *   - 'costly_only'               — no cheap hooks; only a costly hook (named in costlyHook)
   *   - 'unknown_hook'              — spec references a hook the registry does not know
   */
  readonly kind:
    | 'cheap_pass'
    | 'cheap_pass_costly_pending'
    | 'cheap_fail'
    | 'costly_only'
    | 'unknown_hook';
  /**
   * When the gate involves a costly hook ('cheap_pass_costly_pending' or
   * 'costly_only'), the name of the first costly hook present in the
   * spec. The renderer uses this to distinguish acknowledgement-only
   * hooks (step_acknowledged, operator_attested) from runtime-check
   * hooks (command_exits_zero, http_status_is).
   */
  readonly costlyHook?: string;
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
  let firstCostlyHook: string | undefined;
  for (const h of spec.hooks) {
    const reg = registry.get(h.name);
    if (!reg) {
      return { passed: false, reason: `unknown gate hook: ${h.name}`, deferred: false, kind: 'unknown_hook' };
    }
    if (reg.costly) {
      sawDeferred = true;
      if (!firstCostlyHook) firstCostlyHook = h.name;
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
      if (!firstCostlyHook) firstCostlyHook = h.name;
      continue;
    }
    sawCheap = true;
    const res = out as boolean | { passed: boolean; reason?: string };
    if (res === false || (typeof res === 'object' && !res.passed)) {
      const reason = typeof res === 'object' && res.reason ? res.reason : `${h.name} failed`;
      return { passed: false, reason, deferred: sawDeferred, kind: 'cheap_fail' };
    }
  }
  if (!sawCheap) {
    return sawDeferred
      ? {
          passed: false,
          reason: 'costly gate — verified only on an explicit close-job-item attempt',
          deferred: true,
          kind: 'costly_only',
          ...(firstCostlyHook ? { costlyHook: firstCostlyHook } : {}),
        }
      : { passed: true, reason: 'no deterministic gate', deferred: false, kind: 'cheap_pass' };
  }
  return {
    passed: true,
    reason: sawDeferred
      ? 'cheap gates satisfied — a costly gate is still verified on explicit close'
      : 'gate satisfied — close this item via close-job-item',
    deferred: sawDeferred,
    kind: sawDeferred ? 'cheap_pass_costly_pending' : 'cheap_pass',
    ...(sawDeferred && firstCostlyHook ? { costlyHook: firstCostlyHook } : {}),
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

/**
 * Single-source-of-truth guard. REGISTERED_HOOK_NAMES (in @runcor/capabilities)
 * is what the append-plan-item validator's error message echoes to the
 * architect; if the two lists drift, the architect gets a list of types
 * that don't actually work. This module-load assertion makes drift impossible:
 * every name registered in builtinRegistry MUST be in REGISTERED_HOOK_NAMES,
 * and vice versa. If you add a hook below, add the name to gate-hook-names.ts
 * in @runcor/capabilities (or this assertion fires).
 */
{
  const registered = new Set<string>(builtinRegistry().names());
  const declared = new Set<string>(REGISTERED_HOOK_NAMES);
  const missingInDeclared: string[] = [];
  const missingInRegistry: string[] = [];
  for (const n of registered) if (!declared.has(n)) missingInDeclared.push(n);
  for (const n of declared) if (!registered.has(n)) missingInRegistry.push(n);
  if (missingInDeclared.length > 0 || missingInRegistry.length > 0) {
    throw new Error(
      `completion-check / gate-hook-names drift detected. ` +
        (missingInDeclared.length > 0
          ? `Registered in builtinRegistry but not in REGISTERED_HOOK_NAMES: [${missingInDeclared.join(', ')}]. `
          : '') +
        (missingInRegistry.length > 0
          ? `Declared in REGISTERED_HOOK_NAMES but not registered in builtinRegistry: [${missingInRegistry.join(', ')}]. `
          : '') +
        `Update packages/capabilities/src/gate-hook-names.ts to match.`,
    );
  }
}

export type { DeterministicHook };
