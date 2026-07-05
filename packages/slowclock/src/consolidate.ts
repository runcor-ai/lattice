/**
 * Consolidation — "the dream" (intent §7; spec FR-027).
 *
 * The canonical implementation now lives in @runcor/memory (the lowest common package) so both the
 * slow-clock worker and the runtime write phase call ONE implementation with no import cycle. This
 * module is a thin re-export to preserve slowclock's public API (worker.ts / index.ts unchanged).
 */
export {
  consolidate,
  type ConsolidateContext,
  type ConsolidateResult,
} from '@runcor/memory';
