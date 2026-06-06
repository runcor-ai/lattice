import type {
  ActContext,
  Capability,
  PermissionContext,
  PermissionResult,
} from './types.js';

/**
 * CloseJobItemAction — let the lattice mark an open plan_item as done.
 *
 * Without this, the lattice has no way to progress through a multi-item
 * job: every cycle would see the same open items in its reality slice
 * and might rewrite the same deliverable indefinitely (the dir-loop
 * failure mode observed in the first worked example run). With this, after
 * writing the deliverable, the lattice invokes `close-job-item` with
 * the item's id; the deterministic completion hooks fire; if they pass
 * the item is marked passed and drops from the open list on the next
 * cycle.
 *
 * The capability needs to invoke JobsService.attemptCheck against the
 * same SQLite handle the cycle's other writes go to. Rather than import
 * `@runcor/jobs` here (which would create a circular package dep — jobs
 * transitively imports capabilities), the runtime layer injects an
 * `attemptCheck` callback at construction. This keeps the capability
 * package free of jobs-runtime coupling.
 */

export interface CloseJobItemInput {
  readonly itemId: string;
  readonly why?: string;
}

export interface CloseJobItemResult {
  readonly itemId: string;
  readonly outcome: 'passed' | 'failed_iterating' | 'judgement_required' | 'iteration_cap_exceeded' | 'blocked';
  readonly reason?: string;
}

export interface CloseJobItemOptions {
  readonly name?: string;
  /**
   * Runner that performs the close attempt. Injected by the runtime
   * layer with a JobsService.attemptCheck wrapper. May be async: Item 7
   * completion-check gates (command_exits_zero, http_status_is) are
   * evaluated here on an explicit close and are inherently asynchronous.
   */
  readonly attemptCheck: (
    itemId: string,
    ctx: { cycle: number },
  ) => CloseJobItemResult | Promise<CloseJobItemResult>;
}

export function makeCloseJobItemAction(
  opts: CloseJobItemOptions,
): Capability<CloseJobItemInput, CloseJobItemResult> {
  const name = opts.name ?? 'close-job-item';

  return {
    name,
    description:
      `Mark a plan_item closed by running its completion hooks. Invoke AFTER you have produced the item's deliverable (e.g. written the corresponding file). Input: { itemId: string (copy the id verbatim from the open tasks list), why?: string (one-sentence justification for the trace) }.`,
    role: { sense: false, action: true },
    readOnly: false,
    destructive: false,
    concurrencySafe: false,
    isEnabled: () => true,
    canInvoke: (_ctx: PermissionContext): PermissionResult => ({ allow: true }),
    async invoke(input: CloseJobItemInput, ctx: ActContext): Promise<CloseJobItemResult> {
      if (!input || typeof input.itemId !== 'string' || input.itemId.length === 0) {
        throw new Error('close-job-item: input.itemId (string) is required');
      }
      void input.why;
      return opts.attemptCheck(input.itemId, { cycle: ctx.cycle });
    },
  };
}
