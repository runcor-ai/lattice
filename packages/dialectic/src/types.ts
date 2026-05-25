import type { ParseResult } from '@runcor/rpp-parser';

/**
 * Dialectic — three internal LLM passes per `decide()`:
 *
 *   Player drafts → Coach challenges → Judge selects.
 *
 * Each pass produces R++ that the substrate discerns. Depth > 1
 * adds further Coach rounds before Judge (slice 8 ships depth=1
 * support; deeper depths are wired the same way).
 *
 * Reuses runcor-ai/runcor-dialectic logic with attribution.
 */

export interface PlayerDraft {
  readonly parsed: ParseResult;
  readonly text: string;
}

export interface CoachCritique {
  readonly parsed: ParseResult;
  readonly text: string;
  readonly evaluatesDraft: 0; // future: index of draft this round critiques
}

export interface JudgeDecision {
  readonly parsed: ParseResult;
  readonly text: string;
}
