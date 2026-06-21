import type { AutonomyLevel } from '@runcor/substrate';

import type { Checklist } from './checklist.js';
import type { Item, Job } from './types.js';

/**
 * Sign-off (spec FR-039).
 *
 * Closure paths branch on the autonomy dial:
 *   - high   → lattice closes itself (no operator confirmation).
 *   - medium → lattice closes itself, escalates a confirmation entry
 *              for the operator to see post-hoc.
 *   - low    → lattice does NOT close; signals pending confirmation
 *              and waits for an explicit operatorApproved call.
 *
 * The "partially complete" mode (FR-037) is automatic when any items
 * are still deferred at closure time.
 */

export type ClosureMode = 'full' | 'partial';

/**
 * #17 — a job's completion CONTRACT is the items handed to it (by the operator,
 * plus runtime-inserted `system` gates), NOT the entity's own planning. The
 * entity decomposes work into `plan_step` / `lattice_appended` sub-items freely —
 * that is how it thinks, and it is good. But those self-added items must NOT gate
 * job-close: otherwise the entity holds its own job open indefinitely by appending
 * sub-tasks (observed 2026-06-21 — a forecast job's operator deliverable PASSED,
 * but 8 self-added plan_steps held the job open while the entity churned
 * close-job-item). Closure keys on contract items only; the entity's planning is
 * ignored for close, not suppressed.
 */
const ENTITY_SELF_ADDED: ReadonlySet<string> = new Set(['plan_step', 'lattice_appended']);
function isContractItem(i: Item): boolean {
  return !ENTITY_SELF_ADDED.has(i.source);
}

export interface ClosureRequest {
  readonly jobId: string;
  readonly cycle: number;
  readonly at_ms: number;
  readonly autonomy: AutonomyLevel;
  /** Operator explicitly approving the close (low-autonomy path). */
  readonly operatorApproved?: boolean;
}

export type ClosureResult =
  | { result: 'closed'; mode: ClosureMode; job: Job; escalated: boolean }
  | { result: 'pending_operator'; mode: ClosureMode; reason: string }
  | { result: 'not_ready'; reason: string };

/**
 * Attempt to close a job. Returns:
 *   - 'closed'           — the job is closed (status = closed_full or closed_partial).
 *   - 'pending_operator' — at autonomy=low without operatorApproved=true.
 *   - 'not_ready'        — there are still `open` items (neither passed nor deferred).
 */
export function attemptClose(
  checklist: Checklist,
  req: ClosureRequest,
): ClosureResult {
  const job = checklist.getJob(req.jobId);
  if (!job) return { result: 'not_ready', reason: `job ${req.jobId} not found` };
  if (job.status !== 'open') {
    return { result: 'not_ready', reason: `job already ${job.status}` };
  }

  const items = checklist.items(req.jobId);
  // #17 — only the completion CONTRACT (operator/system items) gates closure;
  // the entity's own plan_step / lattice_appended scaffolding does not. Defensive
  // fallback: if a job somehow has NO contract items, gate on all items so an
  // entity-only checklist is never closed vacuously.
  const contract = items.filter(isContractItem);
  const gating = contract.length > 0 ? contract : items;
  const openItems = gating.filter((i) => i.state === 'open');
  if (openItems.length > 0) {
    return {
      result: 'not_ready',
      reason: `${openItems.length} contract item(s) still open; cannot close yet`,
    };
  }
  const deferred = gating.filter((i) => i.state === 'deferred');
  const mode: ClosureMode = deferred.length === 0 ? 'full' : 'partial';
  const status = mode === 'full' ? 'closed_full' : 'closed_partial';

  if (req.autonomy === 'low' && !req.operatorApproved) {
    return {
      result: 'pending_operator',
      mode,
      reason: `autonomy=low: ${itemsSummary(gating)}`,
    };
  }

  checklist.closeJobWith(req.jobId, { status, cycle: req.cycle, at_ms: req.at_ms });
  const refreshed = checklist.getJob(req.jobId)!;
  // autonomy=medium closes itself but flags an escalation so the
  // operator sees the close post-hoc (FR-039). high closes silently;
  // low never reaches here without operatorApproved (handled above).
  return { result: 'closed', mode, job: refreshed, escalated: req.autonomy === 'medium' };
}

function itemsSummary(items: readonly Item[]): string {
  const passed = items.filter((i) => i.state === 'passed').length;
  const deferred = items.filter((i) => i.state === 'deferred').length;
  return `${passed} passed, ${deferred} deferred`;
}
