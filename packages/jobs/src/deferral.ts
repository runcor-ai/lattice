import type { DeferralProposal, DeferralValidation } from './types.js';

/**
 * Deferral validation (spec FR-036).
 *
 * Permitted ONLY with both:
 *   - A valid externally-grounded reason (genuine blocker, missing
 *     dependency, contradiction in source material).
 *   - An unblock condition + a test that perception can evaluate.
 *
 * Forbidden reasons:
 *   - "this was hard" / "too difficult" / variants
 *   - "I judged it unnecessary"
 *   - "don't want to" / "not interested"
 *
 * Slice 9 ships a deterministic regex check; slice 11 can plug an
 * LLM fallback for ambiguous wording.
 */

const FORBIDDEN_REASON_PATTERNS: readonly RegExp[] = [
  /\bthis (?:was|is) (?:too )?hard\b/i,
  /\btoo difficult\b/i,
  /\bi (?:don'?t|do not) (?:feel like|want to)\b/i,
  /\bnot interested\b/i,
  /\bi (?:judged|decided) (?:it )?unnecessary\b/i,
  /\bdoesn'?t matter\b/i,
];

const VALID_REASON_HINTS: readonly RegExp[] = [
  /\bwaiting (?:on|for)\b/i,
  /\bmissing\b/i,
  /\bblocked by\b/i,
  /\bbudget figure\b/i,
  /\bstakeholder\b/i,
  /\bdependency\b/i,
  /\bcontradiction\b/i,
  /\bawaiting\b/i,
  /\bunavailable\b/i,
  /\bnot yet\b/i,
];

export function validateDeferral(proposal: DeferralProposal): DeferralValidation {
  if (!proposal.reason || proposal.reason.trim() === '') {
    return { admit: false, reason: 'empty deferral reason' };
  }
  if (!proposal.unblockCondition || proposal.unblockCondition.trim() === '') {
    return { admit: false, reason: 'empty unblock condition' };
  }
  if (!proposal.unblockTest || proposal.unblockTest.trim() === '') {
    return { admit: false, reason: 'empty unblock test' };
  }
  for (const re of FORBIDDEN_REASON_PATTERNS) {
    if (re.test(proposal.reason)) {
      return {
        admit: false,
        reason: `deferral reason matches forbidden pattern: ${re.source}`,
      };
    }
  }
  // Must contain at least one valid-reason hint OR pass a length+specificity check.
  const hasHint = VALID_REASON_HINTS.some((re) => re.test(proposal.reason));
  if (!hasHint && proposal.reason.length < 20) {
    return {
      admit: false,
      reason: 'deferral reason lacks externally-grounded specificity (slice-9 deterministic check; LLM fallback in slice 11)',
    };
  }
  return { admit: true };
}
