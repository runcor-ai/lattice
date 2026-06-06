/**
 * @runcor/identity — persona bundle composition (Item 11).
 *
 * A lattice's Layer 1 (persona, Item 10) is composed from an ordered list
 * of named, reusable bundles rather than a single document. Each bundle
 * is a self-contained persona fragment that many lattices can share; a
 * lattice declares which bundles it composes, and the prompt builder
 * concatenates them in declared order to form the assembled Layer 1.
 *
 * Conflict rule: declared order is last-write-wins by concatenation —
 * later bundles (and the lattice's own inline seed, which always comes
 * last) appear after earlier ones and so refine them. Semantic conflict
 * detection in prose is out of scope; the inspector returns the per-part
 * breakdown so authors can spot contradictions. Composition is flat —
 * bundles do not compose other bundles. Missing bundle names are
 * surfaced, never silently dropped.
 */

export interface PersonaBundle {
  readonly name: string;
  readonly body: string;
}

export interface PersonaPart {
  readonly name: string;
  readonly chars: number;
}

/** Inspector result: the composed Layer 1 plus its provenance. */
export interface PersonaComposition {
  readonly composed: string;
  readonly parts: readonly PersonaPart[];
  /** Declared bundle names that the registry did not have. */
  readonly missing: readonly string[];
}

/** Central, editable store of persona bundles, addressable by name. */
export class PersonaBundleRegistry {
  private readonly bundles = new Map<string, string>();

  register(name: string, body: string): this {
    this.bundles.set(name, body);
    return this;
  }

  get(name: string): string | undefined {
    return this.bundles.get(name);
  }

  has(name: string): boolean {
    return this.bundles.has(name);
  }

  /** Bundle names, sorted — for the authoring/inspect surface. */
  names(): readonly string[] {
    return [...this.bundles.keys()].sort();
  }

  size(): number {
    return this.bundles.size;
  }
}

/**
 * Compose Layer 1 from an ordered list of bundle names plus the lattice's
 * own inline seed (appended last so it can refine the shared bundles).
 * Pure — the same inputs always produce the same composition, so a central
 * bundle edit propagates to every lattice on its next assembly.
 */
export function composePersona(
  registry: PersonaBundleRegistry,
  order: readonly string[],
  opts: { inline?: string } = {},
): PersonaComposition {
  const parts: PersonaPart[] = [];
  const missing: string[] = [];
  const chunks: string[] = [];

  for (const name of order) {
    const body = registry.get(name);
    if (body === undefined) {
      missing.push(name);
      continue;
    }
    const trimmed = body.trim();
    if (trimmed.length === 0) continue;
    chunks.push(trimmed);
    parts.push({ name, chars: trimmed.length });
  }

  const inline = opts.inline?.trim();
  if (inline && inline.length > 0) {
    chunks.push(inline);
    parts.push({ name: '(inline)', chars: inline.length });
  }

  return { composed: chunks.join('\n\n'), parts, missing };
}
