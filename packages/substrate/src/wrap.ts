import { CANONICAL_LAWS_BLOCK } from './compile.js';

/**
 * RppPrompt — slice 5 keeps this as an opaque string-newtype so the
 * shape can tighten to a parsed R++ tree in slice 8 without changing
 * call sites. The brand discourages callers from treating it as raw
 * text.
 */
declare const RppPromptBrand: unique symbol;
export type RppPrompt = string & { readonly [RppPromptBrand]: 'RppPrompt' };

export interface WrapContext {
  /** Cycle number. Goes into the reality slice. */
  readonly cycle: number;
  /** When the cycle started (epoch ms). */
  readonly at_ms: number;
  /** Composed identity prior — drawn from identity_current. */
  readonly identityComposed: string;
  /** A short summary of the cycle's perception (sense readings). */
  readonly realitySliceSummary: string;
  /** The cycle-specific instruction. */
  readonly instruction: string;
}

/**
 * wrap — the substrate wraps every model call. Per Principle VIII +
 * intent §8: the eleven laws sit COMPILED at the TOP of every
 * prompt, followed by the identity prior, reality slice, and
 * instruction.
 *
 * The output is an `RppPrompt`. Callers MUST pass it through
 * `ModelBackend.call()` unchanged; the engine layer treats any
 * non-RppPrompt input as a violation.
 *
 * Buried laws fail (intent §8.1). The compiled block is the FIRST
 * thing in the prompt, and there is no way to suppress it: every
 * `wrap()` call composes it fresh.
 */
export function wrap(ctx: WrapContext): RppPrompt {
  const out = [
    CANONICAL_LAWS_BLOCK,
    '<identity>',
    ctx.identityComposed,
    '</identity>',
    '<reality>',
    `cycle=${ctx.cycle}`,
    `at_ms=${ctx.at_ms}`,
    ctx.realitySliceSummary,
    '</reality>',
    '<instruction>',
    ctx.instruction,
    '</instruction>',
  ].join('\n');
  return out as RppPrompt;
}

/** Test helper / type guard. */
export function isRppPrompt(x: unknown): x is RppPrompt {
  return typeof x === 'string' && x.startsWith('<laws>');
}
