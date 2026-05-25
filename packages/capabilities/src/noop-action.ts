import type { ActContext, Capability, PermissionContext, PermissionResult } from './types.js';

/**
 * NoopAction — the minimum viable action. Does nothing observable;
 * returns void. Used by slice 1+ tests to prove the act phase
 * invokes at most one capability per cycle (spec FR-004).
 */
export interface NoopInput {
  readonly note?: string;
}

export function makeNoopAction(): Capability<NoopInput, void> {
  return {
    name: 'noop',
    description: 'An action with no side effect. Test placeholder.',
    role: { sense: false, action: true },
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
    isEnabled: () => true,
    canInvoke: (_ctx: PermissionContext): PermissionResult => ({ allow: true }),
    async invoke(_input: NoopInput, _ctx: ActContext): Promise<void> {
      // intentionally empty
    },
  };
}
