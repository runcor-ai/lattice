/**
 * Registered completion-check hook names — the single source of truth for
 * `gate.type` values across the lattice.
 *
 * Lives in @runcor/capabilities (not @runcor/jobs) because the validator
 * for `append-plan-item` (here) needs the list to produce self-correcting
 * error messages. @runcor/jobs already depends on @runcor/capabilities
 * (for runShellCommand); adding the reverse direction would be circular.
 *
 * @runcor/jobs imports this and runs a guard test at construction that
 * asserts every name registered with its CheckRegistry is in this list,
 * and vice versa — drift between the two is impossible.
 *
 * To add a new hook:
 *   1. Add the name here.
 *   2. Add the `.register('<name>', …)` call in @runcor/jobs/completion-check.
 *   The guard test in @runcor/jobs catches a missing half on next run.
 */
export const REGISTERED_HOOK_NAMES = [
  'always_pass',
  'always_fail',
  'description_contains',
  'file_exists',
  'content_contains',
  'step_acknowledged',
  'command_exits_zero',
  'http_status_is',
  'operator_attested',
] as const;

export type RegisteredHookName = (typeof REGISTERED_HOOK_NAMES)[number];

/** Is `name` a registered hook name? */
export function isRegisteredHookName(name: unknown): name is RegisteredHookName {
  return (
    typeof name === 'string' &&
    (REGISTERED_HOOK_NAMES as readonly string[]).includes(name)
  );
}
