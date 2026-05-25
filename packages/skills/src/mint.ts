import type { SkillDoc, SkillFrontmatter } from './skill-md.js';
import type { SkillStore } from './store.js';

/**
 * Skill minting (intent §13; spec US11).
 *
 * When a job closes (fully OR partially), skills are extracted from
 * its PASSED items at two abstraction levels:
 *   - specific : the concrete pattern from this work.
 *   - generic  : the same pattern abstracted so it transfers.
 *
 * The generic extraction is the load-bearing one — it's what lets
 * the entity apply what it learned somewhere else.
 *
 * Slice 11 ships a pluggable `Extractor` interface. The default
 * deterministic extractor builds skills directly from the item's
 * description + completion check (no LLM). Slice 12+ can plug a
 * Decider-driven extractor for richer skills.
 */

export interface ExtractItemInput {
  readonly item_id: string;
  readonly description: string;
  readonly completion_check: string;
  readonly job_id: string;
}

export interface ExtractContext {
  readonly cycle: number;
}

export type Extractor = (item: ExtractItemInput, ctx: ExtractContext) => readonly SkillDoc[];

/**
 * defaultExtractor — slice-11 deterministic extractor.
 *
 * Produces one specific and one generic skill per passed item:
 *   - specific: name = `${slug(description)}-specific`,
 *               description = "How to ${description}",
 *               body = a minimal R++ procedure block summarising the check.
 *   - generic : name = `${slug(description)}-generic`,
 *               description abstracts away the concrete task,
 *               body parameterises the same procedure.
 */
export const defaultExtractor: Extractor = (item, ctx) => {
  const slug = slugify(item.description);
  const fmSpecific: SkillFrontmatter = {
    name: `${slug}-specific`,
    description: `How to ${item.description}`,
    abstraction: 'specific',
    minted_at_cycle: ctx.cycle,
  };
  const fmGeneric: SkillFrontmatter = {
    name: `${slug}-generic`,
    description: `Generic pattern for tasks like "${item.description}"`,
    abstraction: 'generic',
    minted_at_cycle: ctx.cycle,
  };
  const checkBlock = sanitizeForRpp(item.completion_check);
  const body =
    `BEHAVIOR ApplySkill {\n  Apply the procedure learned from item ${item.item_id}.\n` +
    `  Completion criterion (json):\n  ${checkBlock}\n}\n`;
  return [
    { frontmatter: fmSpecific, body },
    { frontmatter: fmGeneric, body },
  ];
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/^$/g, 'skill');
}

function sanitizeForRpp(s: string): string {
  // Strip control chars + braces that would confuse the parser.
  return s.replace(/[{}]/g, '').replace(/[\r\n]+/g, ' ').slice(0, 400);
}

export interface MintResult {
  readonly minted: readonly { id: string; name: string }[];
}

/**
 * mint — call with all PASSED items of a closed (or partially-closed)
 * job. Writes the produced skills to the store as `active: false`
 * (proposed). Activation is gated separately.
 */
export function mint(
  store: SkillStore,
  passedItems: readonly ExtractItemInput[],
  ctx: ExtractContext,
  extractor: Extractor = defaultExtractor,
): MintResult {
  const minted: { id: string; name: string }[] = [];
  for (const item of passedItems) {
    const docs = extractor(item, ctx);
    for (const doc of docs) {
      const added = store.add({
        frontmatter: doc.frontmatter,
        body_rpp: doc.body,
        source_job_id: item.job_id,
        source_item_id: item.item_id,
        active: false,
      });
      minted.push({ id: added.id, name: added.name });
    }
  }
  return { minted };
}
