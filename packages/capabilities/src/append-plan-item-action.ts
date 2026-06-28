import {
  REGISTERED_HOOK_NAMES,
  isRegisteredHookName,
  type RegisteredHookName,
} from './gate-hook-names.js';
import type {
  ActContext,
  Capability,
  PermissionContext,
  PermissionResult,
} from './types.js';

/**
 * AppendPlanItemAction (Item 8) — let the lattice append a new gated item
 * to one of its OPEN jobs mid-cycle: to refine a step into sub-steps, or
 * to capture work the original plan missed.
 *
 * Like close-job-item, the runtime injects the actual append callback (a
 * JobsService.appendLatticeItem wrapper) so this package stays free of a
 * jobs-runtime dependency. The callback runs the same validation + audit
 * the bridge endpoint does; this capability is just the lattice's
 * in-process door to it.
 *
 * ### Three accepted input shapes for `gate`
 *
 * Because R++ TOKENS is a flat scalar-only grammar (it has no native
 * nested-object syntax), an architect that writes the natural
 * `gate: { type: "...", args: { ... } }` produces a token whose value is
 * a literal STRING, not an object. Run-1 of the ABC port hit this across
 * dozens of cycles: the architect emitted correct schema; the parser
 * silently stringified it; the validator rejected what it couldn't
 * recognise. This action now accepts THREE input shapes — the flat-key
 * form is the RECOMMENDED one for R++ callers because it has the
 * smallest escaping surface:
 *
 *   1. RECOMMENDED — flat keys. Two top-level R++ tokens:
 *        gate_type: "file_exists"
 *        gate_args_json: '{"path":"/abs/x","minBytes":500}'
 *      (`gate_args_json` is optional; absent means `{}`.)
 *
 *   2. JSON-stringified `gate`. A single R++ token whose value is a
 *      JSON-stringified gate object:
 *        gate: '{"type":"file_exists","args":{"path":"/abs/x"}}'
 *
 *   3. Real object (non-R++ callers — bridge HTTP endpoint, tests):
 *        gate: { type: "file_exists", args: { path: "/abs/x" } }
 *
 * All three normalise to the same internal shape before the append
 * callback runs. On any malformed input the validator emits a
 * self-correcting error that echoes the received value, the valid
 * `type` values (from REGISTERED_HOOK_NAMES — single source of truth),
 * and both R++-native shapes that work.
 */

export interface AppendPlanItemInput {
  readonly jobId: string;
  readonly description: string;
  /** Gate from REGISTERED_HOOK_NAMES; e.g. { type: 'file_exists', args: { path: '...' } }. */
  readonly gate: { type: string; args?: Record<string, unknown> };
  /** Optional id of an existing item on the same job that must pass first. */
  readonly blockedBy?: string;
  readonly why?: string;
}

export interface AppendPlanItemResult {
  readonly ok: boolean;
  readonly itemId?: string;
  readonly reason?: string;
}

export interface AppendPlanItemOptions {
  readonly name?: string;
  readonly append: (
    input: AppendPlanItemInput,
  ) => AppendPlanItemResult | Promise<AppendPlanItemResult>;
}

/**
 * Loose shape of the raw input as it arrives from the decider — fields may
 * be missing or string-typed where the canonical schema wants objects.
 * Normalisation reconciles the three accepted forms into `AppendPlanItemInput`.
 */
interface RawAppendInput {
  readonly jobId?: unknown;
  readonly description?: unknown;
  readonly gate?: unknown;
  readonly gate_type?: unknown;
  readonly gate_args_json?: unknown;
  readonly blockedBy?: unknown;
  readonly why?: unknown;
}

export function makeAppendPlanItemAction(
  opts: AppendPlanItemOptions,
): Capability<AppendPlanItemInput, AppendPlanItemResult> {
  const name = opts.name ?? 'append-plan-item';
  return {
    name,
    description: buildDescription(),
    role: { sense: false, action: true },
    readOnly: false,
    destructive: false,
    concurrencySafe: false,
    isEnabled: () => true,
    canInvoke: (_ctx: PermissionContext): PermissionResult => ({ allow: true }),
    async invoke(
      rawInput: AppendPlanItemInput,
      _ctx: ActContext,
    ): Promise<AppendPlanItemResult> {
      const normalised = normaliseInput(rawInput as RawAppendInput);
      return opts.append(normalised);
    },
  };
}

