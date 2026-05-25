import { ModelBackendError } from '@runcor/engine';
import type { RppDocument, TokenValue } from '@runcor/rpp-parser';

import type { CycleContext, DecideOutput, RecallOutput } from '../types.js';
import { handleUsageLimit } from '../usage-limit-handler.js';

/**
 * decide — call the configured Decider (slice 8).
 *
 * After the decider returns parsed R++, extracts:
 *   - the chosen action name from the TARGET block's `output` field
 *   - input parameters from the TOKENS block (one entry per key)
 * Without this extraction the lattice could only ever execute the
 * first registered action regardless of what it reasoned about.
 *
 * Slice 12: on `usage_limit` errors, call the usage-limit handler
 * which records an operator alert + (when a job item is in flight)
 * defers the item. The cycle still fails (caller rolls back), but
 * non-model phases on subsequent cycles keep running.
 */
export async function decide(
  ctx: CycleContext,
  prev: RecallOutput,
): Promise<DecideOutput> {
  let decision;
  try {
    decision = await ctx.decider.decide({
      prompt: prev.groundedPrompt,
      cycle: ctx.cycle,
      trace: ctx.trace,
      maxTokens: 1024,
      abortSignal: ctx.abortSignal,
    });
  } catch (err) {
    if (err instanceof ModelBackendError && err.kind === 'usage_limit') {
      handleUsageLimit(err, {
        trace: ctx.trace,
        cycle: ctx.cycle,
        at_ms: ctx.at_ms,
      });
    }
    throw err;
  }

  const decisionText = decision.output.ast.source;

  const chosenName = extractTargetOutput(decision.output.ast);
  const chosenInput = extractTokens(decision.output.ast);

  let chosenAction: string | null = null;
  if (chosenName) {
    const matched = ctx.actions.find(
      (a) => a.name === chosenName && a.role.action && a.isEnabled(),
    );
    if (matched) {
      chosenAction = matched.name;
    } else {
      ctx.trace.write({
        kind: 'operator',
        cycle: ctx.cycle,
        at_ms: Date.now(),
        action: 'lifecycle',
        detail: `decide: R++ TARGET output "${chosenName}" matched no enabled action; available: ${ctx.actions
          .filter((a) => a.role.action && a.isEnabled())
          .map((a) => a.name)
          .join(',')}`,
      });
    }
  }
  if (chosenAction === null) {
    const fallback = ctx.actions.find((a) => a.isEnabled() && a.role.action);
    chosenAction = fallback?.name ?? null;
  }

  return { ...prev, decision, decisionText, chosenAction, chosenInput };
}

function extractTargetOutput(ast: RppDocument): string | null {
  for (const block of ast.blocks) {
    if (block.kind === 'target' && typeof block.output === 'string' && block.output.length > 0) {
      const raw = block.output.trim();
      const stripped = raw.replace(/^["']|["']$/g, '');
      return stripped || null;
    }
  }
  return null;
}

function extractTokens(ast: RppDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const block of ast.blocks) {
    if (block.kind !== 'tokens') continue;
    for (const [key, value] of block.tokens) {
      out[key] = coerceTokenValue(value);
    }
  }
  return out;
}

function coerceTokenValue(value: TokenValue): unknown {
  const raw = value.raw.trim();
  const unquoted = raw.replace(/^["']|["']$/g, '');
  switch (value.type) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : unquoted;
    }
    case 'string':
    case 'identifier':
    case 'color':
    case 'length':
    case 'unknown':
    default:
      return unquoted;
  }
}
