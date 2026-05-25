import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { SnapshotDestination } from './types.js';

/**
 * restoreIfNeeded — on lattice startup, if the local SQLite file is
 * missing but a snapshot exists at the destination, copy the most
 * recent snapshot to the local path BEFORE the runtime opens it.
 *
 * Spec FR-009. Returns the key restored, or null if no restore.
 */
export async function restoreIfNeeded(
  localPath: string,
  destination: SnapshotDestination,
): Promise<string | null> {
  if (existsSync(localPath)) return null;
  const all = await destination.list();
  if (all.length === 0) return null;
  const newest = all[all.length - 1]!;

  const dir = dirname(localPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const got = await destination.get(newest.key, localPath);
  if (!got) return null;
  return newest.key;
}
