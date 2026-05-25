import { claimLock, type Lock } from '@runcor/runtime';

/**
 * Slow-clock lockfile — separate from the fast-clock lock
 * (research.md §3.4).
 *
 * Two different concurrency invariants:
 *   - fast-clock lock at `<sqlite-path>.lock`        — "one Lattice on this file"
 *   - slow-clock lock at `<sqlite-path>.slowclock.lock` — "one slow-clock pass at a time"
 *
 * They don't interfere: the slow clock can run when the fast clock is
 * stopped, and vice versa. Both processes share the SAME SQLite file
 * via WAL mode.
 */

export function slowclockLockPath(sqlitePath: string): string {
  return `${sqlitePath}.slowclock.lock`;
}

export function claimSlowclockLock(sqlitePath: string): Lock {
  return claimLock(slowclockLockPath(sqlitePath));
}
