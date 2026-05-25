import { SingleModelDecider } from './single-model.js';
import type { Decider, DeciderDeps } from './types.js';

/**
 * selectDecider — factory.
 *
 *   dialecticDepth === 0  → SingleModelDecider (default)
 *   dialecticDepth >= 1   → DialecticDecider with that depth (slice 8)
 *
 * The dialectic implementation lives in @runcor/dialectic; we accept
 * a factory function rather than importing it directly to avoid a
 * runtime dependency cycle (dialectic imports SingleModelDecider for
 * its internal fallback at depth=0; this module imports SingleModel
 * directly).
 */
export interface SelectDeciderOptions {
  readonly dialecticDepth: number;
  readonly buildDialectic?: (deps: DeciderDeps, depth: number) => Decider;
}

export function selectDecider(deps: DeciderDeps, opts: SelectDeciderOptions): Decider {
  if (opts.dialecticDepth <= 0) {
    return new SingleModelDecider(deps);
  }
  if (!opts.buildDialectic) {
    throw new Error(
      `selectDecider: dialecticDepth=${opts.dialecticDepth} requested but no buildDialectic factory provided`,
    );
  }
  return opts.buildDialectic(deps, opts.dialecticDepth);
}
