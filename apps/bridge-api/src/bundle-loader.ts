import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  BundleDefaultsSchema,
  StartingKnowledgeSchema,
  type Bundle,
} from '@runcor/bridge-shared';

/**
 * BundleLoader — reads `prebuilt/<role>/` directories at startup and
 * caches them.
 *
 * Each role bundle is THREE files (intent §19.2):
 *   seed-prompt.rpp           — R++ identity block
 *   starting-knowledge.json   — memories seeded at instantiation
 *   defaults.json             — dial defaults + starting tool manifest
 */

export interface BundleLoaderOptions {
  /** Root that contains the prebuilt role subdirectories. */
  readonly root: string;
}

export interface LoadOutcome {
  readonly admitted: readonly Bundle[];
  readonly rejected: readonly { id: string; reason: string }[];
}

export class BundleLoader {
  private cache: Map<string, Bundle> | null = null;
  private outcomeCache: LoadOutcome | null = null;
  constructor(private readonly opts: BundleLoaderOptions) {}

  loadAll(): LoadOutcome {
    if (this.outcomeCache) return this.outcomeCache;
    const admitted: Bundle[] = [];
    const rejected: { id: string; reason: string }[] = [];
    this.cache = new Map();

    if (!existsSync(this.opts.root)) {
      this.outcomeCache = { admitted, rejected };
      return this.outcomeCache;
    }

    const entries = readdirSync(this.opts.root, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
      try {
        const b = this.loadOne(e.name);
        admitted.push(b);
        this.cache.set(b.id, b);
      } catch (err) {
        rejected.push({
          id: e.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.outcomeCache = { admitted, rejected };
    return this.outcomeCache;
  }

  get(id: string): Bundle | undefined {
    if (!this.cache) this.loadAll();
    return this.cache?.get(id);
  }

  list(): readonly Bundle[] {
    return this.loadAll().admitted;
  }

  private loadOne(id: string): Bundle {
    const dir = join(this.opts.root, id);
    const seedPath = join(dir, 'seed-prompt.rpp');
    const knowledgePath = join(dir, 'starting-knowledge.json');
    const defaultsPath = join(dir, 'defaults.json');

    if (!existsSync(seedPath)) throw new Error(`missing seed-prompt.rpp`);
    if (!existsSync(knowledgePath)) throw new Error(`missing starting-knowledge.json`);
    if (!existsSync(defaultsPath)) throw new Error(`missing defaults.json`);

    const seedPrompt = readFileSync(seedPath, 'utf8');

    const startingRaw = JSON.parse(readFileSync(knowledgePath, 'utf8')) as unknown;
    const startingParsed = StartingKnowledgeSchema.safeParse(startingRaw);
    if (!startingParsed.success) {
      throw new Error(
        `starting-knowledge.json invalid: ${startingParsed.error.issues[0]?.message ?? 'unknown'}`,
      );
    }

    const defaultsRaw = JSON.parse(readFileSync(defaultsPath, 'utf8')) as unknown;
    const defaultsParsed = BundleDefaultsSchema.safeParse(defaultsRaw);
    if (!defaultsParsed.success) {
      throw new Error(
        `defaults.json invalid: ${defaultsParsed.error.issues[0]?.message ?? 'unknown'}`,
      );
    }

    return {
      id,
      seedPrompt,
      startingKnowledge: startingParsed.data,
      defaults: defaultsParsed.data,
    };
  }
}
