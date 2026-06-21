import { extractRpp } from '@runcor/decider';
import type { ModelBackend } from '@runcor/engine';
import { parse } from '@runcor/rpp-parser';
import type { RppPrompt } from '@runcor/substrate';

import type { CoachCritique, PlayerDraft } from './types.js';

/**
 * Coach — challenges the Player's draft.
 *
 * Emits an R++ critique block. The Judge reads both Player draft and
 * Coach critique before selecting.
 */
export async function runCoach(
  engine: ModelBackend,
  basePrompt: RppPrompt,
  draft: PlayerDraft,
  opts: { maxTokens?: number; abortSignal?: AbortSignal } = {},
): Promise<CoachCritique> {
  // Decisiveness coach (Finding #16). The coach is a SEPARATE voice opposing the
  // player — not the player reviewing itself. Aimed at the actual failure: the player
  // re-reads signal to avoid committing on ambiguous calls.
  const COACH_SYSTEM =
    'You are the COACH — a separate voice opposing the player, not the player reviewing itself. ' +
    'The player has a known failure: on AMBIGUOUS calls it RE-READS signal to avoid committing. ' +
    'Your job is to break that. Once the player has read the deciding signal, push it to COMMIT this ' +
    'cycle — revise, hold, or hold-with-caveat. A real but EMERGING contradiction that does not yet ' +
    'meet a call\'s kill-condition is a HELD-CAVEAT (hold the call, cite the emerging signal as watched, ' +
    'note the kill-condition not yet met) — NOT a reason to keep reading. Do not let it re-read to "be ' +
    'sure." Honest committed uncertainty is the goal. NEVER push it to fabricate a revision the signal ' +
    'does not support — an unsupported change is worse than an honest hold-with-caveat.';
  const prompt = (COACH_SYSTEM +
    '\n\n<context>\n' + basePrompt + '\n</context>\n' +
    '<dialectic role="coach">\n  Here is the player\'s current draft. Is it dodging a commit — re-reading or hedging — on an ambiguous call? Push it to COMMIT this cycle (revise / hold / hold-with-caveat) WITHOUT fabricating. Emit your critique as an R++ block.\n  <draft>\n' +
    draft.text +
    '\n  </draft>\n</dialectic>\n') as RppPrompt;
  const r = await engine.call({
    prompt,
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
  });
  return { text: r.text, parsed: parse(extractRpp(r.text)), evaluatesDraft: 0 };
}
