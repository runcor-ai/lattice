/**
 * Capability contract — the rich tool shape (intent §15; spec
 * FR-041..043; constitution Principle XI).
 *
 * Every capability declares:
 *   - role (sense / action / both)
 *   - readOnly      : true ⇒ no side effect outside the lattice
 *   - destructive   : true ⇒ irreversible side effect (e.g. delete)
 *   - concurrencySafe: true ⇒ safe to call in parallel with itself
 *   - isEnabled()   : runtime-toggleable; substrate may flip
 *   - canInvoke(ctx): permission hook the substrate calls in `act`
 *
 * Plus the channels:
 *   - read?  : sense channel — invoked automatically in `observe`
 *   - invoke?: action channel — at most ONE per cycle in `act`
 */

export interface CapabilityRole {
  readonly sense: boolean;
  readonly action: boolean;
}

export interface ObserveContext {
  readonly cycle: number;
  readonly lastReadAtMs: number | null;
  readonly abortSignal: AbortSignal;
}

export interface ActContext extends ObserveContext {
  /** Budget remaining at the moment of invocation (used by the substrate gate). */
  readonly budgetRemaining: number;
  readonly autonomy: 'low' | 'medium' | 'high';
}

export interface PermissionContext {
  readonly cycle: number;
  readonly autonomy: 'low' | 'medium' | 'high';
  readonly budgetRemaining: number;
}

export type PermissionResult =
  | { allow: true }
  | { allow: false; reason: string; escalate: boolean };

export interface Capability<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly role: CapabilityRole;
  /** Whether this capability is currently enabled. */
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly concurrencySafe: boolean;
  /** Returns true when the capability may run (substrate may flip). */
  isEnabled(): boolean;
  /** Permission hook — called by the substrate's gate before action invocation. */
  canInvoke(ctx: PermissionContext): PermissionResult;
  /** Sense channel — required when role.sense is true. */
  read?(ctx: ObserveContext): Promise<O>;
  /** Action channel — required when role.action is true. */
  invoke?(input: I, ctx: ActContext): Promise<O>;
  /** Cleanup on cycle abort. */
  onAbort?(): void;
}

/* --------------------------- Perception types --------------------------- */

export interface SenseReading {
  readonly capability: string;
  readonly result: 'ok' | 'failed' | 'stale';
  readonly data: unknown;
  readonly failed_reason?: string;
  readonly last_fresh_at_ms: number;
}

export interface PerceptionSnapshot {
  readonly cycle: number;
  readonly at_ms: number;
  readonly senses: Record<string, SenseReading>;
  /** Plan-item IDs whose unblock condition is met. Wired in slice 9. */
  readonly unblocked_items: readonly string[];
}

/* --------------------------- Capability validation --------------------------- */

export interface ValidationOk {
  readonly ok: true;
}
export interface ValidationFail {
  readonly ok: false;
  readonly reason: string;
}
export type Validation = ValidationOk | ValidationFail;

/**
 * Validates the capability's shape at registration time. Catches the
 * invalid combos slice 10 contract-test asserts (T194):
 *   - role.sense + role.action = 0 → rejected
 *   - sense-only capability with destructive: true → rejected
 *   - sense-only capability with readOnly: false → rejected
 *   - role.sense=true but no read() → rejected
 *   - role.action=true but no invoke() → rejected
 */
export function validateCapability<I, O>(cap: Capability<I, O>): Validation {
  if (!cap.role.sense && !cap.role.action) {
    return { ok: false, reason: `${cap.name}: role.sense and role.action both false` };
  }
  if (cap.role.sense && !cap.role.action && cap.destructive) {
    return {
      ok: false,
      reason: `${cap.name}: sense-only capability cannot be destructive`,
    };
  }
  if (cap.role.sense && !cap.role.action && !cap.readOnly) {
    return {
      ok: false,
      reason: `${cap.name}: sense-only capability MUST be readOnly: true`,
    };
  }
  if (cap.role.sense && typeof cap.read !== 'function') {
    return { ok: false, reason: `${cap.name}: role.sense=true requires read()` };
  }
  if (cap.role.action && typeof cap.invoke !== 'function') {
    return { ok: false, reason: `${cap.name}: role.action=true requires invoke()` };
  }
  return { ok: true };
}
