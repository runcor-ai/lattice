import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Per-lattice workspace write-root. Item 4's plan gate stats an absolute
 * path under here; the lattice's auto-provisioned `workspace` fs-write
 * action is jailed to the SAME root, so what the lattice writes is what
 * the gate checks. Derived deterministically from the lattice's SQLite
 * path so the bridge route and the supervisor agree without extra state.
 *
 *   <dataDir>/<id>.sqlite        → entity DB
 *   <dataDir>/<id>/              → workspace write-root
 */
export function ensureWorkspaceRoot(sqlitePath: string, latticeId: string): string {
  const base = sqlitePath === ':memory:' || sqlitePath === '' ? process.cwd() : dirname(sqlitePath);
  const root = join(base, latticeId);
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}
