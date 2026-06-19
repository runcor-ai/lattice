import { extractRpp } from '@runcor/decider';
import type { ModelBackend } from '@runcor/engine';
import { parse } from '@runcor/rpp-parser';
import type { RppPrompt } from '@runcor/substrate';

import type { CoachCritique, JudgeDecision, PlayerDraft } from './types.js';

/**
 * Judge — selects the final decision after reading Player + Coach.
 *
 * Emits the canonical R++ output. This is what the rest of the
 * cycle treats as the dialectic's `decide()` result.
 */
export async function runJudge(
  engine: ModelBackend,
  basePrompt: RppPrompt,
  draft: PlayerDraft,
  critiques: readonly CoachCritique[],
  opts: { maxTokens?: number; abortSignal?: AbortSignal } = {},
): Promise<JudgeDecision> {
  const critiqueBlock = critiques
    .map((c, i) => `  <critique idx="${i}">\n${c.text}\n  </critique>`)
    .join('\n');
  const prompt = (basePrompt +
    `\n<dialectic role="judge">\n  Read the draft and the critiques. Render the final decision as R++.\n  <draft>\n${draft.text}\n  </draft>\n${critiqueBlock}\n</dialectic>\n`) as RppPrompt;
  const r = await engine.call({
    prompt,
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
  });
  return { text: r.text, parsed: parse(extractRpp(r.text)) };
}
