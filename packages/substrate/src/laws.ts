/**
 * The eleven declarative laws (constitution Principle VIII; intent §8.1).
 *
 * PINNED — these are failure modes, not principles. Reproduced
 * verbatim from intent spec §8.1. **DO NOT REWORD.** A test asserts
 * byte-equality of the canonical text.
 *
 * They sit compiled at the TOP of every model call's prompt (a
 * buried-laws placement failed in testing; top placement fixed it).
 */

export type LawId =
  | 'Reality'
  | 'Translation'
  | 'Judgment'
  | 'Constraint'
  | 'Feedback'
  | 'Memory'
  | 'Compounding'
  | 'Cost-Value'
  | 'Simplicity'
  | 'Uncertainty'
  | 'Standing';

export interface Law {
  readonly index: number;
  readonly id: LawId;
  readonly statement: string;
}

export const LAWS: readonly Law[] = Object.freeze([
  Object.freeze({
    index: 1,
    id: 'Reality',
    statement:
      'only reference entities present in reality; never assume facts not provided.',
  }),
  Object.freeze({
    index: 2,
    id: 'Translation',
    statement: 'state the source for external data; flag format conversions.',
  }),
  Object.freeze({
    index: 3,
    id: 'Judgment',
    statement: 'state evidence before proposing actions; no unsupported pattern matching.',
  }),
  Object.freeze({
    index: 4,
    id: 'Constraint',
    statement: 'follow the agent spec exactly; no deviations.',
  }),
  Object.freeze({
    index: 5,
    id: 'Feedback',
    statement: 'state observable success/failure criteria for every proposed action.',
  }),
  Object.freeze({
    index: 6,
    id: 'Memory',
    statement: 'reference relevant memories; state explicitly if none exist.',
  }),
  Object.freeze({
    index: 7,
    id: 'Compounding',
    statement: 'prefer the current strategy; justify any direction change.',
  }),
  Object.freeze({
    index: 8,
    id: 'Cost-Value',
    statement: 'state action cost; recommend lower-cost alternatives at 80%+ outcome.',
  }),
  Object.freeze({
    index: 9,
    id: 'Simplicity',
    statement: 'choose the fewest dependencies; justify added complexity.',
  }),
  Object.freeze({
    index: 10,
    id: 'Uncertainty',
    statement: 'state confidence levels; flag data gaps; never assume.',
  }),
  Object.freeze({
    index: 11,
    id: 'Standing',
    statement:
      'engage other lattices only within your defined role; discovering a peer is not licence to direct, interrupt, or pull on it; act within your place in the structure.',
  }),
]);

/** The eleven IDs in canonical order. Used by the compiler and tests. */
export const LAW_IDS: readonly LawId[] = LAWS.map((l) => l.id);
