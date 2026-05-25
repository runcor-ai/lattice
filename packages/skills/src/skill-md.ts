/**
 * SKILL.md format — Claude-style skill files (intent §13).
 *
 *   ---
 *   name: kebab-case-name
 *   description: one-line "what this is + when to use it"
 *   abstraction: specific | generic
 *   minted_at_cycle: <int>
 *   ---
 *
 *   <R++ body — the procedure>
 *
 * The frontmatter `description` is the HANDLE surfaced in recall;
 * the body is the PAYLOAD loaded only when the lattice chooses to
 * apply the skill (intent §13).
 */

export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly abstraction: 'specific' | 'generic';
  readonly minted_at_cycle: number;
}

export interface SkillDoc {
  readonly frontmatter: SkillFrontmatter;
  /** The R++ procedure body. */
  readonly body: string;
}

export function composeSkillMd(doc: SkillDoc): string {
  const fm = doc.frontmatter;
  return [
    '---',
    `name: ${fm.name}`,
    `description: ${fm.description}`,
    `abstraction: ${fm.abstraction}`,
    `minted_at_cycle: ${fm.minted_at_cycle}`,
    '---',
    '',
    doc.body,
  ].join('\n');
}

export function parseSkillMd(text: string): SkillDoc {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(text);
  if (!m) {
    throw new Error('parseSkillMd: missing frontmatter delimiters');
  }
  const fmRaw = m[1]!;
  const body = m[2]!.trim() + '\n';
  const fm: Partial<SkillFrontmatter> = {};
  for (const line of fmRaw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    switch (key) {
      case 'name':
        (fm as { name: string }).name = value;
        break;
      case 'description':
        (fm as { description: string }).description = value;
        break;
      case 'abstraction':
        if (value !== 'specific' && value !== 'generic') {
          throw new Error(`parseSkillMd: invalid abstraction "${value}"`);
        }
        (fm as { abstraction: 'specific' | 'generic' }).abstraction = value;
        break;
      case 'minted_at_cycle':
        (fm as { minted_at_cycle: number }).minted_at_cycle = Number(value);
        break;
    }
  }
  for (const key of ['name', 'description', 'abstraction', 'minted_at_cycle'] as const) {
    if ((fm as Record<string, unknown>)[key] === undefined) {
      throw new Error(`parseSkillMd: missing frontmatter field "${key}"`);
    }
  }
  return { frontmatter: fm as SkillFrontmatter, body };
}
