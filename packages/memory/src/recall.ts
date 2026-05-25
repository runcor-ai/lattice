import { freshnessCaveat, humanAge } from './age.js';
import type { EpisodicStore } from './episodic-store.js';
import type { IdentityStore } from './identity-store.js';
import type { MemoryIndex } from './index-store.js';
import type { SemanticStore } from './semantic-store.js';
import type { MemoryEntry, MemoryIndexEntry, RecalledMemory } from './types.js';

/**
 * recall — pull the few relevant memories into a cycle.
 *
 * Pattern (intent §9.4 + FR-016): index-plus-cheap-selector.
 *
 *   1. Enumerate the memory_index (cheap; one line per memory).
 *   2. A `Selector` picks up to `breadth` IDs from the index. In
 *      slice 4 a default `recentFirst` selector ships; slice 8 swaps
 *      in a Decider-driven selector that judges relevance.
 *   3. Fetch the chosen memories from their respective stores.
 *   4. Attach human-readable age + freshness caveat.
 *   5. Record an access (touches `last_access_ms`, increments `f`)
 *      on each surfaced episodic memory — this is what reinforces
 *      durability in the decay formula.
 *
 * The selector is async because slice 8 will make a (cheap) model
 * call here.
 */
export type Selector = (
  index: readonly MemoryIndexEntry[],
  query: string,
  breadth: number,
) => Promise<readonly MemoryIndexEntry[]>;

export interface RecallStores {
  readonly identity: IdentityStore;
  readonly episodic: EpisodicStore;
  readonly semantic: SemanticStore;
  readonly index: MemoryIndex;
}

export interface RecallRequest {
  readonly query: string;
  readonly breadth: number;
  readonly nowMs: number;
  readonly selector?: Selector;
}

export interface RecallResult {
  readonly memories: readonly RecalledMemory[];
  readonly indexSize: number;
  readonly selectedCount: number;
}

/** Default selector: most-recent N. Slice 8 replaces with a decider. */
export const recentFirst: Selector = async (index, _query, breadth) =>
  // `listAll` already returns DESC by written_at_ms
  index.slice(0, Math.max(0, breadth));

export async function recall(
  stores: RecallStores,
  req: RecallRequest,
): Promise<RecallResult> {
  const idx = stores.index.all();
  const selector = req.selector ?? recentFirst;
  const chosen = await selector(idx, req.query, req.breadth);
  const memories: RecalledMemory[] = [];

  for (const ie of chosen) {
    const entry = lookup(stores, ie);
    if (!entry) continue;
    if (entry.system === 'episodic') {
      stores.episodic.recordAccess(entry.id, req.nowMs);
    }
    memories.push({
      entry,
      humanAge: humanAge(entry.written_at_ms, req.nowMs),
      freshnessCaveat: freshnessCaveat(entry.written_at_ms, req.nowMs),
    });
  }

  return { memories, indexSize: idx.length, selectedCount: memories.length };
}

function lookup(stores: RecallStores, ie: MemoryIndexEntry): MemoryEntry | null {
  switch (ie.memory_table) {
    case 'identity': {
      const all = stores.identity.all();
      return all.find((e) => e.id === ie.memory_id) ?? null;
    }
    case 'episodic': {
      // No single-fetch by id today; scan a recent window. Slice 5+
      // will add a by-id query when needed.
      const all = stores.episodic.all();
      return all.find((e) => e.id === ie.memory_id) ?? null;
    }
    case 'semantic': {
      return stores.semantic.get(ie.memory_id);
    }
    case 'plan_job':
    case 'plan_item': {
      // Owned by @runcor/jobs (slice 9). Surfaced through the index
      // for cross-system recall; the actual content read happens via
      // the jobs API.
      return null;
    }
    default:
      return null;
  }
}
