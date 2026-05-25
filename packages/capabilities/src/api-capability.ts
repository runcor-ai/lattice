import type { ActContext, Capability, ObserveContext, PermissionContext } from './types.js';

/**
 * makeApiCapability — factory for an HTTP/REST `Capability`. Slice 10
 * keeps this minimal; slice 14 / Bridge will plumb auth headers,
 * retry policy, and cost accounting via the engine layer.
 *
 * The factory takes either a `readFn` (for senses) or an `invokeFn`
 * (for actions) plus the standard contract fields.
 */

export interface ApiCapabilityOptions<I, O> {
  readonly name: string;
  readonly description: string;
  readonly role: { sense: boolean; action: boolean };
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly concurrencySafe?: boolean;
  readonly readFn?: (ctx: ObserveContext) => Promise<O>;
  readonly invokeFn?: (input: I, ctx: ActContext) => Promise<O>;
  readonly enabled?: () => boolean;
  readonly canInvoke?: (ctx: PermissionContext) => { allow: true } | { allow: false; reason: string; escalate: boolean };
}

export function makeApiCapability<I, O>(opts: ApiCapabilityOptions<I, O>): Capability<I, O> {
  const enabledFn = opts.enabled ?? (() => true);
  const permissionFn = opts.canInvoke ?? ((_ctx) => ({ allow: true as const }));
  const result: Capability<I, O> = {
    name: opts.name,
    description: opts.description,
    role: opts.role,
    readOnly: opts.readOnly,
    destructive: opts.destructive,
    concurrencySafe: opts.concurrencySafe ?? true,
    isEnabled: enabledFn,
    canInvoke: permissionFn,
    ...(opts.readFn ? { read: opts.readFn } : {}),
    ...(opts.invokeFn ? { invoke: opts.invokeFn } : {}),
  };
  return result;
}
