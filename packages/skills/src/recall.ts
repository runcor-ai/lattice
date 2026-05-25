import type { Skill, SkillStore } from './store.js';

/**
 * Skill recall (intent §13).
 *
 * Two-step:
 *   1. The lattice is SHOWN the active skills' descriptions (the
 *      handle). Cheap — descriptions are short.
 *   2. In decide, the lattice JUDGES which fit the work in front of
 *      it. Only on choosing does the R++ body get loaded into the
 *      decide prompt.
 *
 * The selector is pluggable so slice 11 ships a deterministic
 * keyword match; later slices can swap a Decider-driven selector.
 */

export interface SkillHandle {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly abstraction: 'specific' | 'generic';
}

export type SkillSelector = (
  handles: readonly SkillHandle[],
  query: string,
  breadth: number,
) => readonly SkillHandle[];

/** Default selector — keyword score over name+description. */
export const keywordSelector: SkillSelector = (handles, query, breadth) => {
  const q = query.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return handles.slice(0, breadth);
  return handles
    .map((h) => {
      const text = `${h.name} ${h.description}`.toLowerCase();
      const score = tokens.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0);
      return { h, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, breadth)
    .map((x) => x.h);
};

export function surfaceActiveHandles(store: SkillStore): readonly SkillHandle[] {
  return store.active().map(
    (s): SkillHandle => ({
      id: s.id,
      name: s.name,
      description: s.description,
      abstraction: s.abstraction,
    }),
  );
}

/**
 * apply — load the R++ body for a chosen skill. Only call this once
 * the lattice's decide phase has selected the skill; loading is
 * priced at "you pay once you've decided" (intent §13).
 */
export function apply(store: SkillStore, skillId: string): { body_rpp: string } | null {
  const s: Skill | null = store.get(skillId);
  if (!s) return null;
  return { body_rpp: s.body_rpp };
}
