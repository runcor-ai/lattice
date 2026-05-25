import type { Database as SqliteDb } from 'better-sqlite3';

import { type AdmissionRequest } from './admission.js';
import { EpisodicStore } from './episodic-store.js';
import { IdentityStore } from './identity-store.js';
import { MemoryIndex } from './index-store.js';
import { recall, type RecallRequest, type RecallResult } from './recall.js';
import { SemanticStore } from './semantic-store.js';
import type { MemorySystem, SemanticSource } from './types.js';

/**
 * Memory — the composed four-system store, the public surface of
 * `@runcor/memory`.
 *
 * Holds the four stores + the cross-system index. Writes go through
 * the per-store API (with admission); recall is index-plus-selector.
 *
 * Constitution Principle IV: four genuinely separate stores. This
 * class composes them but does NOT collapse them.
 */
export interface MemoryWriteRequest extends Omit<AdmissionRequest, 'system'> {
  /** When system === 'semantic'. Defaults to 'operator' on write. */
  readonly source_kind?: SemanticSource;
  /** When system === 'semantic' and source_kind === 'promoted'. */
  readonly source_ref?: string | null;
}

export class Memory {
  readonly identity: IdentityStore;
  readonly episodic: EpisodicStore;
  readonly semantic: SemanticStore;
  readonly index: MemoryIndex;

  constructor(db: SqliteDb) {
    this.identity = new IdentityStore(db);
    this.episodic = new EpisodicStore(db);
    this.semantic = new SemanticStore(db);
    this.index = new MemoryIndex(db);
  }

  /**
   * Single entry-point for the cycle's write phase. Routes to the
   * appropriate store and writes the corresponding `memory_index`
   * row in the same call (callers should ensure this is inside the
   * cycle's SQLite transaction so the two writes commit together).
   */
  write(
    system: Exclude<MemorySystem, 'plan'>,
    req: MemoryWriteRequest,
    ctx: { cycle: number; at_ms: number },
  ): { id: string; system: typeof system } {
    let id: string;
    let table: 'identity' | 'episodic' | 'semantic';
    switch (system) {
      case 'identity': {
        const e = this.identity.write(req, ctx);
        id = e.id;
        table = 'identity';
        break;
      }
      case 'episodic': {
        const e = this.episodic.write(req, ctx);
        id = e.id;
        table = 'episodic';
        break;
      }
      case 'semantic': {
        const e = this.semantic.write(
          {
            ...req,
            ...(req.source_kind !== undefined ? { source_kind: req.source_kind } : {}),
            ...(req.source_ref !== undefined ? { source_ref: req.source_ref } : {}),
          },
          ctx,
        );
        id = e.id;
        table = 'semantic';
        break;
      }
      default:
        throw new Error(`Memory.write does not own system='${system}'`);
    }
    this.index.add(table, id, req.body, ctx.at_ms);
    return { id, system };
  }

  async recall(req: RecallRequest): Promise<RecallResult> {
    return recall(
      {
        identity: this.identity,
        episodic: this.episodic,
        semantic: this.semantic,
        index: this.index,
      },
      req,
    );
  }

  /** Total memory items across all four systems + the plan_item table. */
  totalSize(): number {
    return this.identity.count() + this.episodic.totalCount() + this.semantic.totalCount();
  }
}
