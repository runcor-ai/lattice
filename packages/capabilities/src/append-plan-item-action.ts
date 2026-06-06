import type {
  ActContext,
  Capability,
  PermissionContext,
  PermissionResult,
} from './types.js';

/**
 * AppendPlanItemAction (Item 8) — let the lattice append a new gated item
 * to one of its OPEN jobs mid-cycle: to refine a step into sub-steps, or
 * to capture work the original plan missed.
 *
 * Like close-job-item, the runtime injects the actual append callback
 * (a JobsService.appendLatticeItem wrapper) so this package stays free of
 * a jobs-runtime dependency. The callback runs the same validation +
 * audit the bridge endpoint does; this capability is just the lattice's
 * in-process door to it.
 */

export interface AppendPlanItemInput {
  readonly jobId: string;
  readonly description: string;
  /** Gate from the Item 7 vocabulary, e.g. { type: 'file_exists', args: { path: '...' } }. */
  readonly gate: { type: string; args?: Record<string, unknown> };
  /** Optional id of an existing item on the same job that must pass first. */
  readonly blockedBy?: string;
  readonly why?: string;
}

export interface AppendPlanItemResult {
  readonly ok: boolean;
  readonly itemId?: string;
  readonly reason?: string;
}

export interface AppendPlanItemOptions {
  readonly name?: string;
  readonly append: (
    input: AppendPlanItemInput,
  ) => AppendPlanItemResult | Promise<AppendPlanItemResult>;
}

export function makeAppendPlanItemAction(
  opts: AppendPlanItemOptions,
): Capability<AppendPlanItemInput, AppendPlanItemResult> {
  const name = opts.name ?? 'append-plan-item';
  return {
    name,
    description:
      `Append a new gated item to one of your OPEN jobs. Use it to break a step into sub-steps, ` +
      `or to add work the plan missed. Input: { jobId: string (from the open tasks list), ` +
      `description: string, gate: { type: string (file_exists | content_contains | command_exits_zero | http_status_is), ` +
      `args?: object }, blockedBy?: string (id of an item that must pass first), why?: string }. ` +
      `Append-only — it cannot edit or remove existing items.`,
    role: { sense: false, action: true },
    readOnly: false,
    destructive: false,
    concurrencySafe: false,
    isEnabled: () => true,
    canInvoke: (_ctx: PermissionContext): PermissionResult => ({ allow: true }),
    async invoke(input: AppendPlanItemInput, _ctx: ActContext): Promise<AppendPlanItemResult> {
      if (!input || typeof input.jobId !== 'string' || input.jobId.length === 0) {
        throw new Error('append-plan-item: input.jobId (string) is required');
      }
      if (typeof input.description !== 'string' || input.description.trim().length === 0) {
        throw new Error('append-plan-item: input.description (string) is required');
      }
      if (!input.gate || typeof input.gate.type !== 'string' || input.gate.type.length === 0) {
        throw new Error('append-plan-item: input.gate.type (string) is required');
      }
      return opts.append(input);
    },
  };
}
