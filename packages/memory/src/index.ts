export * from './types.js';
export { check, isAdmissible, AdmissionRejection, type AdmissionRequest } from './admission.js';
export {
  durability,
  classify,
  DEFAULT_DECAY,
  type DecayParams,
  type DecayDecision,
} from './decay.js';
export { humanAge, freshnessCaveat, STALE_THRESHOLD_MS } from './age.js';
export { IdentityStore } from './identity-store.js';
export { EpisodicStore, type DecaySweepResult } from './episodic-store.js';
export { SemanticStore } from './semantic-store.js';
export { MemoryIndex } from './index-store.js';
export {
  recall,
  recentFirst,
  type Selector,
  type RecallRequest,
  type RecallResult,
  type RecallStores,
} from './recall.js';
export { Memory, type MemoryWriteRequest } from './memory.js';
export {
  consolidate,
  type ConsolidateContext,
  type ConsolidateResult,
} from './consolidate.js';
export {
  runSubconsciousSweep,
} from './subconscious.js';
export type {
  SweepCandidate,
  SweepContext,
  SweepRule,
  SweepResult,
  AppliedCorrection,
  SweepObservation,
} from './subconscious-types.js';
export {
  DEFAULT_RULES,
  DEPRECATION_MARKER,
  orphanIndexRowRule,
  staleSemanticMarkerRule,
  ambiguousSemanticRule,
} from './sweep-rules.js';
