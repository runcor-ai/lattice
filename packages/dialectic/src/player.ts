import { extractRpp } from '@runcor/decider';
import type { ModelBackend } from '@runcor/engine';
import { parse } from '@runcor/rpp-parser';
import type { RppPrompt } from '@runcor/substrate';

import type { PlayerDraft } from './types.js';

/**
 * Player — drafts options as an R++ block.
 *
 * Slice 8 keeps the prompt augmentation minimal: appends a `<role>`
 * tag asking the model to act as Player. Slice 11 will tighten via
 * R++ TARGET/BEHAVIOR blocks scoped to the dialectic role.
 */
export async function runPlayer(
  engine: ModelBackend,
  basePrompt: RppPrompt,
  opts: { maxTokens?: number; abortSignal?: AbortSignal } = {},
): Promise<PlayerDraft> {
  const prompt = (basePrompt +
    '\n<dialectic role="player">\n  Draft your initial decision as R++.\n</dialectic>\n') as RppPrompt;
  const r = await engine.call({
    prompt,
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
  });
  // Strip any prose/markdown around the R++ block before parsing (mirrors
  // SingleModelDecider) — raw parse fails when the model wraps R++ in text.
  return { text: r.text, parsed: parse(extractRpp(r.text)) };
}
