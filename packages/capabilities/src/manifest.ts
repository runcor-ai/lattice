import type { Capability } from './types.js';
import { validateCapability } from './types.js';

/**
 * Manifest — the lattice's starting set of capabilities (intent §15;
 * spec FR-041). An empty manifest is legal.
 *
 * Each entry is a serialized capability description; the loader uses
 * a `FactoryRegistry` to construct concrete `Capability` instances.
 *
 * Slice 10 ships factories for `echo`, `noop`, `api`, and `mcp`.
 * Operators in slice 14 can register additional factories.
 */

export interface ManifestEntry {
  readonly name: string;
  readonly kind: 'echo' | 'noop' | 'api' | 'mcp';
  readonly description?: string;
  readonly role?: { sense: boolean; action: boolean };
  readonly readOnly?: boolean;
  readonly destructive?: boolean;
  readonly concurrencySafe?: boolean;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface ManifestFile {
  readonly entries: readonly ManifestEntry[];
}

export type CapabilityFactory = (entry: ManifestEntry) => Capability<unknown, unknown>;

export class FactoryRegistry {
  private readonly factories = new Map<string, CapabilityFactory>();

  register(kind: string, factory: CapabilityFactory): this {
    this.factories.set(kind, factory);
    return this;
  }

  get(kind: string): CapabilityFactory | undefined {
    return this.factories.get(kind);
  }
}

export interface LoadResult {
  readonly accepted: readonly Capability<unknown, unknown>[];
  readonly rejected: readonly { entry: ManifestEntry; reason: string }[];
}

export function loadManifest(file: ManifestFile, registry: FactoryRegistry): LoadResult {
  const accepted: Capability<unknown, unknown>[] = [];
  const rejected: { entry: ManifestEntry; reason: string }[] = [];
  for (const entry of file.entries) {
    const factory = registry.get(entry.kind);
    if (!factory) {
      rejected.push({ entry, reason: `unknown capability kind: ${entry.kind}` });
      continue;
    }
    let cap: Capability<unknown, unknown>;
    try {
      cap = factory(entry);
    } catch (err) {
      rejected.push({
        entry,
        reason: `factory failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const v = validateCapability(cap);
    if (!v.ok) {
      rejected.push({ entry, reason: v.reason });
      continue;
    }
    accepted.push(cap);
  }
  return { accepted, rejected };
}