/* ============================== normalisation ============================== */

function normaliseInput(input: RawAppendInput): AppendPlanItemInput {
  // jobId + description — required scalars, identical across all input shapes.
  if (!input || typeof input.jobId !== 'string' || input.jobId.length === 0) {
    throw new Error('append-plan-item: input.jobId (string) is required');
  }
  if (typeof input.description !== 'string' || input.description.trim().length === 0) {
    throw new Error('append-plan-item: input.description (string) is required');
  }

  const gate = resolveGate(input);

  const out: AppendPlanItemInput = {
    jobId: input.jobId,
    description: input.description,
    gate,
    ...(typeof input.blockedBy === 'string' && input.blockedBy.length > 0
      ? { blockedBy: input.blockedBy }
      : {}),
    ...(typeof input.why === 'string' ? { why: input.why } : {}),
  };
  return out;
}

/**
 * Resolve `gate` from any of the three accepted input shapes. Throws a
 * self-correcting error on any malformed input.
 */
function resolveGate(input: RawAppendInput): {
  type: string;
  args?: Record<string, unknown>;
} {
  // SHAPE 1 — flat keys (recommended for R++ callers). Takes precedence when
  // gate_type is present and gate is absent (or empty), so a caller mixing
  // forms gets unambiguous behaviour.
  if (
    typeof input.gate_type === 'string' &&
    (input.gate === undefined || input.gate === null || input.gate === '')
  ) {
    const type = input.gate_type;
    if (!isRegisteredHookName(type)) {
      throw new Error(formatGateError({ received: input, parseError: null }));
    }
    const argsRaw = input.gate_args_json;
    if (argsRaw === undefined || argsRaw === null || argsRaw === '') {
      return { type, args: {} };
    }
    if (typeof argsRaw !== 'string') {
      throw new Error(
        formatGateError({
          received: input,
          parseError: `gate_args_json must be a JSON string; received ${typeof argsRaw}`,
        }),
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsRaw);
    } catch (err) {
      throw new Error(
        formatGateError({
          received: input,
          parseError: `gate_args_json: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
    }
    if (!isPlainObject(parsed)) {
      throw new Error(
        formatGateError({
          received: input,
          parseError: 'gate_args_json must parse to a JSON object (not array/string/null)',
        }),
      );
    }
    return { type, args: parsed };
  }

  // SHAPE 2 — JSON-stringified gate (R++ alternative).
  if (typeof input.gate === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.gate);
    } catch (err) {
      throw new Error(
        formatGateError({
          received: input,
          parseError: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return validateGateObject(parsed, input);
  }

  // SHAPE 3 — real object (bridge HTTP endpoint, direct callers, tests).
  return validateGateObject(input.gate, input);
}

function validateGateObject(
  gate: unknown,
  fullInput: RawAppendInput,
): { type: string; args?: Record<string, unknown> } {
  if (!isPlainObject(gate)) {
    throw new Error(formatGateError({ received: fullInput, parseError: null }));
  }
  const type = (gate as { type?: unknown }).type;
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error(formatGateError({ received: fullInput, parseError: null }));
  }
  if (!isRegisteredHookName(type)) {
    throw new Error(formatGateError({ received: fullInput, parseError: null }));
  }
  const args = (gate as { args?: unknown }).args;
  if (args !== undefined && !isPlainObject(args)) {
    throw new Error(
      formatGateError({
        received: fullInput,
        parseError: 'gate.args must be a plain object (or omitted)',
      }),
    );
  }
  return {
    type: type as RegisteredHookName,
    ...(isPlainObject(args) ? { args: args as Record<string, unknown> } : {}),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ============================== error message ============================== */

/**
 * Self-correcting error message. Every rejection echoes:
 *   - what the validator received (type + preview),
 *   - the full list of valid `gate.type` values (from REGISTERED_HOOK_NAMES),
 *   - the RECOMMENDED flat-key R++ shape (least escaping surface),
 *   - the JSON-string alternative (with an escaping note),
 *   - context-specific hints — JS-object-literal detection vs JSON parse error
 *     vs the R++ silent-flattening trap that killed run-1.
 *
 * Run-1 burned dozens of cycles because the error said only
 * `input.gate.type (string) is required`. After this change a single
 * rejection carries everything the architect needs to recover next cycle.
 */
function formatGateError(ctx: {
  received: RawAppendInput;
  parseError: string | null;
}): string {
  const lines: string[] = [];
  lines.push('append-plan-item: gate is malformed.');
  lines.push('');
  lines.push(`Received: ${describeReceived(ctx.received)}`);
  if (ctx.parseError) {
    lines.push(`Parse error: ${ctx.parseError}`);
  }
  lines.push('');
  lines.push(`Valid gate.type values: ${REGISTERED_HOOK_NAMES.join(', ')}`);
  lines.push('');
  lines.push('RECOMMENDED form — flat keys (least escaping surface; R++-native):');
  lines.push('  TOKENS {');
  lines.push('    gate_type: "file_exists"');
  lines.push('    gate_args_json: \'{"path":"/abs/path","minBytes":500}\'');
  lines.push('  }');
  lines.push('  // gate_args_json is optional; omit for step_acknowledged / always_pass / always_fail.');
  lines.push('');
  lines.push('ALTERNATIVE form — gate as a JSON-stringified object:');
  lines.push('  TOKENS {');
  lines.push('    gate: \'{"type":"file_exists","args":{"path":"/abs/path"}}\'');
  lines.push('  }');
  lines.push('');
  lines.push(diagnoseLikelyMistake(ctx.received, ctx.parseError));
  return lines.join('\n');
}

function describeReceived(input: RawAppendInput): string {
  const g = input.gate;
  if (typeof g === 'string') {
    const head = g.length > 80 ? `${g.slice(0, 77)}...` : g;
    return `gate as string (${g.length} chars): ${JSON.stringify(head)}`;
  }
  if (g === undefined || g === null) {
    if (typeof input.gate_type === 'string') {
      return `gate absent; gate_type=${JSON.stringify(input.gate_type)}; gate_args_json=${describeShort(input.gate_args_json)}`;
    }
    return 'gate absent and no gate_type / gate_args_json fallback provided';
  }
  if (Array.isArray(g)) {
    return `gate as array (${g.length} elements) — expected an object or a JSON-stringified object`;
  }
  if (typeof g === 'object') {
    const type = (g as { type?: unknown }).type;
    if (type === undefined) {
      return `gate as object with NO 'type' key (keys: ${Object.keys(g as object).join(', ') || '<none>'})`;
    }
    if (typeof type !== 'string') {
      return `gate as object with non-string type (typeof type = ${typeof type})`;
    }
    return `gate as object with type=${JSON.stringify(type)} (not a registered hook name)`;
  }
  return `gate of unsupported type ${typeof g}`;
}

function describeShort(v: unknown): string {
  if (v === undefined) return '<absent>';
  if (typeof v === 'string') {
    const head = v.length > 60 ? `${v.slice(0, 57)}...` : v;
    return JSON.stringify(head);
  }
  return `<${typeof v}>`;
}

function diagnoseLikelyMistake(
  input: RawAppendInput,
  parseError: string | null,
): string {
  const g = input.gate;
  if (typeof g === 'string') {
    // Highest-priority case: looks like a JS object literal with unquoted
    // keys. That's the run-1 pattern: R++ TOKENS silently flattened the
    // architect's nested object into a string with JS-literal syntax.
    if (/^\s*\{\s*[a-zA-Z_][\w-]*\s*:/.test(g)) {
      return [
        'Hint: this looks like a JavaScript object literal with unquoted keys, not JSON.',
        'If you wrote `gate: { type: "..." }` as a nested object in TOKENS, the R++ parser',
        "silently flattened it to a string before this validator saw it. R++ TOKENS doesn't",
        'support nested objects. Use the RECOMMENDED flat-key form above, OR a properly',
        'JSON-stringified gate with quoted keys: \'{"type":"file_exists",...}\'.',
      ].join('\n');
    }
    // Any JSON parse failure → recovery hint. Node's JSON.parse error wording
    // varies by version/cause, so we match on parseError presence rather than
    // wording. If the parse error or the input mentions a backslash, add the
    // escaping-specific note.
    if (parseError !== null) {
      const looksLikeBackslashIssue =
        /backslash|escape|\\/.test(parseError) || g.includes('\\');
      const baseHint = [
        'Hint: JSON parse failed. Common causes inside R++ string-token values:',
        '  - Unescaped backslashes in paths or regex needles (use \\\\ inside JSON strings).',
        '  - Unquoted keys (every JSON key needs surrounding double quotes).',
        '  - Stray trailing comma after the last entry.',
        '  - Truncated / unbalanced braces or quotes.',
        'The flat-key form has a smaller escaping surface — try gate_type + gate_args_json.',
      ];
      if (looksLikeBackslashIssue) {
        baseHint.push(
          'In particular: if your path or needle contains backslashes, double them (\\\\) ' +
            'inside JSON strings — that is the most common cause of this parse failure.',
        );
      }
      return baseHint.join('\n');
    }
    return [
      'Hint: gate arrived as a string. R++ TOKENS may have flattened a nested object,',
      'or the JSON-string form was malformed. Use the RECOMMENDED flat-key form above.',
    ].join('\n');
  }
  if (g && typeof g === 'object' && !Array.isArray(g)) {
    const type = (g as { type?: unknown }).type;
    if (typeof type === 'string' && !isRegisteredHookName(type)) {
      return [
        `Hint: gate.type=${JSON.stringify(type)} is not a registered hook name.`,
        'Pick one from the valid list above.',
      ].join('\n');
    }
    if (type === undefined) {
      return 'Hint: gate object is missing the required `type` key.';
    }
  }
  if (typeof input.gate_type === 'string' && !isRegisteredHookName(input.gate_type)) {
    return [
      `Hint: gate_type=${JSON.stringify(input.gate_type)} is not a registered hook name.`,
      'Pick one from the valid list above.',
    ].join('\n');
  }
  return 'Hint: provide gate via the RECOMMENDED flat-key form above for the smallest escaping surface.';
}

/* ============================== self-description ============================== */

function buildDescription(): string {
  // Lead with the flat-key form (the R++-native, lowest-escaping shape).
  // The single-line dense TypeScript signature is gone; this description is
  // the architect's first-line reference at action-selection time and must
  // carry the shapes that actually work in R++ TOKENS.
  const types = REGISTERED_HOOK_NAMES.join(' | ');
  return (
    'Append a new gated item to one of your OPEN jobs. Use it to break a step into sub-steps, ' +
    'or to add work the plan missed. Append-only — it cannot edit or remove existing items. ' +
    'Required scalars: { jobId: string (from the open tasks list), description: string }. ' +
    'Optional scalars: { blockedBy?: string (id of an item that must pass first), why?: string }. ' +
    'GATE — provide via the RECOMMENDED flat-key form (smallest escaping surface): ' +
    `gate_type: <one of ${types}>, gate_args_json?: '<JSON-stringified args>' ` +
    "(omit gate_args_json for step_acknowledged / always_pass / always_fail). " +
    "Alternative: gate as a JSON-stringified object, e.g. gate: '{\"type\":\"file_exists\",\"args\":{\"path\":\"/abs/x\"}}'. " +
    'DO NOT write gate as a nested R++ object (e.g. gate: { type: "..." }) — R++ TOKENS has no native ' +
    'nested-object syntax and silently flattens nested values to a string, which the validator rejects.'
  );
}
