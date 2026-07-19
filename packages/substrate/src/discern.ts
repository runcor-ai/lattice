import { LAW_IDS, type LawId } from './laws.js';
import { combine, type DiscernResult, type LawFinding } from './outcomes.js';

/**
 * The discernment gate (constitution Principle VIII; spec FR-020/021).
 *
 * Per-law evaluation, code-first:
 *   - Reality, Constraint: ALWAYS block on violation.
 *   - Uncertainty: warning only (pass with annotation).
 *   - Simplicity: advisory only — NEVER blocks.
 *   - Others: modify or block as appropriate.
 *
 * Slice 5 ships code-only checks: structural / pattern-based
 * heuristics that catch the obvious failure modes. The LLM fallback
 * is wired in slice 8 when the Decider exists — `discern()` already
 * accepts an optional `llmCheck` callback for that.
 */

export interface DiscernContext {
  /** Entities known to be in the cycle's reality slice (perception). */
  readonly realityEntities: ReadonlySet<string>;
  /** Identity / agent-spec constraints to enforce. Free-text for slice 5. */
  readonly constraintSummary: string;
  /** Memories referenced this cycle (memory IDs the recall surfaced). */
  readonly recalledMemoryIds: ReadonlySet<string>;
  /** The lattice's current dial values that this gate consults. */
  readonly dials: {
    readonly autonomy: 'low' | 'medium' | 'high';
  };
}

/** Optional LLM fallback wired in slice 8. */
export type LlmLawCheck = (
  law: LawId,
  output: string,
  ctx: DiscernContext,
) => Promise<LawFinding>;

/**
 * Per-law code checks. Each returns a LawFinding. They MUST be cheap:
 * no allocations beyond a few regex matches, no I/O, no model calls.
 */
type LawChecker = (output: string, ctx: DiscernContext) => LawFinding;

const passFor = (law: LawId, reason = 'no violation detected'): LawFinding => ({
  law,
  source: 'code',
  outcome: 'pass',
  reason,
});

