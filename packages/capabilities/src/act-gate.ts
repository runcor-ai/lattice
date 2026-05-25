import type { ActContext, Capability, PermissionContext } from './types.js';

/**
 * actOne — enforces the at-most-one-action-per-cycle invariant
 * (spec FR-004) and runs the substrate-style permission gate
 * (canInvoke) before invoking the chosen action.
 *
 * Returns a discriminated union the runtime's act phase consumes.
 */
export type ActResult =
  | { result: 'ok'; data: unknown }
  | { result: 'no-action' }
  | { result: 'denied'; reason: string; escalate: boolean }
  | { result: 'failed'; reason: string };

export interface ActArgs<I> {
  readonly chosenAction: string | null;
  readonly input: I;
  readonly actions: readonly Capability<unknown, unknown>[];
  readonly ctx: ActContext;
}

export async function actOne<I>(args: ActArgs<I>): Promise<ActResult> {
  if (args.chosenAction === null) return { result: 'no-action' };

  const action = args.actions.find(
    (a) => a.name === args.chosenAction && a.role.action && a.isEnabled(),
  );
  if (!action || !action.invoke) {
    return {
      result: 'failed',
      reason: `action not found or not invokable: ${args.chosenAction}`,
    };
  }

  const permission = action.canInvoke({
    cycle: args.ctx.cycle,
    autonomy: args.ctx.autonomy,
    budgetRemaining: args.ctx.budgetRemaining,
  } as PermissionContext);
  if (!permission.allow) {
    return { result: 'denied', reason: permission.reason, escalate: permission.escalate };
  }

  try {
    const data = await action.invoke(args.input, args.ctx);
    return { result: 'ok', data };
  } catch (err) {
    return {
      result: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
