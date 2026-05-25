import { existsSync, statSync } from 'node:fs';

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

export interface HookFn {
  /** Synchronous hooks only — Principle V (no judgement). */
  (args: Readonly<Record<string, unknown>>, ctx: HookContext): boolean | { passed: boolean; reason?: string };
}

export interface HookContext {
  readonly item: Item;
  readonly cycle: number;
}

export class CheckRegistry {
  private readonly hooks = new Map<string, HookFn>();

  register(name: string, fn: HookFn): this {
    this.hooks.set(name, fn);
    return this;
  }

  get(name: string): HookFn | undefined {
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
    });
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
export function runDeterministicHooks(
  spec: CompletionCheckSpec,
  registry: CheckRegistry,
  ctx: HookContext,
): CheckOutcome {
  for (const h of spec.hooks) {
    const fn = registry.get(h.name);
    if (!fn) {
      return { result: 'failed', reason: `unknown hook: ${h.name}` };
    }
    const out = fn(h.args ?? {}, ctx);
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

export function defaultIterationCap(spec: CompletionCheckSpec): number {
  return spec.iterationCap ?? 5;
}

export type { DeterministicHook };
