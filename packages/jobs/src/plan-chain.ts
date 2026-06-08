import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { Checklist } from './checklist.js';
import { parseSpec, serializeSpec } from './completion-check.js';
import type { CompletionCheckSpec, Item } from './types.js';

/**
 * Plan chaining (Item 5).
 *
 * When the Item 4 plan gate passes, the plan file's checkboxes become
 * their own ordered `plan_item`s: step N is `blocked_by` step N-1, so the
 * lattice cannot skip ahead. Each step is gated by a deliverable —
 * either a gate the step declares inline (Item 7 vocabulary) or, if it
 * declares none, a per-step marker file. The plan stops being prose
 * advice and becomes the actual sequence of gates the lattice must
 * satisfy in order.
 */

export interface PlanStep {
  readonly description: string;
  /** Inline gate declaration, or null when the step declares none. */
  readonly gate: { name: string; args: Record<string, unknown> } | null;
}

const CHECKBOX_LINE = /^\s*- \[[ xX]\]\s+(.*?)\s*$/;
const GATE_ANNOTATION = /\{\{gate:\s*([^}]*)\}\}/;

/**
 * Parse a markdown plan into ordered steps. Each checkbox line is a step.
 * A trailing `{{gate:<hook> key=val, key2=val2}}` (or `{{gate:manual_review}}`)
 * declares the step's machine-checkable definition-of-done; values that
 * look numeric are coerced to numbers. Args are comma-separated so a
 * value may itself contain spaces (e.g. `command=npm test`).
 */
export function parsePlanSteps(text: string): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = CHECKBOX_LINE.exec(raw);
    if (!m) continue;
    let description = m[1]!;
    let gate: PlanStep['gate'] = null;
    const g = GATE_ANNOTATION.exec(description);
    if (g) {
      description = description.replace(GATE_ANNOTATION, '').trim();
      gate = parseGateSpec(g[1]!);
    }
    steps.push({ description, gate });
  }
  return steps;
}

function parseGateSpec(spec: string): { name: string; args: Record<string, unknown> } {
  const trimmed = spec.trim();
  const sp = trimmed.indexOf(' ');
  const name = sp === -1 ? trimmed : trimmed.slice(0, sp);
  const argsPart = sp === -1 ? '' : trimmed.slice(sp + 1);
  const args: Record<string, unknown> = {};
  if (argsPart) {
    for (const pair of argsPart.split(',')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const key = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      args[key] = /^\d+$/.test(val) ? Number(val) : val;
    }
  }
  return { name, args };
}

function buildStepGate(
  step: PlanStep,
  workspaceRoot: string,
): { spec: CompletionCheckSpec; descSuffix: string } {
  if (step.gate) {
    if (step.gate.name === 'manual_review') {
      // No machine gate — stays open until an operator passes it (Item 7
      // open question; operator-pass path is Item 8 / future).
      return {
        spec: { hooks: [{ name: 'always_fail', args: { reason: 'manual_review' } }] },
        descSuffix: ' [manual review — stays open until an operator passes it]',
      };
    }
    // Resolve filesystem args relative to the workspace write-root so the
    // gate stats what the lattice actually wrote.
    const args: Record<string, unknown> = { ...step.gate.args };
    for (const key of ['path', 'cwd'] as const) {
      const v = args[key];
      if (typeof v === 'string' && v.length > 0 && !isAbsolute(v)) {
        args[key] = join(workspaceRoot, v);
      }
    }
    return { spec: { hooks: [{ name: step.gate.name, args }] }, descSuffix: '' };
  }
  // Fallback: a prose step with no machine-checkable definition-of-done
  // (e.g. "spot-check a total", "close item X"). Gate it on an explicit,
  // justified close-job-item — NOT a ceremonial marker file. Ordering is
  // already enforced by blocked_by, and the job's real deliverable items
  // keep their own machine gates, so a content-free `.step-N.done` marker
  // added no verification: it only created the marker-chase deadlock when a
  // lattice produced the deliverable but declined the ritual. See the
  // `step_acknowledged` registration in completion-check.ts.
  return {
    spec: { hooks: [{ name: 'step_acknowledged', args: {} }] },
    descSuffix:
      ` (no deliverable file to gate on — when this step's work is done, close it` +
      ` with close-job-item and a one-line justification; no marker file needed)`,
  };
}

/**
 * onPlanFileReady — the single trigger point (spec Item 5). Fires when
 * the plan gate item transitions to passed. Idempotent: it appends the
 * chained `plan_step` items exactly once per job (re-derivation on a
 * rewritten plan is deferred — see grounding doc). Returns how many
 * items it appended.
 */
export function onPlanFileReady(checklist: Checklist, planGateItem: Item): { appended: number } {
  const jobId = planGateItem.job_id;
  // Idempotency — never chain twice.
  if (checklist.items(jobId).some((it) => it.source === 'plan_step')) {
    return { appended: 0 };
  }
  // Recover the absolute plan path from the gate's file_exists hook.
  let planPath = '';
  try {
    const gateSpec = parseSpec(planGateItem.completion_check);
    const fileHook = gateSpec.hooks.find((h) => h.name === 'file_exists');
    if (typeof fileHook?.args?.path === 'string') planPath = fileHook.args.path;
  } catch {
    return { appended: 0 };
  }
  if (!planPath) return { appended: 0 };

  let text: string;
  try {
    text = readFileSync(planPath, 'utf8');
  } catch {
    return { appended: 0 };
  }

  // <root>/.ai/notes/plans/<jobId>.md → <root>
  const workspaceRoot = resolve(dirname(planPath), '..', '..', '..');
  const steps = parsePlanSteps(text);

  let prevId: string | null = null;
  let appended = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const { spec, descSuffix } = buildStepGate(steps[i]!, workspaceRoot);
    const item = checklist.addItem(jobId, {
      description: `${steps[i]!.description}${descSuffix}`,
      completion_check: serializeSpec(spec),
      source: 'plan_step',
      blocked_by: prevId,
    });
    prevId = item.id;
    appended += 1;
  }
  return { appended };
}
