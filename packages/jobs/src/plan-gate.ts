import type { CompletionCheckSpec } from './types.js';

/**
 * Plan gate (Item 4) — the auto-inserted "Draft checklist plan" item
 * that forces the lattice to write a real plan before any other work on
 * a job can be signed off.
 *
 * Prose describes; items are law. A seed line can ask the lattice to
 * plan; only a gated plan_item MAKES it plan. The gate requires a plan
 * FILE that exists, is non-trivial (>= PLAN_MIN_BYTES), and contains at
 * least one markdown checkbox line — so the plan is a list of concrete
 * steps, not a paragraph of intentions. Item 5 turns those checkboxes
 * into chained items; Item 7 supplies the gate hooks used here.
 */

export const PLAN_MIN_BYTES = 500;

/** Markdown checkbox line, e.g. "- [ ] do the thing" / "- [x] done". */
export const PLAN_CHECKBOX_REGEX = '^\\s*- \\[[ xX]\\]';

export const PLAN_ITEM_TITLE = 'Draft checklist plan';

/** Plan file location, relative to the lattice's workspace write-root. */
export function planRelPath(jobId: string): string {
  return `.ai/notes/plans/${jobId}.md`;
}

/**
 * The completion check for the plan-gate item: the plan file exists and
 * is at least PLAN_MIN_BYTES, AND contains at least one checkbox line.
 * `absPlanPath` is the absolute path the runtime can stat (must match
 * where the lattice's workspace write action lands the file).
 */
export function planItemGateSpec(absPlanPath: string): CompletionCheckSpec {
  return {
    hooks: [
      { name: 'file_exists', args: { path: absPlanPath, minBytes: PLAN_MIN_BYTES } },
      { name: 'content_contains', args: { path: absPlanPath, needle: PLAN_CHECKBOX_REGEX, isRegex: true } },
    ],
  };
}

/** The directive the lattice reads in its open-items list. */
export function planItemDescription(relPath: string): string {
  return (
    `${PLAN_ITEM_TITLE}: before acting on any other item, write a checklist plan to ${relPath} ` +
    `using your workspace write action. It must be at least ${PLAN_MIN_BYTES} bytes and contain at ` +
    `least one markdown checkbox line ("- [ ] step"). List each concrete step as its own checkbox.`
  );
}