const CHECKERS: Record<LawId, LawChecker> = {
  Reality: (output, ctx) => {
    // Block if the output references "entity X" / "the X" patterns
    // pointing at names not in the reality set. Simple heuristic for
    // slice 5: scan double-quoted proper-noun-ish tokens against the
    // reality set, but only when the output also contains
    // proposal-language ("I propose", "next action", "I will").
    const proposalMarker = /\b(i propose|i will|next action|decision:|action:)\b/i.test(output);
    if (!proposalMarker) return passFor('Reality', 'no proposal — no entity claim to verify');

    const quotedNames = [...output.matchAll(/"([A-Z][\w\- ]{1,60})"/g)].map((m) => m[1]!);
    const fabricated = quotedNames.filter((n) => !ctx.realityEntities.has(n));
    if (fabricated.length > 0) {
      return {
        law: 'Reality',
        source: 'code',
        outcome: 'block',
        reason: `output references entities not in reality: ${fabricated.join(', ')}`,
      };
    }
    return passFor('Reality');
  },
  Translation: (output) => {
    // Flag external-data mentions without a source cite.
    if (/\b(external|API|fetched|imported|downloaded)\b/i.test(output)) {
      if (!/\b(source:|cited from|per |from)\b/i.test(output)) {
        return {
          law: 'Translation',
          source: 'code',
          outcome: 'modify',
          reason: 'external data referenced without a stated source',
        };
      }
    }
    return passFor('Translation');
  },
  Judgment: (output) => {
    // If the output proposes an action, evidence must be stated before it.
    const lines = output.split('\n').map((s) => s.trim());
    const actionIdx = lines.findIndex((l) => /^(action:|decision:|i will|i propose)/i.test(l));
    if (actionIdx === -1) return passFor('Judgment', 'no action proposed');
    const before = lines.slice(0, actionIdx).join(' ');
    if (!/\b(because|evidence:|given|since|observed|noted)\b/i.test(before)) {
      return {
        law: 'Judgment',
        source: 'code',
        outcome: 'modify',
        reason: 'action proposed without evidence stated before it',
      };
    }
    return passFor('Judgment');
  },
  Constraint: (output, ctx) => {
    // Block if the output explicitly contradicts a stated constraint.
    if (
      ctx.constraintSummary &&
      /\b(ignoring|override|bypass|disregard)\b/i.test(output) &&
      output.toLowerCase().includes('spec')
    ) {
      return {
        law: 'Constraint',
        source: 'code',
        outcome: 'block',
        reason: 'output proposes ignoring/overriding the agent spec',
      };
    }
    return passFor('Constraint');
  },
  Feedback: (output) => {
    // If an action is proposed, success/failure criteria must be stated.
    if (/^(action:|decision:|i will|i propose)/im.test(output)) {
      if (!/\b(success:|failure:|criteria:|expected outcome:|measured by)\b/i.test(output)) {
        return {
          law: 'Feedback',
          source: 'code',
          outcome: 'modify',
          reason: 'action proposed without success/failure criteria',
        };
      }
    }
    return passFor('Feedback');
  },
  Memory: (output, ctx) => {
    // If memories WERE recalled, the output should reference them OR
    // state explicitly that none applied.
    if (ctx.recalledMemoryIds.size === 0) return passFor('Memory', 'no memories surfaced this cycle');
    if (!/\b(memory:|prior:|recall:|recalled|no relevant memory)\b/i.test(output)) {
      return {
        law: 'Memory',
        source: 'code',
        outcome: 'modify',
        reason: 'memories were available but not referenced',
      };
    }
    return passFor('Memory');
  },
  Compounding: (output) => {
    // Flag direction changes without justification.
    if (/\b(pivot|reverse course|new strategy|change direction|abandon plan)\b/i.test(output)) {
      if (!/\b(because|justified by|reason:|driven by)\b/i.test(output)) {
        return {
          law: 'Compounding',
          source: 'code',
          outcome: 'modify',
          reason: 'direction change without justification',
        };
      }
    }
    return passFor('Compounding');
  },
  'Cost-Value': (output) => {
    if (/^(action:|decision:|i will|i propose)/im.test(output)) {
      if (!/\b(cost:|cheaper:|alternative:|estimated)\b/i.test(output)) {
        return {
          law: 'Cost-Value',
          source: 'code',
          outcome: 'modify',
          reason: 'action proposed without stated cost',
        };
      }
    }
    return passFor('Cost-Value');
  },
  Simplicity: (output) => {
    // ADVISORY ONLY (FR-021). Never blocks; never returns modify.
    // Pass + reason annotation for audit.
    if (/\b(add (a )?new (library|dependency|framework|module))\b/i.test(output)) {
      if (!/\b(because|justified|needed for|required by)\b/i.test(output)) {
        return passFor('Simplicity', 'advisory: new dependency added without justification');
      }
    }
    return passFor('Simplicity');
  },
  Uncertainty: (output) => {
    // Warning only — return pass with a reason flag.
    if (/\b(maybe|might|possibly|i guess|i think)\b/i.test(output)) {
      if (!/\b(confidence:|likelihood:|probability:|certainty:)\b/i.test(output)) {
        return passFor('Uncertainty', 'warning: hedging language without stated confidence');
      }
    }
    return passFor('Uncertainty');
  },
  Standing: (output) => {
    // Block if the output attempts to direct another lattice the
    // entity has no standing over.
    if (/\b(i (instruct|direct|order|command|tell) the (other |peer )?lattice)\b/i.test(output)) {
      return {
        law: 'Standing',
        source: 'code',
        outcome: 'block',
        reason: 'output attempts to direct a peer lattice without established standing',
      };
    }
    return passFor('Standing');
  },
};

/**
 * FIX-004 (2026-07-18): run a single named law's code-check against the output.
 * Exposed so pre-act gating in `runtime/phases/act.ts` can invoke ONLY the
 * promoted-to-gate laws (currently just Standing) without running the full
 * 11-law discern() batch. The observe-only laws stay running in judge()
 * post-act as before — this doesn't disable them, it just adds the option
 * for callers to fire specific laws early.
 *
 * Per-law audit at FIX-004 time: only Standing passed the safe-to-gate bar.
 * Reality/Constraint/Memory/Judgment/Feedback/Cost-Value/Translation/Compounding
 * all have false-positive triggers on benign verdict prose (documented in FIXLOG
 * FIX-004 entry — Constraint is the worst offender, matching "specification"
 * because of a missing word-boundary on "spec"). Do NOT add those to gatingCheck
 * without a trigger-tightening follow-on first.
 */
export function gatingCheck(
  law: LawId,
  output: string,
  ctx: DiscernContext,
): LawFinding {
  return CHECKERS[law](output, ctx);
}

export async function discern(
  output: string,
  ctx: DiscernContext,
  llmCheck?: LlmLawCheck,
): Promise<DiscernResult> {
  const findings: LawFinding[] = [];
  for (const id of LAW_IDS) {
    const codeFinding = CHECKERS[id](output, ctx);
    // Slice 8: when codeFinding has source 'code' AND is non-pass but
    // the rule is uncertain, fall back to llmCheck. For slice 5 the
    // llmCheck hook is plumbed but never invoked.
    if (codeFinding.outcome === 'pass' && llmCheck) {
      // No LLM call needed when code already passed.
    }
    findings.push(codeFinding);
  }
  return {
    outcome: combine(findings),
    findings,
    acceptedText: output,
  };
}
