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

  // Emit the cycle's cognition — the grounded prompt that was sent and the
  // model's raw R++ reasoning — so the operator's thoughts box can show what
  // the lattice actually thought, not just the chosen action. Both fields are
  // truncated to keep the trace bounded.
  const promptOut = truncateCognition(String(prev.groundedPrompt), COGNITION_PROMPT_MAX);
  const reasoningOut = truncateCognition(decisionText, COGNITION_REASONING_MAX);
  ctx.trace.write({
    kind: 'cognition',
    cycle: ctx.cycle,
    at_ms: Date.now(),
    phase: 'decide',
    action: chosenName,
    prompt: promptOut.text,
    reasoning: reasoningOut.text,
    truncated: promptOut.truncated || reasoningOut.truncated,
  });

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

/** Truncation budgets for the per-cycle cognition trace entry (bytes-ish). */
const COGNITION_PROMPT_MAX = 12000;
const COGNITION_REASONING_MAX = 8000;

function truncateCognition(s: unknown, max: number): { text: string; truncated: boolean } {
  const str = typeof s === 'string' ? s : s == null ? '' : String(s);
  if (str.length <= max) return { text: str, truncated: false };
  return { text: `${str.slice(0, max)}\n…[truncated ${str.length - max} chars]`, truncated: true };
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

/**
 * Unescape the standard C/JSON escape sequences inside a quoted R++
 * string value. The lexer captures the raw source text, so a token like
 * `body: "a\nb"` arrives with a literal backslash-n; without this the
 * lattice writes the two characters `\` `n` into files instead of a
 * newline — which broke every multi-line deliverable AND the plan gate
 * (the checkbox regex needs real line breaks). Item 14.
 */
export function unescapeRppString(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|["\\/nrtbf])/g, (match, esc: string) => {
    switch (esc[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      case 'u': return String.fromCharCode(parseInt(esc.slice(1), 16));
      default: return match;
    }
  });
}

export function coerceTokenValue(value: TokenValue): unknown {
  const raw = value.raw.trim();
  const unquoted = raw.replace(/^["']|["']$/g, '');
  switch (value.type) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : unquoted;
    }
    case 'string':
      // Only quoted strings carry escape sequences; unescape them so a
      // body written through fs-write contains real newlines/quotes.
      return unescapeRppString(unquoted);
    case 'identifier':
    case 'color':
    case 'length':
    case 'unknown':
    default:
      return unquoted;
  }
}
