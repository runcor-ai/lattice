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
  const prompt = (basePrompt +
    '\n<dialectic role="coach">\n  Challenge this draft. Where is it weak? What evidence is missing?\n  <draft>\n' +
    draft.text +
    '\n  </draft>\n</dialectic>\n') as RppPrompt;
  const r = await engine.call({
    prompt,
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
  });
  return { text: r.text, parsed: parse(extractRpp(r.text)), evaluatesDraft: 0 };
}
