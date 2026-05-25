/**
 * @runcor/substrate — enforced physics for every lattice model call.
 *
 * Constitution Principle VIII (NON-NEGOTIABLE): the substrate wraps
 * every model call; the entity cannot read, configure, or bypass it.
 *
 * Public surface — EXACTLY four functions plus their pure data types.
 * Nothing exported here lets a caller mutate substrate state. There
 * IS no substrate state to mutate — `wrap`, `discern`,
 * `assessCapability`, and `autonomyResolve` are pure functions over
 * their inputs.
 *
 * (Tests assert the no-bypass property structurally: T130 walks
 * this module's exports and asserts none is a mutator.)
 */

export { wrap, isRppPrompt, type RppPrompt, type WrapContext } from './wrap.js';
export {
  discern,
  type DiscernContext,
  type LlmLawCheck,
} from './discern.js';
export {
  autonomyResolve,
  describeResolvedAction,
  type AutonomyLevel,
  type ResolvedAction,
} from './autonomy.js';
export {
  assessCapability,
  type AssessResult,
  type CapabilityCandidate,
  type PolicyContext,
} from './assess-capability.js';

// Pure data types the rest of the build needs to read findings.
export { LAWS, LAW_IDS, type Law, type LawId } from './laws.js';
export { compileLaws, CANONICAL_LAWS_BLOCK } from './compile.js';
export type { Outcome, LawFinding, DiscernResult } from './outcomes.js';
