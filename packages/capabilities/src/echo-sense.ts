import type { Capability, ObserveContext, PermissionContext, PermissionResult } from './types.js';

/**
 * EchoSense — the minimum viable sense. Returns the current Date.now().
 * Used by slice 1+ tests to prove perception reads something each cycle.
 */
export interface EchoReading {
  readonly readAtMs: number;
}

export function makeEchoSense(): Capability<never, EchoReading> {
  return {
    name: 'echo',
    description: 'A trivial sense that returns the current wall-clock time at read.',
    role: { sense: true, action: false },
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
    isEnabled: () => true,
    canInvoke: (_ctx: PermissionContext): PermissionResult => ({ allow: true }),
    async read(_ctx: ObserveContext): Promise<EchoReading> {
      return { readAtMs: Date.now() };
    },
  };
}
